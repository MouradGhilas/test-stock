import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEarningsReactions } from '../server/analysis/earningsReaction.js';

const jour = (iso) => new Date(`${iso}T00:00:00Z`);

/** Construit une série de bougies à partir de couples date / clôture. */
const serie = (couples) =>
  couples.map(([iso, close]) => ({
    date: jour(iso),
    open: close, high: close, low: close, close, volume: 1000,
  }));

const proche = (a, b, tol = 0.05) =>
  assert.ok(Math.abs(a - b) < tol, `attendu ~${b}, obtenu ${a}`);

/**
 * Clôtures réelles d'AAPL autour de ses quatre dernières publications.
 * Apple publie après clôture : la réaction est toujours la séance suivante.
 * Sur deux de ces trimestres, la séance de publication a davantage bougé que
 * la séance de réaction -- c'est le piège qui fausse une règle naïve du type
 * « prendre la plus forte variation ».
 */
const AAPL = serie([
  ['2025-10-29', 269.70], ['2025-10-30', 271.40], ['2025-10-31', 270.37],
  ['2026-01-28', 256.44], ['2026-01-29', 258.28], ['2026-01-30', 259.48],
  ['2026-04-29', 270.17], ['2026-04-30', 271.35], ['2026-05-01', 280.14],
  ['2026-07-29', 338.19], ['2026-07-30', 333.43], ['2026-07-31', 308.91],
]);

const PUBLICATIONS = [
  { reportedAt: jour('2026-07-30'), surprisePercent: 1.6 },
  { reportedAt: jour('2026-04-30'), surprisePercent: 4.69 },
  { reportedAt: jour('2026-01-29'), surprisePercent: 7.17 },
  { reportedAt: jour('2025-10-30'), surprisePercent: 6.94 },
];

test('le schéma de publication est déduit des trimestres non ambigus', () => {
  const r = analyzeEarningsReactions(AAPL, PUBLICATIONS);
  assert.equal(r.timing, 'after-close');
  assert.equal(r.timingResolution, 'inferred');
  // Deux trimestres tranchent nettement (-7,35 % et +3,24 % le lendemain).
  assert.equal(r.timingVotes['after-close'], 2);
  assert.equal(r.timingVotes['before-open'], 0);
});

test('le schéma déduit s applique aussi aux trimestres ambigus', () => {
  const r = analyzeEarningsReactions(AAPL, PUBLICATIONS);
  const parDate = Object.fromEntries(
    r.events.map((e) => [e.reportedAt.toISOString().slice(0, 10), e.reactionPercent]),
  );

  proche(parDate['2026-07-30'], -7.35);
  proche(parDate['2026-04-30'], 3.24);
  // Ces deux-la sont le coeur du sujet : la séance de publication bougeait
  // plus que la séance de réaction, une regle par amplitude aurait inverse
  // le signe de la reaction.
  proche(parDate['2026-01-29'], 0.46);
  proche(parDate['2025-10-30'], -0.38);
});

test('les agrégats reflètent les bonnes séances', () => {
  const r = analyzeEarningsReactions(AAPL, PUBLICATIONS);
  assert.equal(r.count, 4);
  assert.equal(r.positiveRate, 0.5);
  proche(r.maxAbsMove, 7.35);
  // La plus forte amplitude est ici une baisse, mais ce n'est pas toujours
  // le cas : worstDrop ne retient que les reactions negatives.
  proche(r.worstDrop, 7.35);
  proche(r.medianAbsMove, 1.85, 0.1);
});

test('worstDrop ignore les hausses, même les plus fortes', () => {
  // Cas ORCL : une réaction de +35,95 % est la plus forte amplitude passée,
  // mais elle ne dit rien du risque de baisse.
  const bars = serie([
    ['2026-01-14', 100], ['2026-01-15', 101], ['2026-01-16', 136],
    ['2026-04-14', 100], ['2026-04-15', 99], ['2026-04-16', 94],
  ]);
  const r = analyzeEarningsReactions(bars, [
    { reportedAt: jour('2026-01-15') }, { reportedAt: jour('2026-04-15') },
  ]);
  proche(r.maxAbsMove, 34.65, 0.5);
  proche(r.worstDrop, 5.05, 0.5);
});

test('sans aucune réaction négative, worstDrop reste indéfini', () => {
  const bars = serie([
    ['2026-01-14', 100], ['2026-01-15', 101], ['2026-01-16', 110],
    ['2026-04-14', 100], ['2026-04-15', 101], ['2026-04-16', 108],
  ]);
  const r = analyzeEarningsReactions(bars, [
    { reportedAt: jour('2026-01-15') }, { reportedAt: jour('2026-04-15') },
  ]);
  assert.equal(r.worstDrop, null);
});

test('une société publiant avant ouverture est reconnue comme telle', () => {
  const bars = serie([
    ['2026-01-14', 100], ['2026-01-15', 108], ['2026-01-16', 108.5],
    ['2026-04-14', 100], ['2026-04-15', 93], ['2026-04-16', 93.2],
  ]);
  const r = analyzeEarningsReactions(bars, [
    { reportedAt: jour('2026-01-15') },
    { reportedAt: jour('2026-04-15') },
  ]);
  assert.equal(r.timing, 'before-open');
  assert.equal(r.timingResolution, 'inferred');
  proche(r.events.at(-1).reactionPercent, 8);
});

test('sans signal exploitable, l horaire annoncé sert d indice', () => {
  // Variations trop faibles pour trancher : aucun trimestre ne vote.
  const bars = serie([
    ['2026-01-14', 100], ['2026-01-15', 100.2], ['2026-01-16', 100.4],
    ['2026-04-14', 100], ['2026-04-15', 100.3], ['2026-04-16', 100.1],
  ]);
  const reports = [{ reportedAt: jour('2026-01-15') }, { reportedAt: jour('2026-04-15') }];

  assert.equal(analyzeEarningsReactions(bars, reports, 'before-open').timingResolution, 'hint');
  assert.equal(analyzeEarningsReactions(bars, reports, 'before-open').timing, 'before-open');
  // Sans indice, on retient le cas majoritaire aux États-Unis.
  assert.equal(analyzeEarningsReactions(bars, reports, null).timing, 'after-close');
  assert.equal(analyzeEarningsReactions(bars, reports, null).timingResolution, 'default');
});

test('le parcours des cinq séances précédentes est mesuré', () => {
  const closes = Array.from({ length: 10 }, (_, i) => [`2026-03-${String(i + 2).padStart(2, '0')}`, 100 + i * 2]);
  const r = analyzeEarningsReactions(serie(closes), [{ reportedAt: jour('2026-03-09') }]);
  // De 100+2*2=104 (séance 3) a 100+7*2=114 (séance 8) : +9,6 %.
  proche(r.events[0].runUpPercent, 9.62, 0.1);
});

test('les entrées vides sont gérées sans planter', () => {
  assert.equal(analyzeEarningsReactions([], PUBLICATIONS), null);
  assert.equal(analyzeEarningsReactions(AAPL, []), null);
  assert.equal(analyzeEarningsReactions(null, null), null);
  // Publication hors de la fenêtre d'historique : rien a reconstituer.
  assert.equal(analyzeEarningsReactions(AAPL, [{ reportedAt: jour('2019-01-01') }]), null);
});
