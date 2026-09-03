import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toNumber, parseDate, toISODate, daysBetween, decodeEntities, stripTags, normalizeTicker,
} from '../server/core/parse.js';
import { cleanCompanyName } from '../server/sources/news.js';

test('toNumber normalise les formats affichés par les sources', () => {
  assert.equal(toNumber('$1,234.56'), 1234.56);
  assert.equal(toNumber('3.21%'), 3.21);
  assert.equal(toNumber('(2.5)'), -2.5);
  assert.equal(toNumber('1.2B'), 1.2e9);
  assert.equal(toNumber('54,536,427'), 54536427);
  assert.equal(toNumber(42), 42);
});

test('toNumber rejette les valeurs non renseignées', () => {
  for (const value of ['N/A', '--', '', null, undefined, 'abc', NaN]) {
    assert.equal(toNumber(value), null, `attendu null pour ${JSON.stringify(value)}`);
  }
});

test('parseDate accepte les trois formats rencontrés', () => {
  assert.equal(toISODate(parseDate('09/08/2026')), '2026-09-08');
  assert.equal(toISODate(parseDate('Sep 24, 2026')), '2026-09-24');
  assert.equal(toISODate(parseDate('2026-09-08')), '2026-09-08');
  assert.equal(parseDate('pas une date du tout'), null);
});

test('daysBetween compte les jours calendaires, signe compris', () => {
  assert.equal(daysBetween(parseDate('2026-09-01'), parseDate('2026-09-08')), 7);
  assert.equal(daysBetween(parseDate('2026-09-08'), parseDate('2026-09-01')), -7);
  assert.equal(daysBetween(parseDate('2026-09-08'), parseDate('2026-09-08')), 0);
});

test('decodeEntities et stripTags nettoient le XML des flux', () => {
  assert.equal(decodeEntities('AT&amp;T &quot;beats&quot;'), 'AT&T "beats"');
  assert.equal(decodeEntities('<![CDATA[Titre]]>'), 'Titre');
  assert.equal(stripTags('<b>Apple</b>   <i>surges</i>'), 'Apple surges');
});

test('normalizeTicker accepte les tickers valides et rejette le reste', () => {
  assert.equal(normalizeTicker(' aapl '), 'AAPL');
  assert.equal(normalizeTicker('BRK.B'), 'BRK.B');
  for (const bad of ['<script>', '', '1AAPL', 'TROPLONGTICKER', 'a b']) {
    assert.equal(normalizeTicker(bad), null, `attendu null pour ${JSON.stringify(bad)}`);
  }
});

test('cleanCompanyName retire les suffixes de cotation', () => {
  assert.equal(cleanCompanyName('Apple Inc. Common Stock'), 'Apple Inc.');
  assert.equal(cleanCompanyName('Alphabet Inc. Class A Common Stock'), 'Alphabet Inc.');
  assert.equal(cleanCompanyName('Banco Santander, S.A. American Depositary Shares'), 'Banco Santander, S.A.');
  assert.equal(cleanCompanyName(null), null);
});
