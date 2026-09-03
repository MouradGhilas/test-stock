/**
 * Degré d'anticipation : le mouvement est-il déjà dans le prix ?
 *
 * C'est une question distincte de celle du reste du site. Les facteurs du
 * verdict cherchent à qualifier un dossier ; celui-ci cherche à savoir si on
 * arrive après la bataille. Un excellent dossier déjà entièrement anticipé est
 * un mauvais point d'entrée, et cette information-là ne se lit nulle part dans
 * un score de qualité.
 *
 * **Ce que ça ne fait pas.** Rien ici ne devine l'intention d'un teneur de
 * marché ni ne détecte une manipulation. Ces acteurs voient le carnet d'ordres
 * en temps réel ; on travaille avec des options différées et des bougies
 * quotidiennes. Prétendre les devancer serait mentir.
 *
 * **Ce que ça fait.** Mesurer les traces publiques que laisse un
 * positionnement en cours de constitution : un parcours anormal par rapport
 * aux habitudes du titre, un volume qui gonfle, une volatilité implicite déjà
 * tendue, un cours au-dessus de l'objectif des analystes, des estimations déjà
 * relevées, un marché d'options penché du côté des calls. Aucun de ces signaux
 * ne dit *qui* se positionne. Ensemble, ils disent si on est encore tôt.
 */

import { clamp, scale, isNum, round } from '../core/stats.js';

/** Nombre au format francais, pour les textes destines a l'utilisateur. */
const fr = (value, digits = 2) =>
  isNum(value) ? value.toLocaleString('fr-FR', { maximumFractionDigits: digits }) : '—';

const LEVELS = [
  { max: 30, level: 'faible', label: 'Peu anticipé' },
  { max: 55, level: 'modere', label: 'Partiellement anticipé' },
  { max: 75, level: 'eleve', label: 'Largement anticipé' },
  { max: Infinity, level: 'extreme', label: 'Entièrement anticipé' },
];

function signal(id, label, weight, payload) {
  return {
    id,
    label,
    weight,
    available: payload.anticipation !== null,
    anticipation: payload.anticipation === null ? null : round(clamp(payload.anticipation, 0, 100), 1),
    reading: payload.reading,
    detail: payload.detail ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Signaux                                                             */
/* ------------------------------------------------------------------ */

/**
 * Le titre monte-t-il plus que d'habitude avant ses résultats ?
 *
 * Comparé à sa propre habitude, pas à un seuil arbitraire : certaines valeurs
 * dérivent systématiquement avant publication, ce n'est pas ça qu'on cherche.
 * On mesure l'écart en nombre d'écarts-types de ses propres parcours passés.
 */
function signalRunUp(facts, weight) {
  const current = facts.indicators?.perf5;
  const habitual = facts.reactions?.medianRunUp;
  const dispersion = facts.reactions?.runUpStdev;
  const count = facts.reactions?.runUps?.length ?? 0;

  if (!isNum(current) || !isNum(habitual) || !isNum(dispersion) || dispersion <= 0 || count < 5) {
    return signal('runUp', 'Parcours avant publication', weight, {
      anticipation: null,
      reading: "Pas assez de publications passées pour savoir ce qu'est un parcours habituel sur ce titre.",
    });
  }

  const z = (current - habitual) / dispersion;

  return signal('runUp', 'Parcours avant publication', weight, {
    anticipation: scale(z, -1, 3, 0, 100),
    reading:
      z > 1.5
        ? `Le titre a fait ${fr(current, 1)} % en cinq séances, contre ${fr(habitual, 1)} % habituellement avant ses résultats : ${fr(z, 1)} écarts-types au-dessus de sa norme. Une partie du mouvement est déjà faite.`
        : z < -1
          ? `Le titre a fait ${fr(current, 1)} % en cinq séances contre ${fr(habitual, 1)} % habituellement : il arrive plus bas que d'ordinaire sur l'événement.`
          : `Parcours de ${fr(current, 1)} % sur cinq séances, conforme à son habitude (${fr(habitual, 1)} %).`,
    detail: { current: round(current, 2), habitual: round(habitual, 2), zScore: round(z, 2), observations: count },
  });
}

/** Le volume gonfle-t-il avant l'échéance ? */
function signalVolume(facts, weight) {
  const surge = facts.indicators?.volumeSurge;
  if (!surge || !isNum(surge.ratio)) {
    return signal('volume', 'Afflux de volume', weight, {
      anticipation: null,
      reading: 'Historique de volume insuffisant.',
    });
  }

  return signal('volume', 'Afflux de volume', weight, {
    anticipation: scale(surge.ratio, 1, 2.5, 0, 100),
    reading:
      surge.ratio > 1.6
        ? `Le volume des cinq dernières séances vaut ${fr(surge.ratio, 2)} fois le régime habituel : des intervenants se positionnent déjà.`
        : surge.ratio < 0.8
          ? `Volume à ${fr(surge.ratio, 2)} fois la normale : peu d'intérêt pour l'instant sur ce titre.`
          : `Volume à ${fr(surge.ratio, 2)} fois la normale, rien d'inhabituel.`,
    detail: { ratio: round(surge.ratio, 2) },
  });
}

/**
 * La volatilité implicite est-elle déjà tendue par rapport à ce que le titre
 * fait réellement ? Un écart large signifie que l'événement est déjà cher.
 */
function signalVolPremium(facts, weight) {
  // On compare deux mesures de même horizon : la volatilité implicite à 30
  // jours constants et la volatilité réalisée sur 30 séances.
  //
  // Surtout pas la volatilité implicite de l'échéance retenue : à la veille
  // d'une publication, elle porte sur une option d'un jour qui ne contient
  // que l'événement, et affiche mécaniquement des centaines de pourcents.
  // Rapportée à une volatilité mensuelle, elle saturerait le signal pour
  // toute société publiant dans les 48 heures -- donc n'informerait de rien.
  const implied = facts.options?.iv30;
  const realized = facts.indicators?.realizedVol30;

  if (!isNum(implied) || !isNum(realized) || realized <= 0 || implied <= 0) {
    return signal('volPremium', 'Tension de la volatilité', weight, {
      anticipation: null,
      reading: 'Volatilité implicite à 30 jours ou volatilité réalisée indisponible.',
    });
  }

  const ratio = implied / realized;

  return signal('volPremium', 'Tension de la volatilité', weight, {
    anticipation: scale(ratio, 1, 2, 0, 100),
    reading:
      ratio > 1.4
        ? `La volatilité implicite à 30 jours (${fr(implied, 1)} %) vaut ${fr(ratio, 2)} fois la volatilité réellement constatée sur la période (${fr(realized, 1)} %) : le marché des options paie déjà cher l'incertitude à venir.`
        : ratio < 0.9
          ? `Volatilité implicite à 30 jours (${fr(implied, 1)} %) inférieure à la volatilité réalisée (${fr(realized, 1)} %) : le marché des options n'anticipe pas de secousse particulière.`
          : `Volatilité implicite à 30 jours de ${fr(implied, 1)} % contre ${fr(realized, 1)} % réalisée, soit ${fr(ratio, 2)} fois -- écart ordinaire.`,
    detail: { impliedVol30: round(implied, 1), realizedVol30: round(realized, 1), ratio: round(ratio, 2) },
  });
}

/** Le cours a-t-il déjà rejoint, voire dépassé, l'objectif des analystes ? */
function signalTarget(facts, weight) {
  const price = facts.quote?.price ?? facts.indicators?.lastClose;
  const target = facts.summary?.oneYearTarget;

  if (!isNum(price) || !isNum(target) || price <= 0) {
    return signal('target', "Marge vers l'objectif analystes", weight, {
      anticipation: null,
      reading: 'Objectif de cours indisponible.',
    });
  }

  const gap = ((target - price) / price) * 100;

  return signal('target', "Marge vers l'objectif analystes", weight, {
    anticipation: scale(gap, 25, -10, 0, 100),
    reading:
      gap < 0
        ? `Le cours dépasse déjà l'objectif moyen à un an (${fr(target, 2)}) de ${fr(-gap, 1)} % : le potentiel que voient les analystes est consommé.`
        : `Il reste ${fr(gap, 1)} % jusqu'à l'objectif moyen à un an (${fr(target, 2)}).`,
    detail: { price: round(price, 2), target: round(target, 2), gapPercent: round(gap, 1) },
  });
}

/** Les analystes ont-ils déjà relevé la barre ? */
function signalRevisions(facts, weight) {
  const next = facts.forecast?.quarterly?.[0];
  const up = next?.revisionsUp ?? 0;
  const down = next?.revisionsDown ?? 0;

  if (!next || up + down === 0) {
    return signal('revisions', 'Attentes déjà relevées', weight, {
      anticipation: null,
      reading: "Aucune révision d'estimation ces quatre dernières semaines.",
    });
  }

  const net = up - down;

  return signal('revisions', 'Attentes déjà relevées', weight, {
    anticipation: scale(net, 0, 5, 0, 100),
    reading:
      net > 1
        ? `${up} relèvement(s) d'estimation contre ${down} abaissement(s) en quatre semaines : la barre à franchir a déjà été montée.`
        : net < 0
          ? `${down} abaissement(s) contre ${up} relèvement(s) : la barre a été abaissée, une bonne surprise est plus accessible.`
          : `Révisions équilibrées (${up} hausse(s), ${down} baisse(s)).`,
    detail: { up, down },
  });
}

/** Le marché des options penche-t-il déjà du côté haussier ? */
function signalPositioning(facts, weight) {
  const ratio = facts.options?.putCallOpenInterest;
  if (!isNum(ratio) || ratio <= 0) {
    return signal('positioning', 'Positionnement optionnel', weight, {
      anticipation: null,
      reading: "Positions ouvertes sur options indisponibles.",
    });
  }

  return signal('positioning', 'Positionnement optionnel', weight, {
    anticipation: scale(ratio, 1.2, 0.4, 0, 100),
    reading:
      ratio < 0.7
        ? `Positions ouvertes penchées vers les calls (rapport put/call de ${fr(ratio, 2)}) : le pari haussier est déjà en place sur l'échéance.`
        : ratio > 1.2
          ? `Positions ouvertes penchées vers les puts (rapport de ${fr(ratio, 2)}) : la couverture domine, le pari haussier n'est pas encombré.`
          : `Positions ouvertes équilibrées (rapport put/call de ${fr(ratio, 2)}).`,
    detail: { putCallRatio: round(ratio, 2) },
  });
}

/**
 * Le mouvement implicite monte-t-il au fil des jours ?
 *
 * Signal disponible seulement une fois que le site a observé le même titre
 * plusieurs fois : aucune source gratuite ne donne l'historique de volatilité
 * implicite, il faut l'archiver au fil de l'eau. C'est le seul signal qui
 * réponde directement à « depuis combien de temps est-ce pricé ».
 */
function signalImpliedTrend(facts, weight) {
  const history = facts.impliedHistory;
  if (!history || history.length < 2) {
    return signal('impliedTrend', 'Montée du mouvement implicite', weight, {
      anticipation: null,
      reading:
        history?.length === 1
          ? "Première observation archivée pour cette échéance : la tendance apparaîtra aux prochaines consultations."
          : "Aucun historique de volatilité implicite : il se constitue à chaque consultation.",
    });
  }

  const first = history[0];
  const last = history.at(-1);
  const delta = last.impliedMovePercent - first.impliedMovePercent;
  const days = Math.max(1, Math.round((new Date(last.at) - new Date(first.at)) / 86_400_000));

  return signal('impliedTrend', 'Montée du mouvement implicite', weight, {
    anticipation: scale(delta, 0, 4, 0, 100),
    reading:
      delta > 1
        ? `Le mouvement implicite est passé de ${fr(first.impliedMovePercent, 1)} % à ${fr(last.impliedMovePercent, 1)} % en ${days} jour(s) : le marché renchérit l'événement, il ne le découvre pas maintenant.`
        : delta < -1
          ? `Le mouvement implicite est retombé de ${fr(first.impliedMovePercent, 1)} % à ${fr(last.impliedMovePercent, 1)} % en ${days} jour(s).`
          : `Mouvement implicite stable autour de ${fr(last.impliedMovePercent, 1)} % depuis ${days} jour(s).`,
    detail: { from: round(first.impliedMovePercent, 2), to: round(last.impliedMovePercent, 2), days, observations: history.length },
  });
}

/* ------------------------------------------------------------------ */
/* Agrégation                                                          */
/* ------------------------------------------------------------------ */

export function analyzeAnticipation(facts) {
  const signals = [
    signalRunUp(facts, 25),
    signalVolume(facts, 20),
    signalVolPremium(facts, 20),
    signalTarget(facts, 15),
    signalRevisions(facts, 10),
    signalPositioning(facts, 10),
    signalImpliedTrend(facts, 15),
  ];

  const available = signals.filter((s) => s.available);
  const totalWeight = signals.reduce((acc, s) => acc + s.weight, 0);
  const usedWeight = available.reduce((acc, s) => acc + s.weight, 0);

  if (!usedWeight) {
    return {
      score: null,
      level: null,
      label: 'Indéterminé',
      coverage: 0,
      signals,
      summary: "Trop peu de signaux exploitables pour dire si le mouvement est déjà dans le prix.",
    };
  }

  const score = available.reduce((acc, s) => acc + s.anticipation * s.weight, 0) / usedWeight;
  const { level, label } = LEVELS.find((l) => score < l.max);

  const strongest = [...available].sort((a, b) => b.anticipation * b.weight - a.anticipation * a.weight)[0];

  const summary =
    score >= 75
      ? `Le mouvement est déjà construit : entrer maintenant, c'est payer une anticipation que d'autres ont mise en place avant. ${strongest.label} est le signal le plus marqué.`
      : score >= 55
        ? `Une partie substantielle de l'événement est déjà dans le prix. ${strongest.label} pèse le plus dans ce constat.`
        : score >= 30
          ? "L'événement est partiellement anticipé : ni ignoré du marché, ni entièrement escompté."
          : "Peu de traces d'un positionnement déjà constitué : sur les signaux publics disponibles, l'événement ne paraît pas encore escompté.";

  return {
    score: round(score, 1),
    level,
    label,
    coverage: round(usedWeight / totalWeight, 2),
    signals: signals.sort((a, b) => (b.anticipation ?? -1) * b.weight - (a.anticipation ?? -1) * a.weight),
    summary,
  };
}
