import test from 'node:test';
import assert from 'node:assert/strict';
import { remember, get, set, clear, stats } from '../server/core/cache.js';

test('une valeur mémorisée est relue depuis le cache', async () => {
  clear();
  let appels = 0;
  const produire = async () => { appels += 1; return 'valeur'; };

  const premier = await remember('cle', 60, produire);
  const second = await remember('cle', 60, produire);

  assert.equal(premier.value, 'valeur');
  assert.equal(premier.cached, false);
  assert.equal(second.cached, true);
  assert.equal(appels, 1, 'la source ne doit être sollicitée qu une fois');
});

test('les appels concurrents sur la même clé ne déclenchent qu une collecte', async () => {
  clear();
  let appels = 0;
  const lent = async () => {
    appels += 1;
    await new Promise((r) => setTimeout(r, 30));
    return 'ok';
  };

  // C est ce qui évite de marteler les sources quand plusieurs analyses
  // portent sur le même ticker au même moment.
  const resultats = await Promise.all([1, 2, 3, 4].map(() => remember('meme', 60, lent)));
  assert.equal(appels, 1);
  for (const r of resultats) assert.equal(r.value, 'ok');
});

test('une entrée expirée est recalculée', async () => {
  clear();
  set('court', 'ancien', -1);
  assert.equal(get('court'), undefined, 'une entrée expirée ne doit pas être relue');

  const { value, cached } = await remember('court', 60, async () => 'neuf');
  assert.equal(value, 'neuf');
  assert.equal(cached, false);
});

test('une erreur de collecte n est pas mémorisée', async () => {
  clear();
  await assert.rejects(remember('echec', 60, async () => { throw new Error('panne'); }));
  assert.equal(get('echec'), undefined);
  assert.equal(stats().inflight, 0, 'la requête en vol doit être libérée');
});
