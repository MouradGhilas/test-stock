import test from 'node:test';
import assert from 'node:assert/strict';
import { pearson, spearman, standardError, median, mean, stdev, scale, clamp } from '../server/core/stats.js';

const proche = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `attendu ${b}, obtenu ${a}`);

test('pearson vaut 1 et -1 sur des relations linéaires parfaites', () => {
  proche(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  proche(pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1);
});

test('pearson est nul sur des séries indépendantes symétriques', () => {
  proche(pearson([1, 2, 3, 4, 5], [3, 1, 4, 1, 3]), 0, 0.35);
});

test('spearman capte une relation monotone que pearson sous-estime', () => {
  // Relation croissante mais fortement non linéaire.
  const xs = [1, 2, 3, 4, 5];
  const ys = [1, 2, 4, 8, 500];
  proche(spearman(xs, ys), 1);
  assert.ok(pearson(xs, ys) < 0.9, 'pearson doit être dégradé par la valeur extrême');
});

test('spearman gère les ex aequo', () => {
  const r = spearman([1, 2, 2, 3], [1, 2, 2, 3]);
  proche(r, 1);
});

test('les corrélations refusent de conclure sur trop peu de points', () => {
  assert.equal(pearson([1, 2], [1, 2]), null);
  assert.equal(spearman([1], [1]), null);
  // Série constante : la corrélation n'est pas définie.
  assert.equal(pearson([1, 1, 1, 1], [1, 2, 3, 4]), null);
});

test('standardError décroît en racine du nombre d observations', () => {
  const petit = standardError([1, 2, 3, 4]);
  const grand = standardError([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
  assert.ok(grand < petit, 'plus d observations -> incertitude moindre');
  proche(grand, petit / 2, 0.05);
});

test('les fonctions de base restent robustes aux valeurs manquantes', () => {
  assert.equal(median([3, null, 1, undefined, 2]), 2);
  assert.equal(mean([]), null);
  assert.equal(stdev([5]), null);
  assert.equal(clamp(15, 0, 10), 10);
  assert.equal(scale(5, 0, 10, 0, 100), 50);
  assert.equal(scale(50, 0, 10, 0, 100), 100, 'la valeur hors bornes est ramenée');
});
