import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, rsi, atr, performance, computeIndicators } from '../server/analysis/indicators.js';

/** Construit des bougies quotidiennes a partir d'une suite de clotures. */
const bars = (closes, spread = 1) =>
  closes.map((close, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)),
    open: close,
    high: close + spread,
    low: close - spread,
    close,
    volume: 1000,
  }));

test('sma calcule la moyenne des dernières séances', () => {
  assert.equal(sma(bars([10, 20, 30, 40, 50]), 5), 30);
  assert.equal(sma(bars([10, 20, 30, 40, 50]), 2), 45);
  assert.equal(sma(bars([10, 20]), 5), null, 'historique trop court -> null');
});

test('rsi vaut 100 sur une hausse ininterrompue', () => {
  const hausse = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(bars(hausse), 14), 100);
});

test('rsi vaut 0 sur une baisse ininterrompue', () => {
  const baisse = Array.from({ length: 30 }, (_, i) => 200 - i);
  assert.equal(rsi(bars(baisse), 14), 0);
});

test('rsi reste neutre sur une série plate', () => {
  // Ni gain ni perte : le rapport n'est pas defini, la neutralite est la
  // seule lecture correcte -- surtout pas un surachat maximal.
  assert.equal(rsi(bars(Array(30).fill(100)), 14), 50);
});

test('atr mesure l amplitude moyenne des séances', () => {
  // Clotures stables et amplitude de 2 (haut = cloture+1, bas = cloture-1).
  assert.equal(atr(bars(Array(20).fill(100), 1), 14), 2);
});

test('performance mesure la variation sur N séances', () => {
  assert.equal(performance(bars([100, 110]), 1), 10);
  assert.equal(performance(bars([100, 90]), 1), -10);
  assert.equal(performance(bars([100]), 5), null);
});

test('computeIndicators refuse un historique trop court', () => {
  assert.equal(computeIndicators(bars([1, 2, 3])), null);
  assert.equal(computeIndicators([]), null);
  assert.equal(computeIndicators(null), null);
});

test('computeIndicators renseigne les champs attendus', () => {
  const serie = Array.from({ length: 260 }, (_, i) => 100 + Math.sin(i / 9) * 10 + i * 0.1);
  const ind = computeIndicators(bars(serie));
  for (const champ of ['lastClose', 'sma20', 'sma50', 'sma200', 'rsi14', 'atr14', 'realizedVol30', 'perf21', 'perf63']) {
    assert.equal(typeof ind[champ], 'number', `${champ} devrait être un nombre`);
  }
  assert.ok(ind.range52w.high >= ind.range52w.low);
  assert.ok(ind.rsi14 >= 0 && ind.rsi14 <= 100);
});
