import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptionSymbol, groupByExpiry, atmProfile, inferEarningsWindow, pickReference } from '../server/sources/cboe.js';

test('parseOptionSymbol décode le format OCC', () => {
  const r = parseOptionSymbol('AAPL260902C00205000');
  assert.equal(r.type, 'C');
  assert.equal(r.strike, 205);
  assert.equal(r.expiry.toISOString().slice(0, 10), '2026-09-02');

  // Racine numérotée (titre ayant subi une opération sur capital).
  assert.equal(parseOptionSymbol('AAPL1260902P00150000').strike, 150);
  assert.equal(parseOptionSymbol('AAPL1260902P00150000').type, 'P');
});

test('parseOptionSymbol rejette ce qui n est pas un symbole d option', () => {
  for (const bad of ['AAPL', '', null, 'PASUNSYMBOLEVALIDE']) {
    assert.equal(parseOptionSymbol(bad), null);
  }
});

const option = (sym, bid, ask, iv, delta = 0.5) => ({
  option: sym, bid, ask, iv, delta, open_interest: 100, volume: 10,
});

test('atmProfile retient le strike le plus proche du cours', () => {
  const chains = groupByExpiry([
    option('XYZ261016C00090000', 12, 12.4, 0.30),
    option('XYZ261016P00090000', 1.0, 1.2, 0.30),
    option('XYZ261016C00100000', 4.8, 5.2, 0.25),
    option('XYZ261016P00100000', 4.8, 5.2, 0.25),
  ]);
  const atm = atmProfile(chains[0], 101);
  assert.equal(atm.strike, 100);
  assert.equal(atm.straddle, 10);        // (5 + 5)
  assert.equal(atm.iv, 0.25);
});

test('atmProfile se rabat sur le prix théorique sans fourchette', () => {
  const chains = groupByExpiry([
    { option: 'XYZ261016C00100000', bid: 0, ask: 0, theo: 3, iv: 0.2, delta: 0.5 },
    { option: 'XYZ261016P00100000', bid: 0, ask: 0, theo: 2, last_trade_price: 2.1, iv: 0.2, delta: -0.5 },
  ]);
  assert.equal(atmProfile(chains[0], 100).straddle, 5);
});

test('inferEarningsWindow encadre la publication par le saut de volatilité', () => {
  const maintenant = Date.UTC(2026, 8, 3);
  // Structure par terme calquée sur un cas réel : volatilité stable puis saut
  // net sur l'échéance qui englobe la publication.
  const chains = groupByExpiry([
    option('X261002C00100000', 4, 4.2, 0.325), option('X261002P00100000', 4, 4.2, 0.325),
    option('X261016C00100000', 5, 5.2, 0.333), option('X261016P00100000', 5, 5.2, 0.333),
    option('X261120C00100000', 8, 8.2, 0.375), option('X261120P00100000', 8, 8.2, 0.375),
    option('X261218C00100000', 9, 9.2, 0.371), option('X261218P00100000', 9, 9.2, 0.371),
  ]);

  const window = inferEarningsWindow(chains, 100, maintenant);
  assert.equal(window.after.toISOString().slice(0, 10), '2026-10-16');
  assert.equal(window.before.toISOString().slice(0, 10), '2026-11-20');
  assert.ok(window.ivJumpPoints > 4);
});

test('pickReference ignore une échéance sans volatilité cotée', () => {
  // Cas réel : une échéance fraîchement listée apparaît juste avant la
  // publication mais n'a pas encore de volatilité implicite. La retenir
  // comme référence ferait échouer la décomposition en silence.
  const chains = groupByExpiry([
    option('X261016C00100000', 5, 5.2, 0.333), option('X261016P00100000', 5, 5.2, 0.333),
    option('X261023C00100000', 0, 0, 0),       option('X261023P00100000', 0, 0, 0),
    option('X261120C00100000', 8, 8.2, 0.375), option('X261120P00100000', 8, 8.2, 0.375),
  ]);

  const choisie = pickReference(chains, new Date('2026-11-18T00:00:00Z'), Date.UTC(2026, 8, 3), 100);
  assert.equal(choisie.chain.expiry.toISOString().slice(0, 10), '2026-10-16',
    "l'échéance du 23 octobre, sans volatilité, doit être écartée");
  assert.equal(choisie.atm.iv, 0.333);
});

test('pickReference écarte les échéances postérieures à la publication', () => {
  const chains = groupByExpiry([
    option('X261120C00100000', 8, 8.2, 0.375), option('X261120P00100000', 8, 8.2, 0.375),
  ]);
  assert.equal(pickReference(chains, new Date('2026-11-18T00:00:00Z'), Date.UTC(2026, 8, 3), 100), null);
});

test('inferEarningsWindow ne conclut pas sur une structure plate', () => {
  const chains = groupByExpiry([
    option('X261002C00100000', 4, 4.2, 0.30), option('X261002P00100000', 4, 4.2, 0.30),
    option('X261016C00100000', 5, 5.2, 0.302), option('X261016P00100000', 5, 5.2, 0.302),
  ]);
  // Moins d'un point d'écart : aucun événement identifiable.
  assert.equal(inferEarningsWindow(chains, 100, Date.UTC(2026, 8, 3)), null);
});
