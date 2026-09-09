import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enrich, summarize, traderScoreboard, suggestQuantity, defaultStop, tradePlan,
} from '../server/portfolio/positions.js';

const SETTINGS = { capital: 10_000, riskPerTradePct: 1, currency: 'USD' };

/** Position minimale, complétée par le cas de test. */
function trade(over = {}) {
  return {
    id: over.id || 't_1',
    ticker: 'NVDA',
    side: 'long',
    status: 'open',
    quantity: 10,
    entry: 100,
    stop: 95,
    initialStop: 95,
    targets: [110],
    exit: null,
    openedAt: '2026-09-01T14:00:00.000Z',
    closedAt: null,
    source: { handle: '@trader', url: null, text: null },
    note: null,
    ...over,
  };
}

const codes = (position) => position.alerts.map((a) => a.code);

/* --- Arithmétique de base --- */

test('un achat gagnant se compte en euros, en pourcentage et en R', () => {
  const p = enrich(trade(), { price: 105, settings: SETTINGS });
  assert.equal(p.pnl, 50, '(105 - 100) x 10');
  assert.equal(p.pnlPercent, 5);
  assert.equal(p.riskAmount, 50, '5 de risque par titre, 10 titres');
  assert.equal(p.rMultiple, 1, 'le gain vaut exactement une unité de risque');
  assert.equal(p.value, 1050);
});

test('une vente à découvert gagne quand le prix baisse', () => {
  const p = enrich(trade({ side: 'short', entry: 100, stop: 105, initialStop: 105, targets: [90] }), {
    price: 95,
    settings: SETTINGS,
  });
  assert.equal(p.pnl, 50);
  assert.equal(p.rMultiple, 1);
  assert.equal(p.stopDistancePercent, 10.53, 'le stop est 10,5 % au-dessus du prix');
});

test('sans cotation, la ligne reste affichable et le dit', () => {
  const p = enrich(trade(), { price: null, settings: SETTINGS });
  assert.equal(p.pnl, null);
  assert.equal(p.value, null);
  assert.ok(codes(p).includes('no-price'));
});

test('une position soldée se valorise à son prix de sortie', () => {
  const p = enrich(trade({ status: 'closed', exit: 112, closedAt: '2026-09-05T14:00:00.000Z' }), {
    price: 999,
    settings: SETTINGS,
  });
  assert.equal(p.pnl, 120, 'le prix du jour n entre pas dans le calcul');
  assert.equal(p.rMultiple, 2.4);
  assert.deepEqual(p.alerts, [], 'une ligne soldée ne réclame plus rien');
});

/* --- Le stop et ce qu'il borne --- */

test('un stop remonté à l équilibre annule le risque sans fausser le R', () => {
  const p = enrich(trade({ stop: 100, initialStop: 95 }), { price: 108, settings: SETTINGS });
  assert.equal(p.riskAmount, 0, 'plus rien à perdre au stop');
  assert.equal(p.rMultiple, 1.6, 'le R reste mesuré contre le risque initial');
});

test('un stop passé au-dessus de l entrée verrouille un gain', () => {
  const p = enrich(trade({ stop: 104, initialStop: 95 }), { price: 108, settings: SETTINGS });
  assert.equal(p.riskAmount, 0);
  assert.equal(p.lockedIn, 40, '(104 - 100) x 10 acquis si le stop est touché');
});

test('un stop franchi est signalé comme tel', () => {
  const p = enrich(trade(), { price: 94, settings: SETTINGS });
  assert.ok(codes(p).includes('stop-hit'));
  assert.ok(p.stopDistancePercent < 0);
});

test('une ligne sans stop porte un risque non borné', () => {
  const p = enrich(trade({ stop: null, initialStop: null }), { price: 105, settings: SETTINGS });
  assert.equal(p.riskAmount, null);
  assert.equal(p.rMultiple, null);
  assert.ok(codes(p).includes('no-stop'));
});

test('un objectif atteint et un gain acquis appellent une décision', () => {
  const p = enrich(trade(), { price: 111, settings: SETTINGS });
  assert.ok(codes(p).includes('target-hit'));
  assert.ok(codes(p).includes('to-breakeven'), '+2,2 R acquis, le stop peut être sécurisé');
});

test('un signal qui offre moins d un pour un est signalé', () => {
  const p = enrich(trade({ targets: [103] }), { price: 100, settings: SETTINGS });
  assert.equal(p.rewardRisk, 0.6);
  assert.ok(codes(p).includes('poor-rr'));
});

/* --- Positions en veille --- */

test('une veille compare le prix du jour à celui du signal', () => {
  const p = enrich(trade({ status: 'watch', quantity: null }), { price: 106, settings: SETTINGS });
  assert.equal(p.pnl, null, 'rien n est engagé');
  assert.equal(p.drift, 6);
  assert.ok(codes(p).includes('missed-entry'));
  assert.ok(codes(p).includes('poor-rr-now'), "entrer à 106 pour viser 110 n'a plus de sens");
});

/* --- Vue d'ensemble --- */

test('le portefeuille additionne exposition, risque et latent', () => {
  const positions = [
    enrich(trade({ id: 'a' }), { price: 105, settings: SETTINGS }),
    enrich(trade({ id: 'b', ticker: 'AMD', entry: 200, stop: 190, initialStop: 190, quantity: 5, targets: [220] }), {
      price: 210,
      settings: SETTINGS,
    }),
  ];
  const s = summarize(positions, { settings: SETTINGS });

  assert.equal(s.counts.open, 2);
  assert.equal(s.exposure, 1050 + 1050);
  assert.equal(s.unrealized, 50 + 50);
  assert.equal(s.risk.bounded, 50 + 50, 'somme des pertes si les deux stops sautent');
  assert.equal(s.risk.percent, 1);
  assert.equal(s.risk.withoutStop, 0);
});

test('une ligne sans stop est comptée à part, jamais dans le risque borné', () => {
  const positions = [
    enrich(trade({ id: 'a' }), { price: 105, settings: SETTINGS }),
    enrich(trade({ id: 'b', ticker: 'AMD', stop: null, initialStop: null }), { price: 105, settings: SETTINGS }),
  ];
  const s = summarize(positions, { settings: SETTINGS });

  assert.equal(s.risk.bounded, 50, 'seule la ligne avec stop est chiffrable');
  assert.equal(s.risk.withoutStop, 1);
  assert.equal(s.risk.unboundedExposure, 1050);
  assert.ok(s.alerts.some((a) => a.code === 'unbounded-risk'));
});

test('le risque global au-delà de la limite déclenche une alerte', () => {
  const positions = Array.from({ length: 8 }, (_, i) =>
    enrich(trade({ id: `t${i}`, ticker: `T${i}`, quantity: 20 }), { price: 100, settings: SETTINGS }),
  );
  const s = summarize(positions, { settings: SETTINGS });
  assert.equal(s.risk.bounded, 800, '8 lignes à 100 de risque');
  assert.ok(s.alerts.some((a) => a.code === 'portfolio-risk'));
});

test('la concentration par ticker et par compte est mesurée', () => {
  const positions = [
    enrich(trade({ id: 'a', ticker: 'NVDA', quantity: 30 }), { price: 100, settings: SETTINGS }),
    enrich(trade({ id: 'b', ticker: 'AMD', quantity: 2, source: { handle: '@autre' } }), {
      price: 100,
      settings: SETTINGS,
    }),
  ];
  const s = summarize(positions, { settings: SETTINGS });

  assert.equal(s.concentration.byTicker[0].key, 'NVDA');
  assert.equal(s.concentration.byTicker[0].sharePercent, 93.8);
  assert.ok(s.alerts.some((a) => a.code === 'ticker-concentration'));
  assert.ok(s.alerts.some((a) => a.code === 'trader-concentration'));
});

/* --- Bilan par compte suivi --- */

test('un compte au bilan court n est pas jugé', () => {
  const positions = [
    enrich(trade({ id: 'a', status: 'closed', exit: 110, closedAt: '2026-09-02T00:00:00.000Z' }), { settings: SETTINGS }),
    enrich(trade({ id: 'b', status: 'closed', exit: 90, closedAt: '2026-09-03T00:00:00.000Z' }), { settings: SETTINGS }),
  ];
  const [compte] = traderScoreboard(positions);

  assert.equal(compte.handle, '@trader');
  assert.equal(compte.closed, 2);
  assert.equal(compte.winRate, 50);
  assert.equal(compte.verdict.label, 'échantillon trop court');
  assert.match(compte.verdict.note, /chance/);
});

test('un compte à la performance dispersée reste indécidable', () => {
  // Douze trades soldés, alternance de gros gains et de grosses pertes : la
  // moyenne est positive mais l écart-type l avale.
  const positions = Array.from({ length: 12 }, (_, i) =>
    enrich(
      trade({
        id: `t${i}`,
        status: 'closed',
        exit: i % 2 === 0 ? 130 : 80,
        closedAt: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
      { settings: SETTINGS },
    ),
  );
  const [compte] = traderScoreboard(positions);

  assert.equal(compte.closed, 12);
  assert.equal(compte.verdict.label, 'indécidable');
});

test('un compte régulièrement gagnant finit par être reconnu', () => {
  const positions = Array.from({ length: 12 }, (_, i) =>
    enrich(
      trade({ id: `t${i}`, status: 'closed', exit: 106, closedAt: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }),
      { settings: SETTINGS },
    ),
  );
  const [compte] = traderScoreboard(positions);

  assert.equal(compte.avgR, 1.2);
  assert.equal(compte.verdict.label, 'positif');
});

test('les positions sans auteur sont regroupées à part', () => {
  const positions = [enrich(trade({ source: { handle: null } }), { price: 105, settings: SETTINGS })];
  assert.equal(traderScoreboard(positions)[0].handle, 'signal sans auteur');
});

/* --- Calcul de taille --- */

test('la taille suggérée respecte le risque demandé', () => {
  assert.equal(suggestQuantity({ capital: 10_000, riskPercent: 1, entry: 100, stop: 95 }), 20);
  assert.equal(
    suggestQuantity({ capital: 10_000, riskPercent: 1, entry: 100, stop: 105, side: 'short' }),
    20,
    'symétrique à la vente',
  );
});

test('sans stop, aucune taille ne peut être calculée', () => {
  assert.equal(suggestQuantity({ capital: 10_000, riskPercent: 1, entry: 100, stop: null }), null);
  assert.equal(
    suggestQuantity({ capital: 10_000, riskPercent: 1, entry: 100, stop: 105 }),
    null,
    'un stop du mauvais côté ne donne pas une taille négative',
  );
});

test('une ligne sans cotation compte quand même dans l exposition', () => {
  // Sinon un ticker que la source refuse ferait disparaître son engagement du
  // total, et le portefeuille paraîtrait plus léger qu'il ne l'est.
  const positions = [
    enrich(trade({ id: 'a' }), { price: null, settings: SETTINGS }),
    enrich(trade({ id: 'b', ticker: 'AMD' }), { price: 105, settings: SETTINGS }),
  ];
  const s = summarize(positions, { settings: SETTINGS });
  assert.equal(s.exposure, 1000 + 1050, 'la première ligne compte à son prix de revient');
});

/* --- Stop appliqué d'office --- */

test('la règle de sortie place le stop du bon côté selon le sens', () => {
  assert.equal(defaultStop({ entry: 100, side: 'long', percent: 5 }), 95);
  assert.equal(defaultStop({ entry: 100, side: 'short', percent: 5 }), 105, 'une vente se protège au-dessus');
  assert.equal(defaultStop({ entry: 5.0092, side: 'long', percent: 5 }), 4.76, 'arrondi au centime');
  assert.equal(defaultStop({ entry: 0.42, side: 'long', percent: 5 }), 0.399, 'quatre décimales sous un euro');
});

test('un stop d office impossible vaut null plutôt qu un nombre douteux', () => {
  assert.equal(defaultStop({ entry: null, percent: 5 }), null);
  assert.equal(defaultStop({ entry: 100, percent: 0 }), null);
  assert.equal(defaultStop({ entry: 100, percent: 150 }), null, 'un stop sous zéro n a pas de sens');
});

/* --- Combien de titres acheter --- */

test('la taille au risque et la perte au stop se répondent', () => {
  const plan = tradePlan({ entry: 100, stop: 95, target: 120, settings: SETTINGS });
  assert.equal(plan.quantity, 20, '100 de budget de risque, 5 par titre');
  assert.equal(plan.riskAmount, 100);
  assert.equal(plan.notional, 2000);
  assert.equal(plan.netAtTarget, 400, 'sans frais, le net est le brut');
  assert.equal(plan.netAtStop, -100);
});

test('sans frais renseignés, aucun seuil de rentabilité n est inventé', () => {
  const plan = tradePlan({ entry: 100, stop: 95, target: 120, settings: SETTINGS });
  assert.equal(plan.fees.declared, false);
  assert.equal(plan.minQuantity, null);
  assert.equal(plan.fees.breakEven, 100, 'sans frais, le prix mort est le prix payé');
});

test('avec des frais, le prix mort et la taille minimale se calculent', () => {
  const settings = { ...SETTINGS, feeFixed: 5, feePercent: 0 };
  const plan = tradePlan({ entry: 100, stop: 95, target: 120, settings });

  assert.equal(plan.fees.roundTrip, 10, 'deux ordres à 5');
  assert.equal(plan.fees.breakEven, 100.5, '10 de frais répartis sur 20 titres');
  assert.equal(plan.netAtTarget, 390);
  assert.equal(plan.netAtStop, -110, 'les frais s ajoutent à la perte');

  // 20 % de 20 de gain par titre = 4 ; 10 de frais fixes / 4 = 2,5 -> 3 titres.
  assert.equal(plan.minQuantity, 3);
});

test('des frais proportionnels trop lourds ne se corrigent pas par la taille', () => {
  // 3 % par ordre sur un objectif à +5 % : quelle que soit la taille, les frais
  // prennent plus du cinquième du gain.
  const settings = { ...SETTINGS, feeFixed: 0, feePercent: 3 };
  const plan = tradePlan({ entry: 100, stop: 95, target: 105, settings });

  assert.equal(plan.minQuantity, null);
  assert.match(plan.feeWarning, /quelle que soit la taille/);
});

test('sans stop exploitable, le plan ne propose pas de taille', () => {
  assert.equal(tradePlan({ entry: 100, stop: null, settings: SETTINGS }).quantity, null);
  assert.equal(tradePlan({ entry: null, stop: 95, settings: SETTINGS }), null);
});

test('le plan d une vente à découvert est symétrique', () => {
  const plan = tradePlan({ entry: 100, stop: 105, target: 90, side: 'short', settings: SETTINGS });
  assert.equal(plan.quantity, 20);
  assert.equal(plan.netAtTarget, 200, '10 de gain par titre');
  assert.equal(plan.netAtStop, -100);
});
