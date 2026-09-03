/**
 * Configuration centrale de l'application.
 * Toutes les valeurs "reglables" (poids, seuils, TTL) vivent ici pour qu'on
 * puisse calibrer le moteur de décision sans toucher a la logique.
 */

export const CONFIG = {
  server: {
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '0.0.0.0',
  },

  http: {
    timeoutMs: 15000,
    retries: 2,
    backoffMs: 600,
    maxConcurrent: 6,
    // Durée pendant laquelle une source en échec est écartée.
    failureTtlSeconds: 300,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Contact technique expose a EDGAR, qui l'exige dans le User-Agent.
    secUserAgent: process.env.SEC_USER_AGENT || 'test-stock/1.0 (contact: analyse@example.com)',
  },

  // Durée de vie du cache par famille de données (en secondes).
  // Les cotations bougent en continu, le calendrier de résultats non.
  cacheTtl: {
    quote: 60,
    history: 15 * 60,
    earnings: 6 * 3600,
    calendar: 12 * 3600,
    options: 10 * 60,
    news: 15 * 60,
    slow: 24 * 3600,
  },

  analysis: {
    // Fenetre d'historique de prix demandée (jours calendaires).
    historyDays: 420,
    // Nombre de titres d'actualité pris en compte.
    newsLimit: 40,
    // Au-dela, l'échéance est trop lointaine pour un pari "pre-résultats".
    maxDaysToEarnings: 45,
    // En deca, on considere qu'on entre dans la zone la plus risquee.
    lastCallDays: 1,

    // Poids des facteurs. La somme fait 100 : le score final est une moyenne
    // pondérée ramenee a la couverture reellement disponible.
    weights: {
      impliedVsHistorical: 18,
      earningsReaction: 15,
      surpriseRecord: 12,
      revisions: 12,
      momentum: 12,
      newsSentiment: 10,
      analysts: 7,
      shortInterest: 6,
      ownership: 4,
      liquidity: 4,
    },

    // Seuils de verdict sur le score global (-100 a +100).
    thresholds: {
      enter: 30,
      cautious: 12,
      neutral: -15,
    },

    // En dessous de cette couverture de données, on refusé de conclure.
    minCoverage: 0.45,

    // Garde-fous de risque (peuvent dégrader un verdict quel que soit le score).
    risk: {
      // Mouvement implicite juge extreme : le marché price déjà un choc.
      impliedMoveExtremePct: 12,
      impliedMoveHighPct: 8,
      // Liquidité minimale pour qu'une entree soit raisonnable.
      minAvgVolume: 100_000,
      minMarketCap: 300_000_000,
      // Sur-achat technique juste avant un catalyseur.
      rsiOverbought: 78,
    },
  },
};

export default CONFIG;
