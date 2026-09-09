import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignal, toPrice } from '../server/portfolio/signal.js';

/* --- Conversion des nombres tels qu'on les écrit dans un post --- */

test('les nombres se lisent dans les deux conventions', () => {
  assert.equal(toPrice('178.50'), 178.5);
  assert.equal(toPrice('178,50'), 178.5, 'virgule décimale française');
  assert.equal(toPrice('1,250'), 1250, 'virgule suivie de trois chiffres : milliers');
  assert.equal(toPrice('1,250.75'), 1250.75);
  assert.equal(toPrice('1.250,75'), 1250.75, 'écriture européenne complète');
  assert.equal(toPrice('$232'), 232);
  assert.equal(toPrice('1 250'), 1250);
  assert.equal(toPrice(''), null);
});

/* --- Formats rencontrés sur X --- */

test('un signal anglais complet est lu intégralement', () => {
  const s = parseSignal('$NVDA long entry 178.50 SL 172 TP1 185 TP2 192');
  assert.equal(s.ticker, 'NVDA');
  assert.equal(s.side, 'long');
  assert.equal(s.entry, 178.5);
  assert.equal(s.stop, 172);
  assert.deepEqual(s.targets, [185, 192]);
  assert.equal(s.coverage, 1);
  assert.deepEqual(s.warnings, []);
});

test('un signal français est lu de la même façon', () => {
  const s = parseSignal('BUY $AAPL @ 232,10 — stop 227, objectif 245');
  assert.equal(s.ticker, 'AAPL');
  assert.equal(s.entry, 232.1);
  assert.equal(s.stop, 227);
  assert.deepEqual(s.targets, [245]);
});

test('une vente à découvert garde son sens', () => {
  const s = parseSignal('vente à découvert $SMCI 38.40, sl 41, obj 32');
  assert.equal(s.side, 'short');
  assert.equal(s.stop, 41);
  assert.deepEqual(s.targets, [32]);
});

test('une fourchette d entrée donne son milieu et garde ses bornes', () => {
  const s = parseSignal('LONG $MSFT 415-420 | Stop: 405 | Targets: 440, 455, 470');
  assert.equal(s.entry, 417.5);
  assert.deepEqual(s.entryRange, [415, 420]);
  assert.deepEqual(s.targets, [440, 455, 470], 'une énumération se lit en entier');
});

test('une fourchette n est pas confondue avec un objectif étalé', () => {
  // « TP 185-190 » ne doit pas devenir la fourchette d'entrée.
  const s = parseSignal('$NVDA long entry 178 SL 172 TP 185-190');
  assert.equal(s.entry, 178);
  assert.equal(s.entryRange, null);
});

test('un stop en pourcentage se convertit selon le sens', () => {
  const long = parseSignal('$AAPL buy 200 sl -3% tp +6%');
  assert.equal(long.stop, 194, '3 % sous une entrée à 200');
  assert.deepEqual(long.targets, [212]);

  const short = parseSignal('Short TSLA below 400 | sl 3% | tp 6%');
  assert.equal(short.side, 'short');
  assert.equal(short.stop, 412, 'le stop d une vente est au-dessus');
  assert.deepEqual(short.targets, [376]);
});

test('le numéro d objectif n est pas pris pour un prix', () => {
  assert.deepEqual(parseSignal('$X long 10 sl 9 TP1 12 TP2 14').targets, [12, 14]);
  assert.deepEqual(parseSignal('$X long 10 sl 9 TP 185').targets, [185], 'sans numéro, le 1 appartient au prix');
});

test('le compte X est repris du lien du post', () => {
  const s = parseSignal('https://x.com/SomeTrader/status/1789 $AMD achat 142.30 stop loss 137 obj 158');
  assert.equal(s.source.handle, '@SomeTrader');
  assert.equal(s.source.url, 'https://x.com/SomeTrader/status/1789');
});

test('une mention sert de compte à défaut de lien', () => {
  assert.equal(parseSignal('$AMD achat 142 sl 137 @trader_fr').source.handle, '@trader_fr');
});

test('la taille et le risque annoncés sont repris', () => {
  const shares = parseSignal('nouvelle position sur $PLTR, entrée 78.9, 200 shares, invalidation 74');
  assert.equal(shares.quantity, 200);

  const risk = parseSignal('Long $COIN entry 245, stop 236, tp 275, risque 1,5%');
  assert.equal(risk.riskPercent, 1.5);
  assert.equal(risk.quantity, null);
});

/* --- Ce que le parseur refuse de deviner en silence --- */

test('un sens absent se déduit de la géométrie, et le dit', () => {
  const s = parseSignal('$SOFI 12.5 sl 11.8 tp 14');
  assert.equal(s.side, 'long', 'stop sous l entrée, objectif au-dessus : un achat');
  assert.equal(s.origins.side, 'guessed');
  assert.equal(s.entry, 12.5);
});

test('un texte sans signal ne fabrique pas de position', () => {
  const s = parseSignal('je pense que le marché va monter en 2026');
  assert.equal(s.ticker, null);
  assert.equal(s.entry, null);
  assert.equal(s.coverage, 0);
  assert.ok(s.warnings.length >= 3, 'chaque champ manquant est signalé');
});

test('un nombre voisin d un cashtag n est pas un prix d entrée', () => {
  // Sans stop ni objectif dans le texte, rien n indique un signal.
  assert.equal(parseSignal('$NVDA 2026 va être une grande année').entry, null);
});

test('un ticker deviné est signalé comme tel', () => {
  const s = parseSignal('Short TSLA below 400 sl 412');
  assert.equal(s.ticker, 'TSLA');
  assert.equal(s.origins.ticker, 'guessed');
  assert.ok(s.warnings.some((w) => /déduit/i.test(w)));
});

test('le jargon de trading ne passe pas pour un ticker', () => {
  for (const texte of ['long entry 100 SL 95 TP 110', 'BUY at 50, stop 47']) {
    assert.equal(parseSignal(texte).ticker, null, texte);
  }
});

test('un stop du mauvais côté est signalé, pas corrigé', () => {
  const s = parseSignal('$NVDA long entry 178 SL 185');
  assert.equal(s.stop, 185, 'la valeur lue est rendue telle quelle');
  assert.ok(s.warnings.some((w) => /stop/i.test(w) && /au-dessus/i.test(w)));
});

test('l absence de stop est toujours signalée', () => {
  const s = parseSignal('$NVDA long entry 178 tp 190');
  assert.equal(s.stop, null);
  assert.ok(s.warnings.some((w) => /stop/i.test(w)));
});

test('une étiquette ne capture pas un nombre lointain', () => {
  // « stop » suivi d une phrase entière : le 178 appartient à l achat.
  const s = parseSignal('pas de stop pour le moment, buy $NVDA 178');
  assert.equal(s.stop, null);
  assert.equal(s.entry, 178);
});
