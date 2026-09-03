/**
 * Reconstruction des réactions passées aux publications de résultats.
 *
 * C'est la référence historique à laquelle on compare le mouvement implicite :
 * si le marché price 8 % alors que le titre bouge historiquement de 3 %,
 * l'événement est cher payé.
 *
 * Difficulté : une société qui publie après clôture réagit le lendemain, une
 * société qui publie avant ouverture réagit le jour même. Se tromper de séance
 * inverse le signe de la réaction et corrompt tout le facteur.
 *
 * Quand l'horaire est connu -- les dépôts 8-K de la SEC sont horodatés à la
 * seconde -- la question ne se pose pas : on l'utilise. C'est le cas nominal.
 *
 * Sinon, on ne devine pas séance par séance : on identifie le schéma de
 * publication de la société, puis on l'applique uniformément. Quand une
 * séance bouge deux fois plus que l'autre et dépasse 1,5 %, elle désigne sans
 * ambiguïté le moment de publication ; ces trimestres "nets" votent, la
 * majorité l'emporte, et le schéma retenu sert pour tous les trimestres --
 * y compris ceux ou la réaction fut trop faible pour trancher seule.
 */

import { median, mean, isNum } from '../core/stats.js';

const VOTE_RATIO = 2;
const VOTE_MIN_MOVE = 1.5;

/** Index de la séance correspondant à la date, ou la dernière séance antérieure. */
function sessionIndex(bars, date) {
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  let found = -1;
  for (let i = 0; i < bars.length; i += 1) {
    const d = bars[i].date;
    if (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) <= target) found = i;
    else break;
  }
  return found;
}

const changeBetween = (bars, from, to) => {
  if (from < 0 || to >= bars.length || to < 0) return null;
  const a = bars[from].close;
  const b = bars[to].close;
  return isNum(a) && isNum(b) && a > 0 ? ((b - a) / a) * 100 : null;
};

/**
 * Détermine si une publication désigne sans ambiguïté sa séance de réaction.
 * @returns {'before-open'|'after-close'|null}
 */
function vote(sameDay, nextDay) {
  const a = Math.abs(sameDay ?? 0);
  const b = Math.abs(nextDay ?? 0);
  if (b >= VOTE_MIN_MOVE && b >= a * VOTE_RATIO) return 'after-close';
  if (a >= VOTE_MIN_MOVE && a >= b * VOTE_RATIO) return 'before-open';
  return null;
}

/**
 * @param {Array} bars           Bougies quotidiennes, ordre croissant.
 * @param {Array} reports        Publications passées ({ reportedAt, timing?, surprisePercent? }).
 *                               Un `timing` renseigné (dépôt SEC) prime sur toute déduction.
 * @param {string|null} hint     Horaire connu de la prochaîne publication, utilise
 *                               comme indice quand l'historique ne tranche pas.
 */
export function analyzeEarningsReactions(bars, reports, hint = null) {
  if (!bars?.length || !reports?.length) return null;

  // Passe 1 : les deux séances candidates de chaque publication.
  const candidates = [];
  for (const report of reports) {
    const index = sessionIndex(bars, report.reportedAt);
    if (index < 1 || index >= bars.length) continue;

    candidates.push({
      report,
      index,
      sameDay: changeBetween(bars, index - 1, index),
      nextDay: changeBetween(bars, index, index + 1),
    });
  }
  if (!candidates.length) return null;

  // Passe 2 : le schéma de publication de la société, par vote des trimestres
  // nets -- et seulement pour les publications dont l'horaire est inconnu.
  const tally = { 'after-close': 0, 'before-open': 0 };
  for (const c of candidates) {
    if (c.report.timing) continue;
    const ballot = vote(c.sameDay, c.nextDay);
    if (ballot) tally[ballot] += 1;
  }

  let timing;
  let resolution;
  if (tally['after-close'] !== tally['before-open']) {
    timing = tally['after-close'] > tally['before-open'] ? 'after-close' : 'before-open';
    resolution = 'inferred';
  } else if (hint === 'after-close' || hint === 'before-open') {
    timing = hint;
    resolution = 'hint';
  } else {
    // Défaut : la publication après clôture est le cas majoritaire aux États-Unis.
    timing = 'after-close';
    resolution = 'default';
  }

  // Passe 3 : horaire déposé quand il existe, schéma déduit sinon.
  const events = [];
  let dated = 0;
  for (const c of candidates) {
    const effective = c.report.timing || timing;
    if (c.report.timing) dated += 1;

    // Une publication en séance, comme une publication avant ouverture, se
    // lit sur la séance du jour même.
    const useNextDay = effective === 'after-close';
    const reaction = useNextDay ? c.nextDay : c.sameDay;
    const reactionDate = useNextDay ? bars[c.index + 1]?.date : bars[c.index].date;
    if (reaction === null || !reactionDate) continue;

    events.push({
      reportedAt: c.report.reportedAt,
      reactionDate,
      reactionPercent: reaction,
      timing: effective,
      timingKnown: Boolean(c.report.timing),
      candidates: { sameDay: c.sameDay, nextDay: c.nextDay },
      // Parcours des cinq séances précédant la publication : une forte hausse
      // avant l'événement signale des attentes déjà élevées.
      runUpPercent: changeBetween(bars, Math.max(0, c.index - 5), c.index),
      surprisePercent: isNum(c.report.surprisePercent) ? c.report.surprisePercent : null,
    });
  }
  if (!events.length) return null;

  const reactions = events.map((e) => e.reactionPercent);
  const positives = reactions.filter((r) => r > 0).length;

  // La résolution dit sur quoi repose réellement la mesure : un horaire
  // officiellement déposé n'a pas la même valeur qu'une déduction.
  const overall = dated === candidates.length ? 'filing' : dated > 0 ? 'mixed' : resolution;

  return {
    events: events.sort((a, b) => b.reportedAt - a.reportedAt),
    count: events.length,
    timing,
    timingResolution: overall,
    timingFromFilings: dated,
    timingVotes: tally,
    medianAbsMove: median(reactions.map(Math.abs)),
    maxAbsMove: Math.max(...reactions.map(Math.abs)),
    // La plus forte amplitude peut être une hausse : pour dimensionner un
    // risque, seule la pire baisse est pertinente.
    worstDrop: reactions.some((r) => r < 0) ? Math.abs(Math.min(...reactions)) : null,
    medianMove: median(reactions),
    meanMove: mean(reactions),
    positiveRate: positives / events.length,
    medianRunUp: median(events.map((e) => e.runUpPercent).filter(isNum)),
  };
}
