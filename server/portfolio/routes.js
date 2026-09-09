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

import { sendJson, readJsonBody, readBinaryBody, rejectCrossSite } from '../core/respond.js';
import { rateLimited } from '../core/ratelimit.js';
import { parseSignal } from './signal.js';
import { suggestQuantity, defaultStop, tradePlan } from './positions.js';
import * as store from './store.js';
import { buildDashboard, earningsWatch, quotesFor } from './service.js';
import { createTracker } from '../core/http.js';
import { normalizeTicker } from '../core/parse.js';
import { saveImage, readImage, deleteImages, imageExists, isImageId, MAX_BYTES } from './images.js';

const PREFIX = '/api/trades';
const IMAGES = '/api/images';

function badRequest(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Une position ne peut référencer qu'une capture réellement présente sur le
 * disque : sans ce contrôle, un identifiant inventé produirait une vignette
 * cassée que plus rien ne viendrait expliquer.
 */
async function assertImagesExist(ids) {
  for (const id of ids ?? []) {
    if (!isImageId(id) || !(await imageExists(id))) {
      throw badRequest('Capture introuvable : renvoyez-la depuis le formulaire.');
    }
  }
}

/** Efface les captures de positions supprimées : rien ne les réclamera plus. */
async function forgetImages(trades) {
  const ids = trades.flatMap((trade) => trade.attachments || []);
  if (ids.length) await deleteImages(ids);
}

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
  if (action === 'delete') {
    const { deleted, removed } = await store.deleteTrades(ids);
    await forgetImages(removed);
    return { action, deleted };
  }

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

  if (action === 'protect') {
    const percent = Number(body.percent) || settings.stopPercent;
    return {
      action,
      ...(await store.patchMany(ids, (trade) => {
        if (trade.status === 'closed') throw badRequest('déjà soldée');
        if (trade.stop !== null) throw badRequest('un stop est déjà posé');

        const stop = defaultStop({ entry: trade.entry, side: trade.side, percent });
        if (stop === null) throw badRequest('stop incalculable');
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
  const mine =
    path === PREFIX ||
    path.startsWith(`${PREFIX}/`) ||
    path === IMAGES ||
    path.startsWith(`${IMAGES}/`) ||
    path === '/api/settings';
  if (!mine) return false;

  const ip = req.socket.remoteAddress || 'inconnu';

  try {
    // Servir une capture, c'est lire un fichier local : cela n'a pas à
    // consommer le quota destiné à protéger les sources externes.
    if (req.method === 'GET' && path.startsWith(`${IMAGES}/`)) {
      const image = await readImage(path.slice(IMAGES.length + 1));
      if (!image) throw badRequest('Capture introuvable.', 404);

      res.writeHead(200, {
        'Content-Type': image.type,
        'Content-Length': image.buffer.length,
        // L'identifiant est unique et le contenu ne change jamais.
        'Cache-Control': 'private, max-age=31536000, immutable',
        // Le type vient des octets, pas du nom : interdire au navigateur de
        // deviner autre chose ferme la porte à un fichier déguisé.
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      });
      res.end(image.buffer);
      return true;
    }
    // Le tableau de bord interroge une cotation par ligne ouverte ; il se
    // rafraîchit tout seul. Le quota est plus large que celui de l'analyse,
    // mais il existe.
    if (rateLimited(`portefeuille:${ip}`, { max: 90 })) {
      throw badRequest('Trop de requêtes sur le portefeuille. Patientez une minute.', 429);
    }

    if (req.method !== 'GET') {
      // L'envoi d'une capture est le seul point d'entrée binaire.
      const accept = path === IMAGES ? 'image/' : 'application/json';
      const refusal = rejectCrossSite(req, { accept });
      if (refusal) throw badRequest(refusal.error, refusal.status);
    }

    if (req.method === 'POST' && path === IMAGES) {
      const image = await saveImage(await readBinaryBody(req, MAX_BYTES));
      sendJson(res, 201, { image });
      return true;
    }

    /* --- Lecture --- */

    if (req.method === 'GET' && path === PREFIX) {
      sendJson(res, 200, await buildDashboard());
      return true;
    }

    // Cotation d'un titre qui n'est pas encore au portefeuille. Beaucoup de
    // posts ne chiffrent aucune entrée -- « arrêtez de faire les rats sur le
    // prix d'entrée » -- et la seule réponse honnête est le prix du marché.
    if (req.method === 'GET' && path === `${PREFIX}/quote`) {
      const ticker = normalizeTicker(url.searchParams.get('ticker'));
      if (!ticker) throw badRequest('Ticker invalide.');

      const quote = (await quotesFor([ticker], createTracker())).get(ticker);
      if (!quote) throw badRequest(`Aucune cotation pour ${ticker}.`, 404);

      sendJson(res, 200, { quote });
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

      // Le post ne donne pas de stop dans la plupart des cas : on applique la
      // règle de sortie de l'utilisateur, en disant que c'est elle qui parle et
      // non le signal.
      const fallback = defaultStop({ entry: signal.entry, side: signal.side, percent: settings.stopPercent });
      const stop = signal.stop ?? fallback;

      sendJson(res, 200, {
        signal,
        suggestion: {
          capital: settings.capital,
          riskPerTradePct: settings.riskPerTradePct,
          stop,
          stopFromSignal: signal.stop !== null,
          stopPercent: settings.stopPercent,
          quantity: suggestQuantity({
            capital: settings.capital,
            riskPercent: settings.riskPerTradePct,
            entry: signal.entry,
            stop,
            side: signal.side,
          }),
          plan: tradePlan({
            entry: signal.entry,
            stop,
            target: signal.targets[0] ?? null,
            side: signal.side,
            settings,
          }),
        },
      });
      return true;
    }

    // Plan de taille recalculé à la volée pendant la saisie : le formulaire
    // change d'entrée, de stop ou d'objectif sans rien enregistrer.
    if (req.method === 'GET' && path === `${PREFIX}/plan`) {
      const number = (name) => {
        const value = Number(url.searchParams.get(name));
        return Number.isFinite(value) && value > 0 ? value : null;
      };
      const { settings } = await store.read();
      const side = url.searchParams.get('side') === 'short' ? 'short' : 'long';
      const entry = number('entry');

      // Sans stop saisi, la règle de sortie s'applique : le plan renvoyé est
      // ainsi toujours celui d'une position dont la perte est bornée.
      const given = number('stop');
      const stop = given ?? defaultStop({ entry, side, percent: settings.stopPercent });

      sendJson(res, 200, {
        settings,
        stop,
        stopIsDefault: given === null && stop !== null,
        plan: tradePlan({ entry, stop, target: number('target'), side, settings }),
      });
      return true;
    }

    if (req.method === 'POST' && path === `${PREFIX}/batch`) {
      const result = await runBatch(await readJsonBody(req));
      sendJson(res, 200, { ...result, dashboard: await buildDashboard() });
      return true;
    }

    if (req.method === 'POST' && path === PREFIX) {
      const body = await readJsonBody(req);
      await assertImagesExist(body.attachments);
      const trade = await store.createTrade(body);
      sendJson(res, 201, { trade, dashboard: await buildDashboard() });
      return true;
    }

    if (path.startsWith(`${PREFIX}/`)) {
      const id = decodeURIComponent(path.slice(PREFIX.length + 1));

      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        await assertImagesExist(body.attachments);

        const before = (await store.read()).trades.find((t) => t.id === id);
        const trade = await store.updateTrade(id, body);

        // Une capture retirée de la position n'a plus de raison d'exister.
        const abandoned = (before?.attachments || []).filter((img) => !trade.attachments.includes(img));
        if (abandoned.length) await deleteImages(abandoned);

        sendJson(res, 200, { trade, dashboard: await buildDashboard() });
        return true;
      }

      if (req.method === 'DELETE') {
        const { deleted, removed } = await store.deleteTrades([id]);
        if (!deleted) throw badRequest('Position introuvable.', 404);
        await forgetImages(removed);
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
