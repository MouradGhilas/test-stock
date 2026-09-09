/**
 * Assemblage du tableau de bord : le magasin fournit les lignes, Nasdaq les
 * prix, `positions.js` les chiffres.
 *
 * Une cotation qui manque ne fait pas échouer l'écran. Sur quinze lignes, il y
 * a toujours un ticker que la source refuse ; le reste du portefeuille doit
 * rester lisible, et la ligne concernée le dire franchement.
 */

import { CONFIG } from '../config.js';
import { createTracker } from '../core/http.js';
import { fetchQuote, fetchEarningsSurprises, fetchEarningsDate } from '../sources/nasdaq.js';
import { daysBetween, toISODate } from '../core/parse.js';
import { read } from './store.js';
import { enrich, summarize, traderScoreboard } from './positions.js';

/** Ordre de lecture : ce qui réclame une décision d'abord. */
const SEVERITY = { danger: 4, good: 3, warn: 2, info: 1 };

const worstAlert = (position) =>
  position.alerts.reduce((acc, a) => Math.max(acc, SEVERITY[a.level] || 0), 0);

const STATUS_ORDER = { open: 0, watch: 1, closed: 2 };

/** Cotations des tickers demandés. Les échecs sont absents de la table, pas fatals. */
export async function quotesFor(tickers, tracker) {
  const unique = [...new Set(tickers)];
  const quotes = new Map();

  await Promise.all(
    unique.map(async (ticker) => {
      try {
        const quote = await fetchQuote(ticker, tracker);
        if (quote && typeof quote.price === 'number') quotes.set(ticker, quote);
      } catch {
        // Ticker retiré de la cote, source en panne : la ligne s'affichera
        // sans valorisation, avec son alerte « cotation indisponible ».
      }
    }),
  );

  return quotes;
}

/** Le tableau de bord complet, prêt à sérialiser. */
export async function buildDashboard() {
  const tracker = createTracker();
  const { settings, trades } = await read();

  const live = trades.filter((t) => t.status !== 'closed').map((t) => t.ticker);
  const quotes = await quotesFor(live, tracker);
  const now = new Date();

  const positions = trades
    .map((trade) => enrich(trade, { price: quotes.get(trade.ticker)?.price ?? null, settings, now }))
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        worstAlert(b) - worstAlert(a) ||
        Math.abs(b.pnl ?? 0) - Math.abs(a.pnl ?? 0) ||
        String(b.closedAt ?? '').localeCompare(String(a.closedAt ?? '')),
    );

  return {
    generatedAt: now.toISOString(),
    settings,
    positions,
    summary: summarize(positions, { settings }),
    traders: traderScoreboard(positions),
    quotes: Object.fromEntries(
      [...quotes].map(([ticker, q]) => [
        ticker,
        { price: q.price, changePercent: q.changePercent, asOf: q.asOf, name: q.companyName },
      ]),
    ),
    sources: tracker.entries,
  };
}

/**
 * Prochaines publications de résultats sur les lignes ouvertes.
 *
 * C'est le risque que le copy trading fait oublier : un signal de swing pris
 * lundi peut traverser une publication trimestrielle jeudi, avec un décalage à
 * l'ouverture qu'aucun stop ne couvre. La collecte coûte deux requêtes par
 * ticker, elle est donc appelée à part, après l'affichage du tableau.
 */
export async function earningsWatch(tickers) {
  const tracker = createTracker();
  const unique = [...new Set(tickers)].slice(0, CONFIG.portfolio.maxEarningsWatch);
  const now = new Date();
  const watch = {};

  await Promise.all(
    unique.map(async (ticker) => {
      try {
        const surprises = await fetchEarningsSurprises(ticker, tracker).catch(() => []);
        const earnings = await fetchEarningsDate(ticker, tracker, surprises);
        if (!earnings?.date) return;

        const days = daysBetween(now, earnings.date);
        watch[ticker] = {
          date: toISODate(earnings.date),
          days,
          timing: earnings.timing || 'unknown',
          confidence: earnings.confidence || 'estimated',
          imminent: days !== null && days >= 0 && days <= CONFIG.portfolio.earningsWarningDays,
        };
      } catch {
        // La veille résultats est un bonus : son échec ne doit rien casser.
      }
    }),
  );

  return { watch, sources: tracker.entries };
}
