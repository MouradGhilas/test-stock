/**
 * Orchestrateur : collecte les sources, assemble les faits, produit le rapport.
 *
 * Aucune source n'est bloquante sauf la cotation, qui sert à valider le
 * ticker. Tout le reste est récupère en parallèle et dégradé proprement :
 * une source absente réduit la confiance du verdict, elle ne fait pas
 * échouer l'analyse.
 */

import { CONFIG } from './config.js';
import { createTracker } from './core/http.js';
import { normalizeTicker, daysBetween } from './core/parse.js';
import * as nasdaq from './sources/nasdaq.js';
import { fetchImpliedMove } from './sources/cboe.js';
import { fetchNews } from './sources/news.js';
import { fetchEarningsFilings } from './sources/edgar.js';
import { computeIndicators } from './analysis/indicators.js';
import { analyzeEarningsReactions } from './analysis/earningsReaction.js';
import { analyzeSentiment } from './analysis/sentiment.js';
import { analyzeAnticipation } from './analysis/anticipation.js';
import { appendSnapshot, readCycleSnapshots } from './core/store.js';
import { buildVerdict } from './analysis/verdict.js';

/**
 * Exécute une collecte optionnelle : renvoie null au lieu de propager l'erreur.
 * L'échec n'est tracé que s'il n'a pas déjà été enregistré au niveau HTTP,
 * pour ne pas afficher deux fois la même panne à l'utilisateur.
 */
async function optional(promise, label, tracker) {
  const before = tracker.entries.length;
  try {
    return await promise;
  } catch (error) {
    const alreadyLogged = tracker.entries.slice(before).some((entry) => !entry.ok);
    if (!alreadyLogged) tracker.note(label, error.status ?? 'ERR', error.message);
    return null;
  }
}

const isoDay = (date) => date.toISOString().slice(0, 10);

/**
 * Fusionne les deux vues de l'historique des publications.
 *
 * Les dépôts SEC donnent la date et l'horaire, sur plusieurs années. Le
 * fournisseur de marché donne le bénéfice publié et le consensus, mais sur
 * quatre trimestres seulement. On garde la couverture des premiers et on y
 * rattache, quand elles existent, les surprises des seconds.
 */
export function mergeEarningsHistory(filings, surprises) {
  const bySurpriseDate = new Map((surprises || []).map((s) => [isoDay(s.reportedAt), s]));

  if (filings?.length) {
    return filings.map((filing) => {
      const matched = bySurpriseDate.get(isoDay(filing.reportedAt));
      return {
        reportedAt: filing.reportedAt,
        timing: filing.timing,
        acceptedAt: filing.acceptedAt,
        fiscalQuarter: matched?.fiscalQuarter ?? null,
        eps: matched?.eps ?? null,
        consensus: matched?.consensus ?? null,
        surprisePercent: matched?.surprisePercent ?? null,
      };
    });
  }

  return (surprises || []).map((s) => ({ ...s, timing: null, acceptedAt: null }));
}

/** Horaire de dépôt majoritaire d'une société, ou null si aucun ne domine. */
export function dominantTiming(filings) {
  if (!filings?.length) return null;

  const tally = new Map();
  for (const f of filings) {
    if (f.timing) tally.set(f.timing, (tally.get(f.timing) || 0) + 1);
  }
  const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  // Une pratique doit être nettement majoritaire pour valoir prédiction.
  return best && best[1] / filings.length >= 0.7 ? best[0] : null;
}

/**
 * Vérifie la cohérence entre la date de publication retenue et la fenêtre
 * déduite de la structure par terme des options. Un désaccord signale une
 * date extrapolée fausse.
 */
function detectWindowConflict(earningsDate, options) {
  const window = options?.impliedWindow;
  if (!earningsDate || !window || earningsDate.confidence === 'confirmed') return false;

  const date = earningsDate.date.getTime();
  const tolerance = 86_400_000;
  return date < window.after.getTime() - tolerance || date > window.before.getTime() + tolerance;
}

export async function analyzeTicker(rawTicker) {
  const ticker = normalizeTicker(rawTicker);
  if (!ticker) {
    const error = new Error('Ticker invalide. Format attendu : 1 a 10 caracteres, lettres et chiffres.');
    error.status = 400;
    throw error;
  }

  const tracker = createTracker();
  const startedAt = Date.now();
  const now = new Date();

  // Étape 1 : la cotation valide l'existence du titre. C'est la seule source
  // bloquante : sans elle, il n'y a rien à analyser.
  let quote;
  try {
    quote = await nasdaq.fetchQuote(ticker, tracker);
  } catch (error) {
    // Le détail technique de la source n'intéresse pas l'utilisateur : on ne
    // remonte que ce qui l'aide à corriger sa saisie.
    const notFound = error.status === 404;
    throw Object.assign(
      new Error(
        notFound
          ? `Ticker « ${ticker} » inconnu sur les places couvertes (actions cotées aux États-Unis).`
          : `Impossible de récupérer la cotation de « ${ticker} » pour le moment. Reessayez dans un instant.`,
      ),
      { status: notFound ? 404 : 502 },
    );
  }

  if (!quote) {
    throw Object.assign(new Error(`Aucune donnée de marché pour « ${ticker} ».`), { status: 404 });
  }

  // Étape 2 : tout ce qui ne dépend de rien d'autre, en parallèle.
  const [summary, bars, surprises, forecast, ratings, shortInterest, institutional, news, filings] =
    await Promise.all([
      optional(nasdaq.fetchSummary(ticker, tracker), 'Fiche société', tracker),
      optional(nasdaq.fetchHistory(ticker, tracker), 'Historique de prix', tracker),
      optional(nasdaq.fetchEarningsSurprises(ticker, tracker), 'Surprises de résultats', tracker),
      optional(nasdaq.fetchEarningsForecast(ticker, tracker), 'Estimations analystes', tracker),
      optional(nasdaq.fetchRatings(ticker, tracker), 'Consensus analystes', tracker),
      optional(nasdaq.fetchShortInterest(ticker, tracker), 'Short interest', tracker),
      optional(nasdaq.fetchInstitutional(ticker, tracker), 'Actionnariat institutionnel', tracker),
      optional(fetchNews(ticker, tracker, quote.companyName), 'Actualités', tracker),
      optional(
        fetchEarningsFilings(ticker, tracker, CONFIG.analysis.earningsHistoryYears),
        'Dépôts de résultats SEC',
        tracker,
      ),
    ]);

  // Historique des publications : les dépôts SEC font foi (date et horaire
  // établis), les données de marché apportent le détail des surprises. À
  // défaut de dépôts, on retombe sur les quatre trimestres du fournisseur.
  const reports = mergeEarningsHistory(filings, surprises);

  // Étape 3 : la date de publication s'extrapole sur cet historique.
  const earningsDate = await optional(
    nasdaq.fetchEarningsDate(ticker, tracker, reports),
    'Date des résultats',
    tracker,
  );

  // Le fournisseur ignore souvent l'horaire de la prochaine publication. Une
  // société qui a déposé vingt fois de suite après clôture ne changera
  // vraisemblablement pas de pratique au trimestre suivant.
  const habitualTiming = dominantTiming(filings);
  if (earningsDate && earningsDate.timing === 'unknown' && habitualTiming) {
    earningsDate.timing = habitualTiming;
    earningsDate.timingSource = 'habitude de dépôt (SEC)';
  }

  // Étape 4 : la chaîne d'options se lit autour de cette date.
  const options = await optional(
    fetchImpliedMove(ticker, tracker, earningsDate?.date || null),
    "Chaîne d'options",
    tracker,
  );

  const indicators = bars ? computeIndicators(bars) : null;
  // L'horaire annonce pour la prochaîne publication sert d'indice pour situer
  // les séances de réaction passées.
  const reactions = bars && reports.length
    ? analyzeEarningsReactions(bars, reports, earningsDate?.timing ?? null)
    : null;
  const sentiment = news ? analyzeSentiment(news, now) : null;

  const earningsIso = earningsDate ? isoDay(earningsDate.date) : null;

  // Observations passées sur cette même échéance : c'est ce qui permet de dire
  // depuis combien de temps le marché price l'événement.
  const impliedHistory = await readCycleSnapshots(ticker, earningsIso);

  const facts = {
    ticker,
    now,
    impliedHistory,
    quote,
    summary,
    indicators,
    surprises,
    forecast,
    ratings,
    shortInterest,
    institutional,
    options,
    reactions,
    sentiment,
    earningsDate,
    optionsWindowConflict: detectWindowConflict(earningsDate, options),
  };

  const decision = buildVerdict(facts);
  const anticipation = analyzeAnticipation(facts);

  // Trace de l'observation courante, pour les consultations suivantes.
  if (earningsIso && options?.impliedMovePercent) {
    await appendSnapshot(ticker, {
      earningsDate: earningsIso,
      price: quote.price,
      impliedMovePercent: options.impliedMovePercent,
      atmImpliedVol: options.atmImpliedVol,
      iv30: options.iv30,
      method: options.method,
    });
  }

  return {
    ticker,
    generatedAt: now.toISOString(),
    elapsedMs: Date.now() - startedAt,
    identity: {
      symbol: quote.symbol,
      name: quote.companyName,
      exchange: quote.exchange,
      sector: summary?.sector || null,
      industry: summary?.industry || null,
    },
    market: {
      price: quote.price,
      change: quote.change,
      changePercent: quote.changePercent,
      volume: quote.volume,
      averageVolume: summary?.averageVolume ?? null,
      marketCap: summary?.marketCap ?? null,
      fiftyTwoWeekHigh: summary?.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: summary?.fiftyTwoWeekLow ?? null,
      oneYearTarget: summary?.oneYearTarget ?? null,
      asOf: quote.asOf,
    },
    earnings: earningsDate
      ? {
          date: earningsDate.date.toISOString().slice(0, 10),
          timing: earningsDate.timing,
          confidence: earningsDate.confidence,
          source: earningsDate.source,
          basis: earningsDate.basis || null,
          timingSource: earningsDate.timingSource || null,
          consensusEps: earningsDate.consensusEps ?? forecast?.quarterly?.[0]?.consensus ?? null,
          fiscalQuarter: earningsDate.fiscalQuarter || forecast?.quarterly?.[0]?.period || null,
          daysAway: daysBetween(now, earningsDate.date),
          windowConflict: facts.optionsWindowConflict,
        }
      : null,
    options: options
      ? {
          impliedMovePercent: options.impliedMovePercent,
          straddleMovePercent: options.straddleMovePercent,
          method: options.method,
          expiry: options.expiry.toISOString().slice(0, 10),
          referenceExpiry: options.referenceExpiry?.toISOString().slice(0, 10) ?? null,
          daysAfterEarnings: options.daysAfterEarnings,
          atmStrike: options.atmStrike,
          atmImpliedVol: options.atmImpliedVol,
          iv30: options.iv30,
          putCallOpenInterest: options.putCallOpenInterest,
          skew: options.skew,
          impliedWindow: options.impliedWindow
            ? {
                after: options.impliedWindow.after.toISOString().slice(0, 10),
                before: options.impliedWindow.before.toISOString().slice(0, 10),
                ivJumpPoints: options.impliedWindow.ivJumpPoints,
              }
            : null,
        }
      : null,
    history: reactions
      ? {
          count: reactions.count,
          medianAbsMove: reactions.medianAbsMove,
          medianMove: reactions.medianMove,
          positiveRate: reactions.positiveRate,
          maxAbsMove: reactions.maxAbsMove,
          worstDrop: reactions.worstDrop,
          medianRunUp: reactions.medianRunUp,
          timing: reactions.timing,
          timingResolution: reactions.timingResolution,
          timingFromFilings: reactions.timingFromFilings,
          yearsCovered: CONFIG.analysis.earningsHistoryYears,
          events: reactions.events.map((e) => ({
            reportedAt: e.reportedAt.toISOString().slice(0, 10),
            reactionDate: e.reactionDate.toISOString().slice(0, 10),
            reactionPercent: e.reactionPercent,
            candidates: e.candidates,
            runUpPercent: e.runUpPercent,
            surprisePercent: e.surprisePercent,
          })),
        }
      : null,
    indicators,
    news: sentiment
      ? {
          overall: sentiment.overall,
          counts: sentiment.counts,
          articles: sentiment.articles.slice(0, 20).map((a) => ({
            title: a.title,
            source: a.source,
            link: a.link,
            publishedAt: a.publishedAt ? a.publishedAt.toISOString() : null,
            sentiment: a.sentiment,
            terms: a.matches.map((m) => m.term),
          })),
        }
      : null,
    priceSeries: (bars || []).slice(-CONFIG.analysis.chartSessions).map((b) => ({
      date: b.date.toISOString().slice(0, 10),
      close: b.close,
    })),
    decision,
    anticipation,
    sources: tracker.entries,
    config: {
      weights: CONFIG.analysis.weights,
      thresholds: CONFIG.analysis.thresholds,
      // Ce que vaut le barème, mesuré : voir docs/backtest.md.
      calibration: CONFIG.analysis.calibration,
    },
  };
}
