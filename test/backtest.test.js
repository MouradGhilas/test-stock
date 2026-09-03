import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObservations, summarize, interpret } from '../server/backtest.js';

const jour = (iso) => new Date(`${iso}T00:00:00Z`);

/** Série quotidienne synthétique : n séances ouvrées à partir d une date. */
function serie(start, closes) {
  const bars = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (const close of closes) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    bars.push({ date: new Date(d), open: close, high: close, low: close, close, volume: 1000 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return bars;
}

/** Historique long et régulier, avec une publication tous les 63 jours ouvrés. */
function scenario({ reactionAt = 'after-close' } = {}) {
  const closes = Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 11) * 5 + i * 0.05);
  const bars = serie('2024-01-01', closes);
  const reports = [];
  for (let i = 63; i < bars.length - 2; i += 63) {
    reports.push({ reportedAt: bars[i].date, timing: reactionAt });
  }
  return { bars, reports };
}

test('chaque observation associe un score et une réaction mesurée', () => {
  const { bars, reports } = scenario();
  const obs = buildObservations(bars, reports, { entrySessions: 3 });

  assert.ok(obs.length >= 2, `attendu au moins 2 observations, obtenu ${obs.length}`);
  for (const o of obs) {
    assert.equal(typeof o.score, 'number');
    assert.equal(typeof o.reactionPercent, 'number');
    assert.equal(typeof o.holdPercent, 'number');
    assert.ok(o.priorCount >= 3, 'le facteur historique exige des publications antérieures');
  }
});

test('aucune observation ne se sert de données postérieures à la décision', () => {
  // Propriété centrale du harnais : truquer le futur ne doit rien changer.
  // Si un score bougeait, c'est qu'il aurait regardé après la coupure.
  const { bars, reports } = scenario();
  const reference = buildObservations(bars, reports, { entrySessions: 3 });

  const premiere = reference[0];
  const indexReaction = bars.findIndex(
    (b) => b.date.toISOString().slice(0, 10) === premiere.reactionDate,
  );

  // On multiplie par dix tout ce qui suit la séance de réaction.
  const truque = bars.map((b, i) =>
    i > indexReaction ? { ...b, open: b.open * 10, high: b.high * 10, low: b.low * 10, close: b.close * 10 } : b,
  );

  const apres = buildObservations(truque, reports, { entrySessions: 3 });
  assert.equal(apres[0].score, premiere.score, 'le score ne doit dépendre que du passé');
  assert.equal(apres[0].reactionPercent, premiere.reactionPercent);
});

test('la séance de réaction suit l horaire de publication', () => {
  const apres = buildObservations(...Object.values(scenario({ reactionAt: 'after-close' })), {});
  const avant = buildObservations(...Object.values(scenario({ reactionAt: 'before-open' })), {});

  // Même date de publication, séance de réaction décalée d une séance.
  assert.equal(apres[0].reportedAt, avant[0].reportedAt);
  assert.ok(apres[0].reactionDate > avant[0].reactionDate,
    `après clôture doit réagir plus tard : ${apres[0].reactionDate} vs ${avant[0].reactionDate}`);
});

test('une publication sans historique suffisant est écartée', () => {
  const { bars } = scenario();
  // Trois publications seulement : la règle exige trois antécédents, donc
  // aucune n en dispose.
  const reports = [63, 126, 189].map((i) => ({ reportedAt: bars[i].date, timing: 'after-close' }));
  assert.equal(buildObservations(bars, reports, {}).length, 0);
});

test('buildObservations ne plante pas sur des entrées vides', () => {
  assert.deepEqual(buildObservations([], [], {}), []);
  assert.deepEqual(buildObservations(null, null, {}), []);
});

test('summarize calcule référence, corrélations et tranches', () => {
  const obs = Array.from({ length: 100 }, (_, i) => ({
    score: i - 50,
    // Relation volontairement parfaite : le résumé doit la détecter.
    reactionPercent: (i - 50) / 10,
    holdPercent: (i - 50) / 10,
  }));

  const s = summarize(obs, { buckets: 5 });
  assert.equal(s.n, 100);
  assert.ok(s.correlation.pearsonReaction > 0.99);
  assert.equal(s.buckets.length, 5);
  assert.ok(s.buckets[4].meanReaction > s.buckets[0].meanReaction);
  assert.ok(s.spread.difference > 0);
  assert.ok(s.spread.tStat > 2, 'une relation parfaite doit ressortir du bruit');
});

test('summarize ne voit pas de signal là où il n y en a pas', () => {
  // Score et résultat indépendants : l écart entre tranches doit rester
  // dans le bruit, et la lecture doit le dire.
  let graine = 42;
  const alea = () => {
    graine = (graine * 1103515245 + 12345) % 2147483648;
    return graine / 2147483648;
  };
  const obs = Array.from({ length: 400 }, () => ({
    score: alea() * 100 - 50,
    reactionPercent: (alea() - 0.5) * 12,
    holdPercent: (alea() - 0.5) * 12,
  }));

  const s = summarize(obs, { buckets: 5 });
  assert.ok(Math.abs(s.spread.tStat) < 2, `t = ${s.spread.tStat}`);
  assert.match(interpret(s), /ne se distingue pas du hasard/);
});

test('summarize refuse de conclure sans observation', () => {
  assert.equal(summarize([]), null);
  assert.match(interpret(null), /rien à conclure/);
});
