import test from 'node:test';
import assert from 'node:assert/strict';
import { standardError, median, mean, stdev, round } from '../server/core/stats.js';

const proche = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `attendu ${b}, obtenu ${a}`);

test('standardError décroît en racine du nombre d observations', () => {
  // C'est ce qui permet de dire qu'un compte suivi n'a rien prouvé : sur peu
  // de trades, la moyenne des R n'est pas distinguable de zéro.
  const petit = standardError([1, 2, 3, 4]);
  const grand = standardError([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
  assert.ok(grand < petit, 'plus d observations -> incertitude moindre');
  proche(grand, petit / 2, 0.05);
});

test('les fonctions de base restent robustes aux valeurs manquantes', () => {
  assert.equal(median([3, null, 1, undefined, 2]), 2);
  assert.equal(mean([]), null);
  assert.equal(stdev([5]), null, 'un seul point ne dit rien de la dispersion');
  assert.equal(standardError(['x']), null);
});

test('round arrondit sans jamais rendre autre chose qu un nombre ou null', () => {
  assert.equal(round(1.2345), 1.23);
  assert.equal(round(1.2345, 3), 1.235);
  assert.equal(round(null), null);
  assert.equal(round(Number.NaN), null);
});
