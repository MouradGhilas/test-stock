/**
 * Analyse de tonalité des titres de presse, par lexique pondéré.
 *
 * Approche volontairement transparente plutot qu'opaque : chaque titre recoit
 * un score explicable par les mots qui l'ont declenche, et ces mots sont
 * renvoyés à l'interface. Un score de tonalité qu'on ne peut pas auditer n'a
 * aucune valeur pour prendre une décision.
 *
 * Le lexique est orienté finance : "beat", "miss", "downgrade" ou "guidance"
 * pesent bien plus que le vocabulaire positif générique.
 */

import { clamp, isNum } from '../core/stats.js';

/** Poids 2 = signal fort et spécifique, poids 1 = signal de contexte. */
const LEXICON = {
  // --- positif ---
  beat: 2, beats: 2, tops: 2, topped: 2, exceeds: 2, exceeded: 2, upgrade: 2, upgraded: 2,
  upgrades: 2, outperform: 2, surge: 2, surges: 2, surged: 2, soar: 2,
  soars: 2, soared: 2, rally: 2, rallies: 2, jumps: 2, jumped: 2, record: 2, breakthrough: 2,
  raises: 2, raised: 2, hikes: 1, boost: 1, boosts: 1, boosted: 1, strong: 1, growth: 1,
  profit: 1, profits: 1, gain: 1, gains: 1, bullish: 2, buyback: 2, dividend: 1, wins: 1,
  win: 1, approval: 1, approved: 1, expansion: 1, momentum: 1, optimistic: 1, rises: 1,
  rose: 1, climbs: 1, higher: 1, rebound: 1, recovery: 1, demand: 1, partnership: 1,
  hausse: 1, bondit: 2, records: 1, solide: 1, croissance: 1, benefice: 1, surperforme: 2,
  // --- negatif ---
  miss: -2, misses: -2, missed: -2, downgrade: -2, downgraded: -2, downgrades: -2,
  underperform: -2, plunge: -2, plunges: -2, plunged: -2, slump: -2, slumps: -2,
  tumble: -2, tumbles: -2, tumbled: -2, sinks: -2, sank: -2, crash: -2, crashes: -2,
  plummet: -2, plummets: -2, lawsuit: -2, lawsuits: -2, probe: -2, investigation: -2,
  fraud: -2, subpoena: -2, recall: -2, bankruptcy: -2, delisting: -2, halted: -2,
  warns: -2, warning: -2, slashes: -2, slashed: -2, cuts: -1, cut: -1, layoffs: -2,
  layoff: -2, weak: -1, weakness: -1, loss: -1, losses: -1, decline: -1, declines: -1,
  drops: -1, dropped: -1, falls: -1, fell: -1, lower: -1, bearish: -2, concerns: -1,
  concern: -1, risk: -1, risks: -1, delay: -1, delayed: -1, disappointing: -2,
  disappoints: -2, headwinds: -1, pressure: -1, sell: -1, selloff: -2, short: -1,
  baisse: -1, chute: -2, plonge: -2, poursuite: -2, enquete: -2, avertissement: -2,
  deception: -2, recul: -1, pertes: -1,
};

/** Une negation dans les trois mots precedents inverse le signe du terme. */
const NEGATIONS = new Set([
  'no', 'not', 'never', 'without', 'fails', 'fail', 'failing', 'lacks', 'lack',
  'despite', 'ne', 'pas', 'sans', 'aucun', 'aucune', 'malgre',
]);

const tokenize = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Score d'un titre, dans [-1, 1], avec les termes qui l'ont produit. */
export function scoreHeadline(text) {
  const tokens = tokenize(text);
  let total = 0;
  const matches = [];

  tokens.forEach((token, index) => {
    const weight = LEXICON[token];
    if (!weight) return;

    const negated = tokens
      .slice(Math.max(0, index - 3), index)
      .some((previous) => NEGATIONS.has(previous));

    const applied = negated ? -weight : weight;
    total += applied;
    matches.push({ term: token, weight: applied, negated });
  });

  // Division par 4 : il faut deux signaux forts concordants pour saturer.
  return { score: clamp(total / 4, -1, 1), matches, raw: total };
}

/**
 * Tonalité agregee, pondérée par la fraîcheur (demi-vie de 5 jours) : une
 * depeche de la veille compte davantage qu'une depeche de trois semaines.
 */
export function analyzeSentiment(articles, now = new Date()) {
  if (!articles?.length) return null;

  const halfLifeDays = 5;
  let weightedSum = 0;
  let weightTotal = 0;
  let positive = 0;
  let negative = 0;
  let neutral = 0;

  const scored = articles.map((article) => {
    const { score, matches } = scoreHeadline(article.title);
    const ageDays = article.publishedAt
      ? Math.max(0, (now - article.publishedAt) / 86_400_000)
      : 7;
    const weight = 0.5 ** (ageDays / halfLifeDays);

    if (score > 0.12) positive += 1;
    else if (score < -0.12) negative += 1;
    else neutral += 1;

    weightedSum += score * weight;
    weightTotal += weight;

    return { ...article, sentiment: score, matches, ageDays };
  });

  const overall = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const withSignal = scored.filter((a) => a.matches.length > 0).length;

  return {
    overall,
    articles: scored,
    counts: { positive, negative, neutral, total: scored.length, withSignal },
    // La confiance depend du nombre de titres reellement porteurs de signal.
    confidence: isNum(withSignal) ? clamp(withSignal / 10, 0, 1) : 0,
  };
}
