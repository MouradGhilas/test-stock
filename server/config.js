/**
 * Configuration centrale de l'application.
 * Toutes les valeurs "réglables" (poids, seuils, TTL) vivent ici pour qu'on
 * puisse calibrer le moteur de décision sans toucher à la logique.
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
    // Contact technique exposé à EDGAR, qui l'exige dans le User-Agent.
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
    // Fenêtre d'historique de prix demandée (jours calendaires).
    // Nasdaq plafonne à cinq ans d'historique : on prend tout, car la
    // profondeur conditionne le nombre de réactions mesurables.
    historyDays: 1825,
    // Profondeur des publications recherchées chez EDGAR. Au-delà de cinq ans,
    // il n'y a plus de prix en face pour mesurer la réaction.
    earningsHistoryYears: 5,
    // Séances de cours renvoyées au graphique.
    chartSessions: 252,
    // Capitalisation minimale pour figurer au calendrier des publications :
    // le calendrier brut est saturé de très petites valeurs sur lesquelles
    // ni les options ni l'historique ne permettent une analyse sérieuse.
    calendarMinMarketCap: 2_000_000_000,
    // Nombre de titres d'actualité pris en compte.
    newsLimit: 40,
    // Au-delà, l'échéance est trop lointaine pour un pari "pré-résultats".
    maxDaysToEarnings: 45,
    // En deçà, on considère qu'on entre dans la zone la plus risquée.
    lastCallDays: 1,

    // Poids des facteurs. La somme fait 100 : le score final est une moyenne
    // pondérée ramenée à la couverture réellement disponible.
    //
    // Ces poids ne sont plus arbitraires. Le backtest (`npm run backtest`) a
    // rejoué 1223 publications sur cinq ans et mesuré les deux seuls facteurs
    // reconstituables sans historique payant : les réactions passées et la
    // configuration technique. Verdict : rho de Spearman de -0,066, et un
    // score élevé associé à une réaction *moins* bonne (t = -1,98). Ces deux
    // facteurs ne prédisent pas la direction.
    //
    // Leur poids est donc réduit -- pas inversé. Un backtest en échantillon
    // unique, sur un seul régime de marché, ne justifie pas de parier dans
    // l'autre sens ; il justifie de moins s'y fier. Le poids libéré va aux
    // facteurs qui *mesurent* un risque déjà coté par le marché plutôt que de
    // prétendre deviner une direction.
    weights: {
      impliedVsHistorical: 26, // +8 : mesure ce que le marché price
      earningsReaction: 8, //     -7 : direction non prédictive (backtest)
      surpriseRecord: 12,
      revisions: 12,
      momentum: 7, //             -5 : direction non prédictive (backtest)
      newsSentiment: 8, //        -2 : lexique sur titres, signal ténu
      analysts: 7,
      shortInterest: 6,
      ownership: 4,
      liquidity: 10, //           +6 : risque de dérapage, mesurable
    },

    // Résultat de la dernière calibration, exposé à l'interface pour que
    // l'utilisateur sache ce que le score ne sait pas faire.
    calibration: {
      date: '2026-09-03',
      observations: 1223,
      tickers: 70,
      years: 5,
      spearman: -0.066,
      tStat: -1.98,
      baselinePositiveRate: 0.492,
      baselineMeanHold: 0.42,
      testedWeight: 27,
      note:
        'Sur 1223 publications rejouées, les facteurs directionnels testés (réactions ' +
        'passées, configuration technique) ne prédisent pas le sens de la réaction. La ' +
        'réaction moyenne est nulle et le taux de hausse de 49,2 % : une pièce lancée en ' +
        "l'air. Ce site sert à mesurer le risque d'un événement, pas à en deviner l'issue.",
    },

    // Seuils de verdict sur le score global (-100 à +100).
    thresholds: {
      enter: 30,
      cautious: 12,
      neutral: -15,
    },

    // En dessous de cette couverture de données, on refuse de conclure.
    minCoverage: 0.45,

    // Garde-fous de risque (peuvent dégrader un verdict quel que soit le score).
    risk: {
      // Mouvement implicite jugé extrême : le marché price déjà un choc.
      impliedMoveExtremePct: 12,
      impliedMoveHighPct: 8,
      // Liquidité minimale pour qu'une entrée soit raisonnable.
      minAvgVolume: 100_000,
      minMarketCap: 300_000_000,
      // Sur-achat technique juste avant un catalyseur.
      rsiOverbought: 78,
    },
  },
};

export default CONFIG;
