import test from 'node:test';
import assert from 'node:assert/strict';
import { toMarketTime } from '../server/sources/edgar.js';
import { mergeEarningsHistory, dominantTiming } from '../server/analyze.js';

const jour = (iso) => new Date(`${iso}T00:00:00Z`);

test('toMarketTime situe le dépôt dans la séance new-yorkaise', () => {
  // 20h30 UTC en été = 16h30 à New York, soit après la clôture de 16h00.
  assert.deepEqual(toMarketTime('2026-07-30T20:30:28.000Z'),
    { date: '2026-07-30', minutes: 990, timing: 'after-close' });
  // En hiver le décalage change : 21h30 UTC = 16h30 à New York.
  assert.equal(toMarketTime('2026-01-29T21:30:33.000Z').timing, 'after-close');
  assert.equal(toMarketTime('2026-01-29T21:30:33.000Z').date, '2026-01-29');
});

test('toMarketTime distingue les trois moments de publication', () => {
  assert.equal(toMarketTime('2026-07-30T11:00:00.000Z').timing, 'before-open');   // 7h00
  assert.equal(toMarketTime('2026-07-30T13:29:00.000Z').timing, 'before-open');   // 9h29
  assert.equal(toMarketTime('2026-07-30T13:30:00.000Z').timing, 'during-session'); // 9h30
  assert.equal(toMarketTime('2026-07-30T19:59:00.000Z').timing, 'during-session'); // 15h59
  assert.equal(toMarketTime('2026-07-30T20:00:00.000Z').timing, 'after-close');    // 16h00
});

test('toMarketTime ramène le dépôt tardif à sa date de séance', () => {
  // 00h30 UTC le 31 correspond à 20h30 le 30 à New York : la séance
  // concernée est bien celle du 30, pas celle du 31.
  const r = toMarketTime('2026-07-31T00:30:00.000Z');
  assert.equal(r.date, '2026-07-30');
  assert.equal(r.timing, 'after-close');
});

test('toMarketTime rejette un horodatage invalide', () => {
  assert.equal(toMarketTime('pas une date'), null);
  assert.equal(toMarketTime(null), null);
});

test('mergeEarningsHistory garde la couverture SEC et y greffe les surprises', () => {
  const filings = [
    { reportedAt: jour('2026-07-30'), timing: 'after-close', acceptedAt: '2026-07-30T20:30:28.000Z' },
    { reportedAt: jour('2026-04-30'), timing: 'after-close', acceptedAt: '2026-04-30T20:30:41.000Z' },
    { reportedAt: jour('2023-08-03'), timing: 'after-close', acceptedAt: '2023-08-03T20:30:00.000Z' },
  ];
  const surprises = [
    { reportedAt: jour('2026-07-30'), fiscalQuarter: 'Jun 2026', eps: 1.91, consensus: 1.88, surprisePercent: 1.6 },
  ];

  const merged = mergeEarningsHistory(filings, surprises);
  assert.equal(merged.length, 3, 'la profondeur SEC ne doit pas être tronquée');
  assert.equal(merged[0].surprisePercent, 1.6, 'surprise rattachée par la date');
  assert.equal(merged[0].timing, 'after-close');
  assert.equal(merged[1].surprisePercent, null, 'absence de surprise connue -> null, pas une erreur');
  assert.equal(merged[2].timing, 'after-close');
});

test('mergeEarningsHistory se rabat sur le fournisseur sans dépôts SEC', () => {
  const surprises = [{ reportedAt: jour('2026-07-30'), surprisePercent: 1.6 }];
  const merged = mergeEarningsHistory(null, surprises);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].timing, null, 'horaire inconnu -> la déduction reprendra la main');
  assert.deepEqual(mergeEarningsHistory(null, null), []);
});

test('dominantTiming ne conclut que sur une pratique nettement majoritaire', () => {
  const apres = (n) => Array(n).fill({ timing: 'after-close' });
  assert.equal(dominantTiming([...apres(9), { timing: 'during-session' }]), 'after-close');
  // Une société qui alterne n'a pas d'habitude exploitable.
  assert.equal(dominantTiming([...apres(5), ...Array(5).fill({ timing: 'before-open' })]), null);
  assert.equal(dominantTiming([]), null);
  assert.equal(dominantTiming(null), null);
});

test('un horaire déposé prime sur la déduction par amplitude', async () => {
  const { analyzeEarningsReactions } = await import('../server/analysis/earningsReaction.js');
  const bars = [
    ['2026-01-14', 100], ['2026-01-15', 105], ['2026-01-16', 105.2],
  ].map(([iso, close]) => ({ date: jour(iso), open: close, high: close, low: close, close, volume: 1 }));

  // L'amplitude désignerait la séance de publication (+5 %), mais le dépôt
  // établit une publication après clôture : la réaction est le lendemain.
  const r = analyzeEarningsReactions(bars, [{ reportedAt: jour('2026-01-15'), timing: 'after-close' }]);
  assert.equal(r.timingResolution, 'filing');
  assert.equal(r.timingFromFilings, 1);
  assert.ok(Math.abs(r.events[0].reactionPercent - 0.19) < 0.02, `obtenu ${r.events[0].reactionPercent}`);
  assert.equal(r.events[0].timingKnown, true);
});

test('une publication en séance se lit sur la séance du jour même', () => {
  const bars = [
    ['2026-01-14', 100], ['2026-01-15', 105], ['2026-01-16', 105.2],
  ].map(([iso, close]) => ({ date: jour(iso), open: close, high: close, low: close, close, volume: 1 }));

  return import('../server/analysis/earningsReaction.js').then(({ analyzeEarningsReactions }) => {
    const r = analyzeEarningsReactions(bars, [{ reportedAt: jour('2026-01-15'), timing: 'during-session' }]);
    assert.ok(Math.abs(r.events[0].reactionPercent - 5) < 0.01);
    assert.equal(r.events[0].timing, 'during-session');
  });
});
