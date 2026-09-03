import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreHeadline, analyzeSentiment } from '../server/analysis/sentiment.js';

test('les titres nettement positifs et négatifs sont séparés', () => {
  assert.ok(scoreHeadline('Apple beats estimates, stock surges to record high').score > 0.5);
  assert.ok(scoreHeadline('Tesla shares plunge after lawsuit and recall').score < -0.5);
});

test('un titre sans terme du lexique reste neutre', () => {
  const r = scoreHeadline('Apple announces new iPad at September event');
  assert.equal(r.score, 0);
  assert.deepEqual(r.matches, []);
});

test('la négation inverse le signe du terme', () => {
  const nie = scoreHeadline('Company fails to beat expectations');
  assert.ok(nie.score < 0, `attendu négatif, obtenu ${nie.score}`);
  assert.equal(nie.matches[0].term, 'beat');
  assert.equal(nie.matches[0].negated, true);
});

test('chaque score est justifié par les termes relevés', () => {
  // Un score de tonalité qu'on ne peut pas auditer n'a aucune valeur.
  const r = scoreHeadline('Nvidia downgraded as analysts warn of weak demand');
  assert.deepEqual(r.matches.map((m) => m.term).sort(), ['demand', 'downgraded', 'weak']);
});

test('le score reste borné même en accumulant les signaux', () => {
  const extreme = scoreHeadline('beats beats surges soars record upgrade rally jumps');
  assert.ok(extreme.score <= 1 && extreme.score >= -1);
});

test('la tonalité agrégée pondère par la fraîcheur', () => {
  const maintenant = new Date('2026-09-03T12:00:00Z');
  const recent = [
    { title: 'Stock surges after beats', publishedAt: new Date('2026-09-03T09:00:00Z') },
    { title: 'Shares plunge on lawsuit', publishedAt: new Date('2026-07-01T09:00:00Z') },
  ];
  // La bonne nouvelle est du jour, la mauvaise a deux mois : l'agrégat penche positif.
  assert.ok(analyzeSentiment(recent, maintenant).overall > 0);

  const inverse = [
    { title: 'Stock surges after beats', publishedAt: new Date('2026-07-01T09:00:00Z') },
    { title: 'Shares plunge on lawsuit', publishedAt: new Date('2026-09-03T09:00:00Z') },
  ];
  assert.ok(analyzeSentiment(inverse, maintenant).overall < 0);
});

test('les compteurs et la confiance suivent le volume de signal', () => {
  const maintenant = new Date('2026-09-03T12:00:00Z');
  const articles = [
    { title: 'Apple beats estimates', publishedAt: maintenant },
    { title: 'Apple stock plunges', publishedAt: maintenant },
    { title: 'Apple opens a new store', publishedAt: maintenant },
  ];
  const r = analyzeSentiment(articles, maintenant);
  assert.equal(r.counts.total, 3);
  assert.equal(r.counts.positive, 1);
  assert.equal(r.counts.negative, 1);
  assert.equal(r.counts.neutral, 1);
  assert.equal(r.counts.withSignal, 2);
  assert.ok(r.confidence > 0 && r.confidence <= 1);
});

test('une liste vide ne produit pas de tonalité', () => {
  assert.equal(analyzeSentiment([]), null);
  assert.equal(analyzeSentiment(null), null);
});
