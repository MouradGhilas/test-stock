/**
 * Configuration centrale de l'application.
 * Toutes les valeurs "réglables" (seuils de risque, TTL de cache) vivent ici,
 * pour qu'on puisse ajuster les garde-fous sans toucher à la logique.
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
  },

  // Durée de vie du cache par famille de données (en secondes).
  // Les cotations bougent en continu, le calendrier de résultats non.
  cacheTtl: {
    quote: 60,
    earnings: 6 * 3600,
    calendar: 12 * 3600,
  },

  // Suivi des positions copiées depuis X. Ce sont des garde-fous de gestion,
  // pas des prédictions : chaque seuil déclenche une alerte, jamais un ordre.
  portfolio: {
    // Capital de référence. Sert à ramener les risques en pourcentage : sans
    // lui, « 320 $ de risque » ne veut rien dire.
    defaultCapital: 10_000,
    // Risque cible par position, utilisé par le calculateur de taille.
    riskPerTradePct: 1,
    // Distance de sortie appliquée d'office quand le signal ne donne pas de
    // stop -- le cas le plus fréquent. C'est une règle de conduite personnelle,
    // pas une lecture du marché : elle vaut ce que vaut la discipline de s'y
    // tenir, et un titre volatil la déclenchera souvent.
    defaultStopPercent: 5,
    // Frais de courtage, par ordre. Zéro par défaut : beaucoup de courtiers
    // n'en prennent plus, et inventer un montant fausserait le seuil de
    // rentabilité plus sûrement que de ne rien afficher.
    feeFixed: 0,
    feePercent: 0,
    // Part du gain visé au-delà de laquelle les frais rendent le trade absurde.
    // Sert à calculer la taille minimale qui vaut la peine d'être prise.
    maxFeeShareOfGain: 20,
    // Au-delà, la position pèse trop lourd pour une idée venue d'un tweet.
    maxRiskPerTradePct: 2,
    // Somme des pertes si tous les stops sautaient le même jour. C'est le
    // chiffre qui compte quand on suit dix signaux à la fois.
    maxPortfolioRiskPct: 6,
    maxPositionPct: 20,
    maxTickerPct: 25,
    // Un seul compte X derrière la moitié du portefeuille, c'est un pari sur
    // une personne, plus sur un marché.
    maxTraderPct: 40,
    // Nombre de lignes ouvertes au-delà duquel le suivi manuel décroche.
    maxOpenPositions: 15,
    // Écart au prix du signal au-delà duquel l'entrée est considérée ratée.
    missedEntryPct: 2,
    // Proximité du stop, en pourcentage du prix, qui vaut alerte.
    nearStopPct: 1.5,
    // Position ouverte depuis si longtemps qu'elle n'a plus de thèse.
    staleDays: 45,
    // Publication de résultats imminente sur une ligne ouverte.
    earningsWarningDays: 7,
    // Bornes de la veille « résultats » : chaque ticker coûte deux requêtes.
    maxEarningsWatch: 15,
    // En deçà, le bilan d'un compte X relève du hasard, pas de la compétence.
    minClosedForVerdict: 10,
  },
};

export default CONFIG;
