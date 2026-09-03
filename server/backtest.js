/**
 * Harnais de backtest : le barème vaut-il quelque chose ?
 *
 * Les poids et les seuils du moteur de décision ont été posés à la main.
 * Tant qu'ils ne sont pas confrontés à des résultats réels, ce sont des
 * opinions présentées comme des chiffres. Ce module rejoue les publications
 * passées et mesure si le score annonce quoi que ce soit.
 *
 * **Absence de fuite d'information.** Pour chaque publication, on ne
 * reconstruit les faits qu'à partir des séances strictement antérieures à la
 * séance de réaction, et des seules publications antérieures. Une société qui
 * publie après clôture laisse connaître la séance du jour ; une société qui
 * publie avant ouverture ne laisse que la veille. C'est la règle qui décide
 * du point de coupure.
 *
 * **Périmètre honnête.** Deux facteurs seulement sont reconstituables :
 * les réactions passées et la configuration technique. Les révisions
 * d'estimations, le consensus, les positions vendeuses, l'actualité et
 * surtout le mouvement implicite n'ont pas d'historique gratuit -- on ne
 * peut pas savoir ce que le marché options pricait en 2023. Le score
 * mesuré ici ne porte donc que sur 27 des 100 points de pondération, et
 * aucune conclusion ne vaut pour les facteurs absents.
 */

import { computeIndicators } from './analysis/indicators.js';
import { analyzeEarningsReactions } from './analysis/earningsReaction.js';
import { buildVerdict } from './analysis/verdict.js';
import { mean, median, stdev, pearson, spearman, standardError, isNum } from './core/stats.js';

/** Séances minimales avant de juger une configuration technique. */
const MIN_SESSIONS = 60;
/** Publications antérieures minimales pour que le facteur historique ait un sens. */
const MIN_PRIOR_REPORTS = 3;

const dayKey = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

function sessionIndex(bars, date) {
  const target = dayKey(date);
  let found = -1;
  for (let i = 0; i < bars.length; i += 1) {
    if (dayKey(bars[i].date) <= target) found = i;
    else break;
  }
  return found;
}

/**
 * Reconstruit une observation par publication : le score qu'aurait rendu le
 * moteur la veille, et ce que le titre a réellement fait ensuite.
 *
 * @param {Array} bars    Bougies quotidiennes, ordre croissant.
 * @param {Array} reports Publications ({ reportedAt, timing }), ordre libre.
 * @param {number} entrySessions Séances d'avance pour l'entrée simulée.
 */
export function buildObservations(bars, reports, { entrySessions = 3 } = {}) {
  if (!bars?.length || !reports?.length) return [];

  const ordered = [...reports].sort((a, b) => a.reportedAt - b.reportedAt);
  const observations = [];

  for (let k = 0; k < ordered.length; k += 1) {
    const report = ordered[k];
    const i = sessionIndex(bars, report.reportedAt);
    if (i < 1) continue;

    // Séance qui porte la réaction : le lendemain si la publication tombe
    // après la clôture, le jour même sinon.
    const reactionIndex = report.timing === 'after-close' ? i + 1 : i;
    if (reactionIndex >= bars.length || reactionIndex < 1) continue;

    // Tout ce qui suit doit être connu avant l'ouverture de cette séance.
    const known = bars.slice(0, reactionIndex);
    if (known.length < MIN_SESSIONS) continue;

    const priorReports = ordered.slice(0, k);
    if (priorReports.length < MIN_PRIOR_REPORTS) continue;

    const indicators = computeIndicators(known);
    const reactions = analyzeEarningsReactions(known, priorReports, null);
    if (!indicators || !reactions) continue;

    const decision = buildVerdict({
      now: known.at(-1).date,
      quote: { price: known.at(-1).close },
      indicators,
      reactions,
      // Facteurs sans historique reconstituable : laissés absents, donc
      // écartés du score par leur confiance nulle.
      summary: null, surprises: [], forecast: null, ratings: null,
      shortInterest: null, institutional: null, options: null,
      sentiment: null, earningsDate: null, optionsWindowConflict: false,
    });

    const previous = bars[reactionIndex - 1].close;
    const reaction = bars[reactionIndex].close;
    const entryIndex = Math.max(0, reactionIndex - 1 - entrySessions);
    const entry = bars[entryIndex].close;

    observations.push({
      reportedAt: report.reportedAt.toISOString().slice(0, 10),
      reactionDate: bars[reactionIndex].date.toISOString().slice(0, 10),
      timing: report.timing || 'inconnu',
      score: decision.score,
      coverage: decision.coverage,
      priorCount: reactions.count,
      // Effet de l'événement seul.
      reactionPercent: ((reaction - previous) / previous) * 100,
      // Résultat d'une position ouverte quelques séances avant, gardée
      // jusqu'à la réaction : c'est le pari réellement décrit par le site.
      holdPercent: ((reaction - entry) / entry) * 100,
    });
  }

  return observations;
}

/** Découpe les observations en tranches de score de taille égale. */
function bucketize(observations, count) {
  const sorted = [...observations].sort((a, b) => a.score - b.score);
  const size = Math.floor(sorted.length / count);
  if (size < 2) return [];

  return Array.from({ length: count }, (_, b) => {
    const slice = b === count - 1 ? sorted.slice(b * size) : sorted.slice(b * size, (b + 1) * size);
    const outcomes = slice.map((o) => o.reactionPercent);
    const holds = slice.map((o) => o.holdPercent);
    return {
      bucket: b + 1,
      n: slice.length,
      scoreMin: slice[0]?.score ?? null,
      scoreMax: slice.at(-1)?.score ?? null,
      meanReaction: mean(outcomes),
      medianReaction: median(outcomes),
      positiveRate: outcomes.filter((x) => x > 0).length / slice.length,
      meanHold: mean(holds),
      standardError: standardError(outcomes),
    };
  });
}

/**
 * Agrège les observations et confronte le score au résultat.
 *
 * L'écart entre la tranche haute et la tranche basse est accompagné de son
 * erreur standard : sans elle, un écart de moyennes ne dit rien -- sur des
 * rendements aussi bruités, deux points d'écart peuvent n'être que du bruit.
 */
export function summarize(observations, { buckets = 5 } = {}) {
  if (!observations.length) return null;

  const scores = observations.map((o) => o.score);
  const reactions = observations.map((o) => o.reactionPercent);
  const holds = observations.map((o) => o.holdPercent);

  const tranches = bucketize(observations, buckets);
  const low = tranches[0];
  const high = tranches.at(-1);

  let spread = null;
  if (low && high) {
    const difference = high.meanReaction - low.meanReaction;
    // Erreur standard de la différence de deux moyennes indépendantes.
    const se = Math.sqrt((high.standardError ?? 0) ** 2 + (low.standardError ?? 0) ** 2);
    spread = {
      difference,
      standardError: se,
      // Au-delà de deux écarts-types, l'écart cesse d'être attribuable au hasard.
      tStat: se > 0 ? difference / se : null,
    };
  }

  return {
    n: observations.length,
    baseline: {
      meanReaction: mean(reactions),
      medianReaction: median(reactions),
      volatility: stdev(reactions),
      positiveRate: reactions.filter((x) => x > 0).length / reactions.length,
      meanHold: mean(holds),
      positiveHoldRate: holds.filter((x) => x > 0).length / holds.length,
    },
    correlation: {
      pearsonReaction: pearson(scores, reactions),
      spearmanReaction: spearman(scores, reactions),
      pearsonHold: pearson(scores, holds),
      spearmanHold: spearman(scores, holds),
    },
    scoreRange: {
      min: Math.min(...scores),
      max: Math.max(...scores),
      mean: mean(scores),
    },
    buckets: tranches,
    spread,
  };
}

/** Lecture en clair du résultat, sans enjoliver. */
export function interpret(summary) {
  if (!summary) return "Aucune observation exploitable : rien à conclure.";

  const { spread, correlation, n } = summary;
  const rho = correlation.spearmanReaction;
  const t = spread?.tStat;

  if (!isNum(t) || !isNum(rho)) return `Sur ${n} observations, les statistiques ne sont pas calculables.`;

  if (Math.abs(t) < 2) {
    return (
      `Sur ${n} publications, l'écart de réaction entre les scores les plus hauts et les plus bas ` +
      `est de ${spread.difference.toFixed(2)} point(s), pour une erreur standard de ` +
      `${spread.standardError.toFixed(2)} (t = ${t.toFixed(2)}). En deçà de |t| = 2, cet écart ne se ` +
      `distingue pas du hasard : le score, sur les facteurs testés, ne prédit pas la réaction. ` +
      `La conclusion utile n'est pas de le maquiller, c'est de ne pas lui faire dire ce qu'il ne dit pas.`
    );
  }

  return (
    `Sur ${n} publications, l'écart entre tranche haute et tranche basse atteint ` +
    `${spread.difference.toFixed(2)} point(s) (t = ${t.toFixed(2)}, rho de Spearman = ${rho.toFixed(3)}). ` +
    `L'écart dépasse le seuil du bruit, mais un backtest sur un seul échantillon historique ne vaut ` +
    `pas preuve : il faudrait le confirmer hors échantillon avant d'en tirer des poids.`
  );
}
