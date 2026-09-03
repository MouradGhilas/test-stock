import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAnticipation } from '../server/analysis/anticipation.js';
import { volumeSurge } from '../server/analysis/indicators.js';

/** Dossier neutre : chaque test ne modifie que le signal qu'il examine. */
function faits(surcharge = {}) {
  return {
    quote: { price: 100 },
    summary: { oneYearTarget: 115 },
    indicators: {
      perf5: 1,
      realizedVol30: 30,
      volumeSurge: { ratio: 1, recentAverage: 1e6, baseline: 1e6 },
    },
    reactions: { medianRunUp: 1, runUpStdev: 2, runUps: [1, 2, 0, 1, 3, 0.5] },
    options: { iv30: 33, putCallOpenInterest: 0.9, atmImpliedVol: 0.35 },
    forecast: { quarterly: [{ revisionsUp: 0, revisionsDown: 0 }] },
    impliedHistory: [],
    ...surcharge,
  };
}

const signal = (a, id) => a.signals.find((s) => s.id === id);

test('un dossier sans tension particulière ressort peu anticipé', () => {
  const a = analyzeAnticipation(faits());
  assert.equal(a.level, 'faible');
  assert.ok(a.score < 30, `score ${a.score}`);
  assert.ok(a.coverage > 0.7);
});

test('le parcours se juge par rapport aux habitudes du titre, pas dans l absolu', () => {
  // +9 % en cinq séances quand la société fait habituellement +1 % avec un
  // écart-type de 2 : quatre écarts-types au-dessus de sa norme.
  const fort = analyzeAnticipation(faits({
    indicators: { ...faits().indicators, perf5: 9 },
  }));
  assert.ok(signal(fort, 'runUp').anticipation > 80, signal(fort, 'runUp').reading);

  // Le même +9 % sur un titre qui monte habituellement de 8 % avant ses
  // résultats n'a rien d'exceptionnel.
  const habituel = analyzeAnticipation(faits({
    indicators: { ...faits().indicators, perf5: 9 },
    reactions: { medianRunUp: 8, runUpStdev: 2, runUps: [8, 7, 9, 8, 10, 7] },
  }));
  assert.ok(signal(habituel, 'runUp').anticipation < 40, signal(habituel, 'runUp').reading);
});

test('le parcours n est pas jugé sans référence historique suffisante', () => {
  const a = analyzeAnticipation(faits({
    reactions: { medianRunUp: 1, runUpStdev: 2, runUps: [1, 2] },
  }));
  assert.equal(signal(a, 'runUp').available, false);
  assert.equal(signal(a, 'runUp').anticipation, null);
});

test('un volume qui double signale un positionnement en cours', () => {
  const a = analyzeAnticipation(faits({
    indicators: { ...faits().indicators, volumeSurge: { ratio: 2.1 } },
  }));
  assert.ok(signal(a, 'volume').anticipation > 65);
  assert.match(signal(a, 'volume').reading, /se positionnent déjà/);
});

test('la tension de volatilité compare deux mesures de même horizon', () => {
  // Piège : à la veille d'une publication, la volatilité implicite de
  // l'échéance retenue porte sur une option d'un jour et dépasse les 200 %.
  // La rapporter à une volatilité mensuelle saturerait le signal pour toute
  // société publiant sous 48 heures. Seule la volatilité à 30 jours convient.
  const a = analyzeAnticipation(faits({
    options: { ...faits().options, atmImpliedVol: 2.23, iv30: 33 },
    indicators: { ...faits().indicators, realizedVol30: 30 },
  }));

  const s = signal(a, 'volPremium');
  assert.ok(s.anticipation < 20, `attendu un signal calme, obtenu ${s.anticipation}`);
  assert.equal(s.detail.impliedVol30, 33);
  assert.equal(s.detail.ratio, 1.1);
});

test('un cours au-dessus de l objectif analystes marque un potentiel consommé', () => {
  const consomme = analyzeAnticipation(faits({ summary: { oneYearTarget: 95 } }));
  assert.ok(signal(consomme, 'target').anticipation > 80);
  assert.match(signal(consomme, 'target').reading, /consommé/);

  const marge = analyzeAnticipation(faits({ summary: { oneYearTarget: 130 } }));
  assert.ok(signal(marge, 'target').anticipation < 30);
});

test('des estimations relevées comptent comme une barre déjà montée', () => {
  const a = analyzeAnticipation(faits({
    forecast: { quarterly: [{ revisionsUp: 5, revisionsDown: 0 }] },
  }));
  assert.ok(signal(a, 'revisions').anticipation >= 90);

  // À l'inverse, des abaissements rendent la bonne surprise plus accessible.
  const abaisse = analyzeAnticipation(faits({
    forecast: { quarterly: [{ revisionsUp: 0, revisionsDown: 3 }] },
  }));
  assert.equal(signal(abaisse, 'revisions').anticipation, 0);
});

test('la montée du mouvement implicite se lit sur les observations archivées', () => {
  const a = analyzeAnticipation(faits({
    impliedHistory: [
      { at: '2026-08-22T10:00:00Z', impliedMovePercent: 6 },
      { at: '2026-09-03T10:00:00Z', impliedMovePercent: 11 },
    ],
  }));

  const s = signal(a, 'impliedTrend');
  assert.ok(s.anticipation > 90, `obtenu ${s.anticipation}`);
  assert.match(s.reading, /renchérit l'événement/);
  assert.equal(s.detail.days, 12);
});

test('une seule observation ne produit pas de tendance', () => {
  const a = analyzeAnticipation(faits({
    impliedHistory: [{ at: '2026-09-03T10:00:00Z', impliedMovePercent: 6 }],
  }));
  assert.equal(signal(a, 'impliedTrend').available, false);
  assert.match(signal(a, 'impliedTrend').reading, /Première observation/);
});

test('un dossier entièrement anticipé le dit franchement', () => {
  const a = analyzeAnticipation(faits({
    indicators: { perf5: 14, realizedVol30: 25, volumeSurge: { ratio: 3 } },
    summary: { oneYearTarget: 88 },
    options: { iv30: 60, putCallOpenInterest: 0.35 },
    forecast: { quarterly: [{ revisionsUp: 6, revisionsDown: 0 }] },
    impliedHistory: [
      { at: '2026-08-20T10:00:00Z', impliedMovePercent: 4 },
      { at: '2026-09-03T10:00:00Z', impliedMovePercent: 11 },
    ],
  }));

  assert.equal(a.level, 'extreme');
  assert.ok(a.score > 75, `score ${a.score}`);
  assert.match(a.summary, /déjà construit/);
});

test('sans aucun signal exploitable, le module refuse de conclure', () => {
  const a = analyzeAnticipation({
    quote: null, summary: null, indicators: null,
    reactions: null, options: null, forecast: null, impliedHistory: [],
  });
  assert.equal(a.score, null);
  assert.equal(a.coverage, 0);
  assert.match(a.summary, /Trop peu de signaux/);
});

test('volumeSurge compare les séances récentes au régime habituel', () => {
  const bars = (volumes) =>
    volumes.map((volume, i) => ({
      date: new Date(Date.UTC(2026, 0, i + 1)),
      open: 10, high: 10, low: 10, close: 10, volume,
    }));

  // Soixante séances à un million, puis cinq à deux millions.
  const surge = volumeSurge(bars([...Array(60).fill(1e6), ...Array(5).fill(2e6)]));
  assert.equal(surge.ratio, 2);

  // Un pic isolé dans la référence ne doit pas masquer l'afflux : la médiane
  // du régime habituel résiste là où une moyenne se laisserait tirer.
  const avecPic = volumeSurge(bars([...Array(59).fill(1e6), 50e6, ...Array(5).fill(2e6)]));
  assert.equal(avecPic.ratio, 2);

  assert.equal(volumeSurge(bars(Array(10).fill(1e6))), null, 'historique trop court');
});
