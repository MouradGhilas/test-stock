import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Le magasin résout son répertoire au chargement du module.
const DIR = await mkdtemp(path.join(tmpdir(), 'trades-'));
process.env.TRADES_DIR = DIR;
const store = await import('../server/portfolio/store.js');
const { normalizeNewTrade, applyPatch } = await import('../server/portfolio/trade.js');

test.after(() => rm(DIR, { recursive: true, force: true }));

const SIGNAL = {
  ticker: 'nvda',
  side: 'long',
  entry: 100,
  stop: 95,
  targets: [110, 120],
  quantity: 10,
  handle: 'trader',
};

/* ------------------------------------------------------------------ */
/* Validation du modèle                                               */
/* ------------------------------------------------------------------ */

test('une saisie correcte est normalisée', () => {
  const trade = normalizeNewTrade(SIGNAL);
  assert.equal(trade.ticker, 'NVDA', 'le ticker est mis en capitales');
  assert.equal(trade.source.handle, '@trader', "l'arobase est ajoutée");
  assert.equal(trade.initialStop, 95, 'le stop initial est mémorisé dès la création');
  assert.equal(trade.status, 'open');
  assert.ok(trade.id.startsWith('t_'));
});

test('les saisies inexploitables sont refusées avec un message', () => {
  const cas = [
    [{ ...SIGNAL, ticker: '???' }, /Ticker/],
    [{ ...SIGNAL, entry: -3 }, /entrée/i],
    [{ ...SIGNAL, entry: 'beaucoup' }, /entrée/i],
    [{ ...SIGNAL, quantity: 0 }, /Quantité/],
    [{ ...SIGNAL, stop: 105 }, /stop/i],
    [{ ...SIGNAL, targets: [90] }, /objectif/i],
    [{ ...SIGNAL, side: 'peut-être' }, /Sens/],
  ];

  for (const [saisie, attendu] of cas) {
    assert.throws(() => normalizeNewTrade(saisie), attendu, JSON.stringify(saisie));
  }
});

test('une position en veille peut attendre sans quantité', () => {
  const trade = normalizeNewTrade({ ...SIGNAL, status: 'watch', quantity: null });
  assert.equal(trade.quantity, null);
  assert.equal(trade.openedAt, null, 'rien n est engagé, donc pas de date d entrée');
});

test('les objectifs sont ordonnés du plus proche au plus lointain', () => {
  assert.deepEqual(normalizeNewTrade({ ...SIGNAL, targets: [120, 110] }).targets, [110, 120]);
  assert.deepEqual(
    normalizeNewTrade({ ticker: 'X', side: 'short', entry: 100, stop: 105, targets: [80, 90], quantity: 1 }).targets,
    [90, 80],
    'à la vente, le plus proche est le plus haut',
  );
});

test('un stop peut être remonté au-delà de l entrée une fois la position ouverte', () => {
  const trade = normalizeNewTrade(SIGNAL);
  const secured = applyPatch(trade, { stop: 104 });
  assert.equal(secured.stop, 104, 'sécuriser un gain est légitime');
  assert.equal(secured.initialStop, 95, 'le risque initial ne bouge pas');
});

test('une clôture exige un prix de sortie', () => {
  const trade = normalizeNewTrade(SIGNAL);
  assert.throws(() => applyPatch(trade, { status: 'closed' }), /prix de sortie/);
  const closed = applyPatch(trade, { status: 'closed', exit: 108 });
  assert.equal(closed.exit, 108);
  assert.ok(closed.closedAt);
});

test('un champ non modifiable est refusé', () => {
  const trade = normalizeNewTrade(SIGNAL);
  assert.throws(() => applyPatch(trade, { id: 'autre' }), /non modifiable/);
});

/* ------------------------------------------------------------------ */
/* Persistance                                                        */
/* ------------------------------------------------------------------ */

test('un portefeuille absent se lit comme un portefeuille vide', async () => {
  const portfolio = await store.read();
  assert.deepEqual(portfolio.trades, []);
  assert.equal(portfolio.settings.capital, store.DEFAULT_SETTINGS.capital);
});

test('une position créée se relit après écriture', async () => {
  const created = await store.createTrade(SIGNAL);
  const { trades } = await store.read();
  assert.equal(trades.length, 1);
  assert.equal(trades[0].id, created.id);

  const brut = JSON.parse(await readFile(path.join(DIR, 'trades.json'), 'utf8'));
  assert.equal(brut.trades[0].ticker, 'NVDA', 'le fichier reste lisible à l œil');
});

test('une modification porte sur la bonne ligne', async () => {
  const autre = await store.createTrade({ ...SIGNAL, ticker: 'AMD' });
  await store.updateTrade(autre.id, { stop: 97 });

  const { trades } = await store.read();
  assert.equal(trades.find((t) => t.id === autre.id).stop, 97);
  assert.equal(trades.find((t) => t.ticker === 'NVDA').stop, 95, 'les autres lignes sont intactes');
});

test('une position introuvable donne un 404, pas un plantage', async () => {
  await assert.rejects(store.updateTrade('t_inexistant', { stop: 90 }), (error) => error.status === 404);
});

test('les écritures simultanées ne se perdent pas', async () => {
  // Sans sérialisation, ces cinq créations se reliraient mutuellement et
  // n en garderaient qu une.
  const avant = (await store.read()).trades.length;
  await Promise.all(
    ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((ticker) => store.createTrade({ ...SIGNAL, ticker })),
  );
  assert.equal((await store.read()).trades.length, avant + 5);
});

test('une action groupée applique ce qu elle peut et dit ce qu elle a laissé', async () => {
  const { trades } = await store.read();
  const ids = trades.slice(0, 3).map((t) => t.id);
  await store.updateTrade(ids[0], { status: 'closed', exit: 105 });

  const { changed, skipped } = await store.patchMany(ids, (trade) => {
    if (trade.status === 'closed') throw new Error('déjà soldée');
    return { stop: trade.entry };
  });

  assert.equal(changed.length, 2);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'déjà soldée');
  assert.ok(changed.every((t) => t.stop === t.entry));
});

test('une action groupée qui échoue partout ne casse rien', async () => {
  const { trades } = await store.read();
  const avant = JSON.stringify(trades);
  const { changed, skipped } = await store.patchMany(trades.map((t) => t.id), () => {
    throw new Error('rien à faire');
  });

  assert.equal(changed.length, 0);
  assert.equal(skipped.length, trades.length);
  assert.equal(JSON.stringify((await store.read()).trades), avant);
});

test('la suppression ne retire que les lignes visées', async () => {
  const { trades } = await store.read();
  const cible = trades[0].id;
  const { deleted } = await store.deleteTrades([cible, 'inconnu']);

  assert.equal(deleted, 1);
  const restantes = (await store.read()).trades;
  assert.equal(restantes.length, trades.length - 1);
  assert.ok(!restantes.some((t) => t.id === cible));
});

test('les réglages se valident et se conservent', async () => {
  const settings = await store.updateSettings({ capital: 25_000, riskPerTradePct: 0.5 });
  assert.equal(settings.capital, 25_000);
  assert.equal((await store.read()).settings.riskPerTradePct, 0.5);

  await assert.rejects(store.updateSettings({ capital: -1 }), /Capital/);
  await assert.rejects(store.updateSettings({ riskPerTradePct: 300 }), /Risque/);
  assert.equal((await store.read()).settings.capital, 25_000, 'un refus ne modifie rien');
});

test('un fichier corrompu ne fait pas perdre l application', async () => {
  await writeFile(path.join(DIR, 'trades.json'), '{ ceci n est pas du JSON', 'utf8');
  const portfolio = await store.read();
  assert.deepEqual(portfolio.trades, [], 'on repart d un portefeuille vide plutôt que de planter');
});
