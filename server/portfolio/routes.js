/**
 * Routes du suivi de positions.
 *
 * Séparées de `server/index.js` pour que l'entrée du serveur reste lisible :
 * ici vivent les seules routes qui écrivent quelque chose.
 *
 * Toute mutation répond avec le tableau de bord recalculé. L'interface n'a
 * ainsi jamais à recoller elle-même l'état d'après : ce qu'elle affiche vient
 * toujours du serveur, y compris après une action groupée partiellement
 * appliquée.
 */

import { sendJson, readJsonBody, rejectCrossSite } from '../core/respond.js';
import { rateLimited } from '../core/ratelimit.js';
import { parseSignal } from './signal.js';
import { suggestQuantity } from './positions.js';
import * as store from './store.js';
import { buildDashboard, earningsWatch, quotesFor } from './service.js';
import { createTracker } from '../core/http.js';

const PREFIX = '/api/trades';

function badRequest(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const round2 = (value) => Math.round(value * 100) / 100;

/* ------------------------------------------------------------------ */
/* Actions groupées                                                    */
/* ------------------------------------------------------------------ */

/**
 * Le cœur de l'outil : la même décision appliquée à plusieurs lignes.
 *
 * Chaque action est refusée ligne par ligne plutôt que globalement -- solder
 * huit positions sur dix et dire lesquelles ont résisté vaut mieux que tout
 * annuler parce qu'une cotation manquait.
 */
async function runBatch(body) {
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : [];
  if (!ids.length) throw badRequest('Aucune position sélectionnée.');

  const action = String(body.action || '');
  if (action === 'delete') return { action, ...(await store.deleteTrades(ids)) };

  const { settings, trades } = await store.read();
  const selected = trades.filter((t) => ids.includes(t.id));
  if (!selected.length) throw badRequest('Aucune des positions sélectionnées n existe.');

  // Les trois actions qui suivent ont besoin du prix de marché.
  const needPrice = ['close', 'trail', 'take'].includes(action);
  const quotes = needPrice
    ? await quotesFor(selected.map((t) => t.ticker), createTracker())
    : new Map();

  const priceOf = (trade) => {
    const forced = Number(body.price);
    if (Number.isFinite(forced) && forced > 0) return forced;
    return quotes.get(trade.ticker)?.price ?? null;
  };

  if (action === 'close') {
    return {
      action,
      ...(await store.patchMany(ids, (trade) => {
        if (trade.status === 'closed') throw badRequest('déjà soldée');
        const price = priceOf(trade);
        if (price === null) throw badRequest('cotation indisponible');
        if (trade.quantity === null) throw badRequest('quantité inconnue');
        return { status: 'closed', exit: price };
      })),
    };
  }

  if (action === 'breakeven') {
    return {
      action,
      ...(await store.patchMany(ids, (trade) => {
        if (trade.status !== 'open') throw badRequest('position non ouverte');
        if (trade.stop === trade.entry) throw badRequest('stop déjà à l équilibre');
        return { stop: trade.entry };
      })),
    };
  }

  if (action === 'trail') {
    const percent = Number(body.percent);
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 50) {
      throw badRequest('Distance du stop suiveur : pourcentage entre 0 et 50 attendu.');
    }
    return {
      action,
      ...(await store.patchMany(ids, (trade) => {
        if (trade.status !== 'open') throw badRequest('position non ouverte');
        const price = priceOf(trade);
        if (price === null) throw badRequest('cotation indisponible');

        const direction = trade.side === 'short' ? -1 : 1;
        const stop = round2(price * (1 - (percent / 100) * direction));
        // Un stop suiveur ne recule jamais : il ne se déplace que du côté qui
        // réduit le risque. Sinon, « suivre » reviendrait à desserrer le stop
        // à chaque baisse.
        if (trade.stop !== null && (stop - trade.stop) * direction <= 0) {
          throw badRequest('le stop actuel est déjà plus serré');
        }
        if ((price - stop) * direction <= 0) throw badRequest('le stop tomberait du mauvais côté du prix');
        return { stop };
      })),
    };
  }

  if (action === 'take') {
    return {
      action,
      ...(await store.patchMany(ids, (trade) => {
        if (trade.status !== 'watch') throw badRequest('position déjà prise');
        const price = priceOf(trade);
        if (price === null) throw badRequest('cotation indisponible');

        // Prendre un signal en retard n'a de sens que si le prix n'a pas déjà
        // parcouru le trajet. Passé le premier objectif, il ne reste que le
        // risque ; sous le stop, la thèse du signal est morte.
        const direction = trade.side === 'short' ? -1 : 1;
        const firstTarget = trade.targets[0] ?? null;
        if (firstTarget !== null && (firstTarget - price) * direction <= 0) {
          throw badRequest('le prix a déjà dépassé le premier objectif du signal');
        }
        if (trade.stop !== null && (price - trade.stop) * direction <= 0) {
          throw badRequest('le prix est déjà au-delà du stop du signal');
        }

        // On entre au prix du marché, pas à celui du signal : c'est le prix
        // qu'on paiera réellement, et il change tout le rapport gain/risque.
        const quantity =
          trade.quantity ??
          suggestQuantity({
            capital: settings.capital,
            riskPercent: settings.riskPerTradePct,
            entry: price,
            stop: trade.stop,
            side: trade.side,
          });
        if (quantity === null) throw badRequest('taille impossible à calculer sans stop');
        return { status: 'open', entry: price, quantity, openedAt: new Date().toISOString() };
      })),
    };
  }

  throw badRequest(`Action groupée inconnue : ${action}.`);
}

/* ------------------------------------------------------------------ */
/* Routage                                                             */
/* ------------------------------------------------------------------ */

/**
 * Traite les routes du portefeuille.
 * @returns {Promise<boolean>} vrai si la requête a été prise en charge.
 */
export async function handlePortfolioRoute(req, res, url) {
  const path = url.pathname;
  const mine = path === PREFIX || path.startsWith(`${PREFIX}/`) || path === '/api/settings';
  if (!mine) return false;

  const ip = req.socket.remoteAddress || 'inconnu';

  try {
    // Le tableau de bord interroge une cotation par ligne ouverte ; il se
    // rafraîchit tout seul. Le quota est plus large que celui de l'analyse,
    // mais il existe.
    if (rateLimited(`portefeuille:${ip}`, { max: 90 })) {
      throw badRequest('Trop de requêtes sur le portefeuille. Patientez une minute.', 429);
    }

    if (req.method !== 'GET') {
      const refusal = rejectCrossSite(req);
      if (refusal) throw badRequest(refusal.error, refusal.status);
    }

    /* --- Lecture --- */

    if (req.method === 'GET' && path === PREFIX) {
      sendJson(res, 200, await buildDashboard());
      return true;
    }

    if (req.method === 'GET' && path === `${PREFIX}/earnings`) {
      const { trades } = await store.read();
      const tickers = trades.filter((t) => t.status !== 'closed').map((t) => t.ticker);
      sendJson(res, 200, await earningsWatch(tickers));
      return true;
    }

    /* --- Écriture --- */

    if (req.method === 'POST' && path === `${PREFIX}/parse`) {
      const body = await readJsonBody(req);
      const signal = parseSignal(body.text);
      const { settings } = await store.read();
      sendJson(res, 200, {
        signal,
        suggestion: {
          capital: settings.capital,
          riskPerTradePct: settings.riskPerTradePct,
          quantity: suggestQuantity({
            capital: settings.capital,
            riskPercent: settings.riskPerTradePct,
            entry: signal.entry,
            stop: signal.stop,
            side: signal.side,
          }),
        },
      });
      return true;
    }

    if (req.method === 'POST' && path === `${PREFIX}/batch`) {
      const result = await runBatch(await readJsonBody(req));
      sendJson(res, 200, { ...result, dashboard: await buildDashboard() });
      return true;
    }

    if (req.method === 'POST' && path === PREFIX) {
      const trade = await store.createTrade(await readJsonBody(req));
      sendJson(res, 201, { trade, dashboard: await buildDashboard() });
      return true;
    }

    if (path.startsWith(`${PREFIX}/`)) {
      const id = decodeURIComponent(path.slice(PREFIX.length + 1));

      if (req.method === 'PATCH') {
        const trade = await store.updateTrade(id, await readJsonBody(req));
        sendJson(res, 200, { trade, dashboard: await buildDashboard() });
        return true;
      }

      if (req.method === 'DELETE') {
        const { deleted } = await store.deleteTrades([id]);
        if (!deleted) throw badRequest('Position introuvable.', 404);
        sendJson(res, 200, { deleted, dashboard: await buildDashboard() });
        return true;
      }
    }

    if (req.method === 'PATCH' && path === '/api/settings') {
      const settings = await store.updateSettings(await readJsonBody(req));
      sendJson(res, 200, { settings, dashboard: await buildDashboard() });
      return true;
    }

    throw badRequest('Route inconnue sur le portefeuille.', 404);
  } catch (error) {
    const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status >= 500) console.error('[portefeuille]', error);
    sendJson(res, status, { error: error.message });
    return true;
  }
}
