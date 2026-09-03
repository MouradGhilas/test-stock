import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerdict } from '../server/analysis/verdict.js';
import { projectNextEarnings } from '../server/sources/nasdaq.js';
import { daysBetween } from '../server/core/parse.js';

const MAINTENANT = new Date('2026-09-03T00:00:00Z');
const jour = (iso) => new Date(`${iso}T00:00:00Z`);

/** Dossier complet et favorable, dont chaque test ne modifie que ce qu il examine. */
function faits(surcharge = {}) {
  return {
    ticker: 'TEST',
    now: MAINTENANT,
    quote: { price: 100, companyName: 'Test Corp' },
    summary: { marketCap: 50e9, averageVolume: 5_000_000 },
    indicators: {
      lastClose: 100, sessions: 250, sma50: 92, sma200: 85, rsi14: 55,
      realizedVol30: 25, perf21: 4, perf63: 12,
    },
    surprises: [
      { fiscalQuarter: 'Jun 2026', reportedAt: jour('2026-06-15'), surprisePercent: 6 },
      { fiscalQuarter: 'Mar 2026', reportedAt: jour('2026-03-15'), surprisePercent: 5 },
      { fiscalQuarter: 'Dec 2025', reportedAt: jour('2025-12-15'), surprisePercent: 8 },
      { fiscalQuarter: 'Sep 2025', reportedAt: jour('2025-09-15'), surprisePercent: 4 },
    ],
    forecast: { quarterly: [{ period: 'Sep 2026', consensus: 2, estimates: 10, revisionsUp: 4, revisionsDown: 0 }] },
    ratings: { consensus: 'Strong Buy', analystCount: 20 },
    shortInterest: [
      { settlementDate: jour('2026-08-14'), shares: 900_000, daysToCover: 2 },
      { settlementDate: jour('2026-07-31'), shares: 1_200_000, daysToCover: 2.5 },
    ],
    institutional: { institutionalOwnershipPercent: 70, increasedHolders: 900, decreasedHolders: 300 },
    options: { impliedMovePercent: 3, method: 'decomposition' },
    reactions: {
      count: 4, medianAbsMove: 4, maxAbsMove: 6, worstDrop: 6, medianMove: 3,
      positiveRate: 0.8, timing: 'after-close', timingResolution: 'inferred',
      events: [{ reactionDate: jour('2026-06-16'), reactionPercent: 3.2 }],
    },
    sentiment: { overall: 0.4, confidence: 0.8, counts: { total: 20, positive: 9, negative: 2, neutral: 9 } },
    earningsDate: { date: jour('2026-09-15'), timing: 'after-close', confidence: 'confirmed' },
    optionsWindowConflict: false,
    ...surcharge,
  };
}

test('un dossier solide à quinze jours de la publication conclut à l entrée', () => {
  const d = buildVerdict(faits());
  assert.equal(d.verdict, 'ENTRER');
  assert.ok(d.score > 30, `score ${d.score}`);
  assert.ok(d.coverage > 0.9);
  assert.equal(d.daysToEarnings, 12);
});

test('les poids somment à 100 et chaque facteur est renseigné', () => {
  const d = buildVerdict(faits());
  assert.equal(d.factors.reduce((a, f) => a + f.weight, 0), 100);
  assert.equal(d.factors.length, 10);
  for (const f of d.factors) {
    assert.ok(f.score >= -100 && f.score <= 100, `${f.id} hors bornes`);
    assert.ok(f.confidence >= 0 && f.confidence <= 1);
    assert.ok(typeof f.summary === 'string' && f.summary.length > 0, `${f.id} sans explication`);
  }
});

test('sans date de publication, il n y a pas de pari pré-résultats', () => {
  const d = buildVerdict(faits({ earningsDate: null }));
  assert.equal(d.verdict, 'NEUTRE');
  assert.ok(d.warnings.some((w) => w.includes('Aucune date de publication')));
});

test('une publication trop lointaine sort de la fenêtre de positionnement', () => {
  const d = buildVerdict(faits({
    earningsDate: { date: jour('2026-11-20'), timing: 'unknown', confidence: 'confirmed' },
  }));
  assert.equal(d.verdict, 'NEUTRE');
  assert.ok(d.warnings.some((w) => w.includes('trop loin')));
});

test('un mouvement implicite extrême plafonne le verdict', () => {
  const d = buildVerdict(faits({
    options: { impliedMovePercent: 15, method: 'decomposition' },
    reactions: { ...faits().reactions, medianAbsMove: 14 },
  }));
  assert.equal(d.verdict, 'ENTREE_PRUDENTE');
  assert.ok(d.warnings.some((w) => w.includes('gap')));
});

test('un titre illiquide est écarté quels que soient les autres signaux', () => {
  const d = buildVerdict(faits({ summary: { marketCap: 100e6, averageVolume: 30_000 } }));
  assert.equal(d.verdict, 'NEUTRE');
  assert.ok(d.warnings.some((w) => w.includes('liquide')));
});

test('une couverture insuffisante empêche de conclure', () => {
  const d = buildVerdict({
    ...faits(),
    indicators: null, surprises: [], forecast: null, ratings: null,
    shortInterest: null, institutional: null, options: null, reactions: null, sentiment: null,
  });
  assert.equal(d.verdict, 'DONNEES_INSUFFISANTES');
  assert.ok(d.coverage < 0.45);
  assert.ok(d.plan.steps.some((s) => s.includes('Compléter')));
});

test('une source absente réduit la confiance sans pénaliser le titre', () => {
  const complet = buildVerdict(faits());
  const sansActus = buildVerdict(faits({ sentiment: null }));
  // La tonalité était positive : la retirer baisse la couverture, mais le
  // score reste porté par les facteurs disponibles au lieu d etre puni.
  assert.ok(sansActus.coverage < complet.coverage);
  assert.equal(sansActus.factors.find((f) => f.id === 'newsSentiment').confidence, 0);
  assert.ok(sansActus.score > 25, `score ${sansActus.score}`);
});

test('un dossier dégradé conduit à éviter', () => {
  const d = buildVerdict(faits({
    options: { impliedMovePercent: 9, method: 'decomposition' },
    reactions: {
      count: 4, medianAbsMove: 3, maxAbsMove: 11, worstDrop: 11, medianMove: -4,
      positiveRate: 0.25, timing: 'after-close', timingResolution: 'inferred', events: [],
    },
    surprises: [
      { fiscalQuarter: 'Jun 2026', reportedAt: jour('2026-06-15'), surprisePercent: -8 },
      { fiscalQuarter: 'Mar 2026', reportedAt: jour('2026-03-15'), surprisePercent: -3 },
    ],
    forecast: { quarterly: [{ period: 'Sep 2026', consensus: 1, estimates: 8, revisionsUp: 0, revisionsDown: 5 }] },
    ratings: { consensus: 'Sell', analystCount: 12 },
    indicators: { ...faits().indicators, sma50: 120, sma200: 130, rsi14: 28, perf21: -20, perf63: -35 },
    sentiment: { overall: -0.6, confidence: 0.9, counts: { total: 20, positive: 2, negative: 12, neutral: 6 } },
  }));
  assert.equal(d.verdict, 'EVITER');
  assert.ok(d.score < -15, `score ${d.score}`);
});

test('un désaccord avec le marché options rend la date suspecte', () => {
  const d = buildVerdict(faits({
    earningsDate: { date: jour('2026-09-15'), timing: 'unknown', confidence: 'estimated' },
    optionsWindowConflict: true,
  }));
  assert.equal(d.verdict, 'ENTREE_PRUDENTE');
  assert.ok(d.warnings.some((w) => w.includes('méfiance')));
});

test('le plan chiffre le scénario adverse à supporter', () => {
  const d = buildVerdict(faits());
  // Le pire des deux : mouvement implicite (3 %) ou pire baisse passée (6 %).
  assert.equal(d.plan.expectedDownsidePercent, 6);
  assert.equal(d.plan.referencePrice, 100);
  assert.ok(d.plan.steps.some((s) => s.includes('stop')));
});

test('la projection de date s ancre sur le même trimestre un an plus tôt', () => {
  // NVDA : les écarts entre publications sont irréguliers (98, 84, 98 jours),
  // la cadence médiane place la publication trois semaines trop tard.
  const nvda = ['2026-08-26', '2026-05-20', '2026-02-25', '2025-11-19']
    .map((iso) => ({ reportedAt: jour(iso) }));
  const r = projectNextEarnings(nvda, MAINTENANT);
  assert.equal(r.date.toISOString().slice(0, 10), '2026-11-18');
  assert.equal(r.basis, 'annuel');
});

test('sans quatre trimestres, la projection retombe sur la cadence', () => {
  const court = ['2026-07-30', '2026-04-30'].map((iso) => ({ reportedAt: jour(iso) }));
  const r = projectNextEarnings(court, MAINTENANT);
  assert.equal(r.basis, 'cadence');
  assert.ok(r.date > MAINTENANT);
  assert.ok(![0, 6].includes(r.date.getUTCDay()), 'ne doit pas tomber un week-end');
});

test('une publication imminente n est pas repoussée d un trimestre', () => {
  // Cas Zscaler : publication le 2 septembre une année, le 3 la suivante.
  // L'ancrage annuel tombe donc la veille de la vraie date. Avancer d'un
  // trimestre ferait disparaître la publication du jour même -- c'est
  // exactement ce que faisait le garde-fou destiné aux historiques périmés.
  const zs = ['2026-05-26', '2026-02-26', '2025-11-25', '2025-09-02']
    .map((iso) => ({ reportedAt: jour(iso) }));

  const r = projectNextEarnings(zs, MAINTENANT); // 3 septembre 2026
  assert.equal(r.date.toISOString().slice(0, 10), '2026-09-01');
  assert.equal(r.basis, 'annuel');
  // La date reste dans la fenêtre où la confirmation par le calendrier
  // officiel peut encore retrouver la vraie publication.
  assert.ok(Math.abs(daysBetween(MAINTENANT, r.date)) <= 10);
});

test('une publication tout juste effectuée passe bien au trimestre suivant', () => {
  // Même configuration, mais la société vient de publier : la projection
  // doit cette fois avancer, sans quoi on proposerait une date révolue.
  const rapports = ['2026-09-02', '2026-05-26', '2026-02-26', '2025-09-02']
    .map((iso) => ({ reportedAt: jour(iso) }));

  const r = projectNextEarnings(rapports, MAINTENANT);
  assert.ok(r.date > MAINTENANT, `attendu une date future, obtenu ${r.date.toISOString()}`);
});

test('la projection ne renvoie jamais une date passée', () => {
  const vieux = ['2024-07-30', '2024-04-30', '2024-01-30', '2023-10-30']
    .map((iso) => ({ reportedAt: jour(iso) }));
  assert.ok(projectNextEarnings(vieux, MAINTENANT).date >= MAINTENANT);
  assert.equal(projectNextEarnings([], MAINTENANT), null);
});
