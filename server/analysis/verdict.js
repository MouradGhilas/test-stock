/**
 * Moteur de décision.
 *
 * Chaque facteur produit trois choses : un score dans [-100, +100], une
 * confiance dans [0, 1] qui reflete la qualite des données disponibles, et
 * une explication en clair. Le score global est la moyenne des scores
 * pondérée par (poids x confiance), ramenee a la couverture reellement
 * obtenue -- une source absente ne pénalise donc pas le titre, elle réduit
 * la confiance du verdict.
 *
 * Par-dessus le score, des garde-fous ("gates") peuvent dégrader le verdict
 * quel que soit le total : sans date de publication il n'y a pas de pari
 * pre-résultats, et un mouvement implicite extreme rend l'entree
 * structurellement risquee même si tous les autres signaux sont au vert.
 */

import { CONFIG } from '../config.js';
import { clamp, scale, mean, isNum, round } from '../core/stats.js';

/** Nombre au format francais, pour les textes destines a l'utilisateur. */
const fr = (value, digits = 2) =>
  isNum(value) ? value.toLocaleString('fr-FR', { maximumFractionDigits: digits }) : '—';
import { daysBetween } from '../core/parse.js';

/** Du plus favorable au moins favorable : sert aux plafonnements. */
const LADDER = ['ENTRER', 'ENTREE_PRUDENTE', 'NEUTRE', 'EVITER'];

export const VERDICT_LABELS = {
  ENTRER: 'Entrer',
  ENTREE_PRUDENTE: 'Entrer avec prudence',
  NEUTRE: "Rester à l'écart",
  EVITER: 'Éviter',
  DONNEES_INSUFFISANTES: 'Données insuffisantes',
};

const capVerdict = (current, cap) =>
  LADDER.indexOf(cap) > LADDER.indexOf(current) ? cap : current;

function factor(id, label, weight, payload) {
  return {
    id,
    label,
    weight,
    score: payload.score === null ? 0 : round(clamp(payload.score, -100, 100), 1),
    confidence: round(clamp(payload.confidence ?? 0, 0, 1), 2),
    summary: payload.summary,
    details: payload.details || [],
  };
}

/* ------------------------------------------------------------------ */
/* Facteurs                                                            */
/* ------------------------------------------------------------------ */

/**
 * Le facteur le plus important : ce que le marché options price déjà,
 * compare a ce que le titre fait reellement lors de ses publications.
 */
function factorImpliedVsHistorical(facts, weight) {
  const implied = facts.options?.impliedMovePercent;
  const historical = facts.reactions?.medianAbsMove;

  if (!isNum(implied)) {
    return factor('impliedVsHistorical', 'Mouvement implicite vs historique', weight, {
      score: 0,
      confidence: 0,
      summary: "Pas de chaîne d'options exploitable : impossible de savoir ce que le marché price.",
    });
  }

  const details = [
    { label: 'Mouvement implicite', value: `${fr(implied, 2)} %` },
    {
      label: 'Méthode',
      value:
        facts.options.method === 'decomposition'
          ? "Isolé par difference de variance entre deux échéances"
          : 'Straddle à la monnaie (échéance unique disponible)',
    },
  ];

  if (!isNum(historical)) {
    const penalty = implied >= CONFIG.analysis.risk.impliedMoveExtremePct ? -45
      : implied >= CONFIG.analysis.risk.impliedMoveHighPct ? -20 : 0;
    return factor('impliedVsHistorical', 'Mouvement implicite vs historique', weight, {
      score: penalty,
      confidence: 0.45,
      summary: `Le marché price un mouvement de ${fr(implied, 1)} % mais l'historique des réactions manque : pas de point de comparaison.`,
      details,
    });
  }

  const ratio = implied / historical;
  let score = scale(ratio, 0.7, 1.6, 45, -70) ?? 0;

  // Un mouvement implicite élevé en valeur absolue reste un risque de gap,
  // même s'il est cohérent avec l'historique.
  if (implied >= CONFIG.analysis.risk.impliedMoveExtremePct) score -= 25;
  else if (implied >= CONFIG.analysis.risk.impliedMoveHighPct) score -= 12;

  details.push(
    { label: 'Réaction médiane passée', value: `${fr(historical, 2)} %` },
    { label: 'Ratio implicite / historique', value: `${fr(ratio, 2)} x` },
  );

  const summary =
    ratio > 1.3
      ? `Le marché price ${fr(implied, 1)} % alors que le titre bouge historiquement de ${fr(historical, 1)} % : l'événement est cher payé, la barre est haute.`
      : ratio < 0.85
        ? `Le marché price ${fr(implied, 1)} % contre ${fr(historical, 1)} % historiquement : l'événement semble sous-estime, le risque de gap est mal remunere par le consensus.`
        : `Mouvement implicite (${fr(implied, 1)} %) cohérent avec l'historique (${fr(historical, 1)} %) : pas d'anomalie de valorisation de l'événement.`;

  return factor('impliedVsHistorical', 'Mouvement implicite vs historique', weight, {
    score,
    confidence: facts.options.method === 'decomposition' ? 1 : 0.7,
    summary,
    details,
  });
}

/** Comment le titre a reellement reagi à ses dernières publications. */
function factorEarningsReaction(facts, weight) {
  const r = facts.reactions;
  if (!r?.count) {
    return factor('earningsReaction', 'Réactions passées aux résultats', weight, {
      score: 0,
      confidence: 0,
      summary: 'Aucune réaction passée reconstituable.',
    });
  }

  const directional = scale(r.positiveRate, 0.25, 0.8, -80, 80) ?? 0;
  const magnitude = clamp((r.medianMove ?? 0) * 15, -60, 60);
  const score = 0.6 * directional + 0.4 * magnitude;

  return factor('earningsReaction', 'Réactions passées aux résultats', weight, {
    score,
    confidence: clamp(r.count / 4, 0, 1),
    summary: `Sur ${r.count} publication(s), le titre a monté ${Math.round(r.positiveRate * 100)} % du temps, avec une réaction médiane de ${fr(r.medianMove, 1)} % (amplitude médiane ${fr(r.medianAbsMove, 1)} %).`,
    details: r.events.slice(0, 6).map((e) => ({
      label: e.reactionDate.toISOString().slice(0, 10),
      value: `${e.reactionPercent > 0 ? '+' : ''}${fr(e.reactionPercent, 2)} %`,
    })),
  });
}

/** Régularité des surprises de benefice par rapport au consensus. */
function factorSurpriseRecord(facts, weight) {
  const rows = (facts.surprises || []).filter((s) => isNum(s.surprisePercent));
  if (!rows.length) {
    return factor('surpriseRecord', 'Historique des surprises', weight, {
      score: 0,
      confidence: 0,
      summary: 'Historique des surprises indisponible.',
    });
  }

  const beats = rows.filter((s) => s.surprisePercent > 0).length;
  const beatRate = beats / rows.length;
  const avg = mean(rows.map((s) => s.surprisePercent));
  const score = 0.65 * (scale(beatRate, 0.25, 1, -70, 80) ?? 0) + 0.35 * clamp(avg * 6, -50, 60);

  return factor('surpriseRecord', 'Historique des surprises', weight, {
    score,
    confidence: clamp(rows.length / 4, 0, 1),
    summary: `${beats} dépassement(s) du consensus sur ${rows.length} trimestre(s), surprise moyenne de ${fr(avg, 1)} %.`,
    details: rows.slice(0, 6).map((s) => ({
      label: s.fiscalQuarter || s.reportedAt.toISOString().slice(0, 10),
      value: `${s.surprisePercent > 0 ? '+' : ''}${fr(s.surprisePercent, 2)} % (BPA ${s.eps} vs ${s.consensus})`,
    })),
  });
}

/** Révisions d'estimations des quatre dernières semaines sur le trimestre à venir. */
function factorRevisions(facts, weight) {
  const next = facts.forecast?.quarterly?.[0];
  if (!next) {
    return factor('revisions', "Révisions d'estimations", weight, {
      score: 0,
      confidence: 0,
      summary: 'Estimations analystes indisponibles.',
    });
  }

  const up = next.revisionsUp ?? 0;
  const down = next.revisionsDown ?? 0;
  const total = up + down;
  const details = [
    { label: 'Trimestre', value: next.period || '—' },
    { label: 'Consensus BPA', value: fr(next.consensus) },
    { label: "Nombre d'estimations", value: `${next.estimates ?? '—'}` },
    { label: 'Révisions 4 semaines', value: `${up} en hausse / ${down} en baisse` },
  ];

  if (total === 0) {
    return factor('revisions', "Révisions d'estimations", weight, {
      score: 0,
      confidence: 0.25,
      summary: "Aucune révision d'estimation ces quatre dernières semaines : les analystes n'ont pas bouge.",
      details,
    });
  }

  const net = (up - down) / total;
  // Une seule révision ne pese pas autant que quatre révisions concordantes :
  // l'amplitude du score suit la quantite de preuves, pas seulement leur sens.
  const evidence = clamp(total / 4, 0, 1);
  return factor('revisions', "Révisions d'estimations", weight, {
    score: net * (40 + 40 * evidence),
    confidence: clamp(total / 4, 0.4, 1),
    summary:
      net > 0
        ? `Les analystes relevent leurs estimations (${up} hausse(s) contre ${down} baisse(s)) : dynamique favorable avant la publication.`
        : net < 0
          ? `Les analystes abaissent leurs estimations (${down} baisse(s) contre ${up} hausse(s)) : mauvais signe à l'approche du résultat.`
          : `Révisions equilibrees (${up} hausse(s), ${down} baisse(s)).`,
    details,
  });
}

/**
 * Tendance et configuration technique, avec une pénalité spécifique au
 * contexte pre-résultats : un titre qui vient de s'envoler arrive avec des
 * attentes déjà hautes, ce qui réduit le potentiel de bonne surprise.
 */
function factorMomentum(facts, weight) {
  const ind = facts.indicators;
  if (!ind) {
    return factor('momentum', 'Tendance et technique', weight, {
      score: 0,
      confidence: 0,
      summary: 'Historique de prix insuffisant.',
    });
  }

  const price = ind.lastClose;
  let score = 0;
  const notes = [];

  if (isNum(ind.sma50)) {
    const above = price > ind.sma50;
    score += above ? 25 : -25;
    notes.push(`${above ? 'Au-dessus' : 'Sous'} la moyenne 50 séances`);
  }
  if (isNum(ind.sma200)) {
    const above = price > ind.sma200;
    score += above ? 20 : -20;
    notes.push(`${above ? 'Au-dessus' : 'Sous'} la moyenne 200 séances`);
  }
  if (isNum(ind.perf63)) score += clamp(ind.perf63 * 1.5, -30, 30);

  if (isNum(ind.rsi14)) {
    if (ind.rsi14 > CONFIG.analysis.risk.rsiOverbought) {
      score -= 25;
      notes.push(`RSI ${Math.round(ind.rsi14)} : sur-achat marque`);
    } else if (ind.rsi14 > 70) {
      score -= 10;
      notes.push(`RSI ${Math.round(ind.rsi14)} : tendu`);
    } else if (ind.rsi14 < 25) {
      score += 10;
      notes.push(`RSI ${Math.round(ind.rsi14)} : sur-vente`);
    } else if (ind.rsi14 >= 40 && ind.rsi14 <= 65) {
      score += 10;
      notes.push(`RSI ${Math.round(ind.rsi14)} : zone saine`);
    }
  }

  // Pénalité de parcours pre-résultats.
  if (isNum(ind.perf21)) {
    if (ind.perf21 > 20) {
      score -= 25;
      notes.push(`+${fr(ind.perf21, 1)} % en un mois : attentes déjà très élevées`);
    } else if (ind.perf21 > 12) {
      score -= 12;
      notes.push(`+${fr(ind.perf21, 1)} % en un mois : une partie de la bonne nouvelle est déjà dans le cours`);
    } else if (ind.perf21 < -15) {
      score += 8;
      notes.push(`${fr(ind.perf21, 1)} % en un mois : la barre à franchir est plus basse`);
    }
  }

  return factor('momentum', 'Tendance et technique', weight, {
    score,
    confidence: ind.sessions >= 200 ? 1 : clamp(ind.sessions / 200, 0.3, 1),
    summary: notes.length ? notes.join(' · ') : 'Configuration technique neutre.',
    details: [
      { label: 'Cours', value: `${fr(price, 2)}` },
      { label: 'MM50 / MM200', value: `${fr(ind.sma50, 2)} / ${fr(ind.sma200, 2)}` },
      { label: 'RSI 14', value: `${fr(ind.rsi14, 1)}` },
      { label: 'Perf 1 mois / 3 mois', value: `${fr(ind.perf21, 1)} % / ${fr(ind.perf63, 1)} %` },
      { label: 'Volatilité réalisée 30j', value: `${fr(ind.realizedVol30, 1)} %` },
    ],
  });
}

function factorNews(facts, weight) {
  const s = facts.sentiment;
  if (!s?.counts?.total) {
    return factor('newsSentiment', "Tonalité de l'actualité", weight, {
      score: 0,
      confidence: 0,
      summary: 'Aucune actualité recuperee.',
    });
  }

  return factor('newsSentiment', "Tonalité de l'actualité", weight, {
    score: s.overall * 85,
    confidence: s.confidence,
    summary: `${s.counts.total} titres analyses : ${s.counts.positive} positifs, ${s.counts.negative} negatifs, ${s.counts.neutral} neutres (tonalité pondérée ${fr(s.overall, 2)}).`,
    details: [],
  });
}

const CONSENSUS_SCORES = {
  'strong buy': 80, buy: 55, 'moderate buy': 40, outperform: 50, accumulate: 40,
  hold: 0, neutral: 0, 'moderate sell': -40, sell: -65, 'strong sell': -85,
  underperform: -50, reduce: -45,
};

function factorAnalysts(facts, weight) {
  const r = facts.ratings;
  const key = String(r?.consensus || '').trim().toLowerCase();
  const score = CONSENSUS_SCORES[key];

  if (score === undefined) {
    return factor('analysts', 'Consensus analystes', weight, {
      score: 0,
      confidence: 0,
      summary: 'Consensus analystes indisponible.',
    });
  }

  return factor('analysts', 'Consensus analystes', weight, {
    score,
    confidence: clamp((r.analystCount || 0) / 10, 0.3, 1),
    summary: `Consensus « ${r.consensus} »${r.analystCount ? ` sur ${r.analystCount} analystes` : ''}.`,
    details: r.summary ? [{ label: 'Détail', value: r.summary }] : [],
  });
}

/**
 * Positions vendeuses. Un short interest lourd traduit une conviction
 * baissiere informee, mais des rachats en cours (short interest en repli)
 * alimentent le rebond. On combine niveau et tendance.
 */
function factorShortInterest(facts, weight) {
  const rows = facts.shortInterest;
  if (!rows?.length) {
    return factor('shortInterest', 'Positions vendeuses', weight, {
      score: 0,
      confidence: 0,
      summary: 'Données de short interest indisponibles.',
    });
  }

  const [latest, previous] = rows;
  const daysToCover = latest.daysToCover;
  const trend =
    previous && isNum(latest.shares) && isNum(previous.shares) && previous.shares > 0
      ? ((latest.shares - previous.shares) / previous.shares) * 100
      : null;

  let score = -(scale(daysToCover ?? 0, 1, 10, 0, 40) ?? 0);
  if (isNum(trend)) score += trend < -5 ? 25 : trend > 5 ? -15 : 0;

  return factor('shortInterest', 'Positions vendeuses', weight, {
    score,
    confidence: 0.7,
    summary: `${fr(daysToCover, 1)} jours de rachat nécessaires${isNum(trend) ? `, short interest ${trend > 0 ? 'en hausse' : 'en baisse'} de ${fr(Math.abs(trend), 1)} % sur la derniere periode` : ''}.`,
    details: rows.slice(0, 4).map((row) => ({
      label: row.settlementDate.toISOString().slice(0, 10),
      value: `${row.shares?.toLocaleString('fr-FR')} titres · ${fr(row.daysToCover, 2)} j`,
    })),
  });
}

function factorOwnership(facts, weight) {
  const inst = facts.institutional;
  if (!inst || (!isNum(inst.increasedHolders) && !isNum(inst.institutionalOwnershipPercent))) {
    return factor('ownership', 'Actionnariat institutionnel', weight, {
      score: 0,
      confidence: 0,
      summary: 'Données d actionnariat indisponibles.',
    });
  }

  const up = inst.increasedHolders ?? 0;
  const down = inst.decreasedHolders ?? 0;
  const total = up + down;
  const net = total > 0 ? (up - down) / total : 0;
  let score = net * 60;

  const ownership = inst.institutionalOwnershipPercent;
  if (isNum(ownership) && ownership >= 40 && ownership <= 90) score += 10;

  return factor('ownership', 'Actionnariat institutionnel', weight, {
    score,
    confidence: total > 0 ? 0.7 : 0.3,
    summary: `${up} institutionnels renforcent contre ${down} qui allègent${isNum(ownership) ? `, detention institutionnelle de ${fr(ownership, 1)} %` : ''}.`,
    details: [],
  });
}

/** Liquidité et taille : une entree sur un titre etroit est structurellement risquee. */
function factorLiquidity(facts, weight) {
  const cap = facts.summary?.marketCap;
  const volume = facts.summary?.averageVolume;
  if (!isNum(cap) && !isNum(volume)) {
    return factor('liquidity', 'Liquidité et taille', weight, {
      score: 0,
      confidence: 0,
      summary: 'Données de liquidité indisponibles.',
    });
  }

  let score = 0;
  const notes = [];
  const { minAvgVolume, minMarketCap } = CONFIG.analysis.risk;

  if (isNum(volume)) {
    score += volume >= 1_000_000 ? 40 : volume >= minAvgVolume ? 10 : -60;
    notes.push(`volume moyen ${Math.round(volume).toLocaleString('fr-FR')} titres/jour`);
  }
  if (isNum(cap)) {
    score += cap >= 10e9 ? 30 : cap >= 2e9 ? 15 : cap >= minMarketCap ? 0 : -50;
    notes.push(`capitalisation ${(cap / 1e9).toFixed(2)} Md$`);
  }
  if (isNum(facts.indicators?.realizedVol30) && facts.indicators.realizedVol30 > 80) {
    score -= 25;
    notes.push(`volatilité realisee ${Math.round(facts.indicators.realizedVol30)} %`);
  }

  return factor('liquidity', 'Liquidité et taille', weight, {
    score,
    confidence: 0.8,
    summary: notes.join(' · '),
    details: [],
  });
}

/* ------------------------------------------------------------------ */
/* Agregation                                                          */
/* ------------------------------------------------------------------ */

export function buildVerdict(facts) {
  const { weights, thresholds, minCoverage, risk, maxDaysToEarnings, lastCallDays } = CONFIG.analysis;

  const factors = [
    factorImpliedVsHistorical(facts, weights.impliedVsHistorical),
    factorEarningsReaction(facts, weights.earningsReaction),
    factorSurpriseRecord(facts, weights.surpriseRecord),
    factorRevisions(facts, weights.revisions),
    factorMomentum(facts, weights.momentum),
    factorNews(facts, weights.newsSentiment),
    factorAnalysts(facts, weights.analysts),
    factorShortInterest(facts, weights.shortInterest),
    factorOwnership(facts, weights.ownership),
    factorLiquidity(facts, weights.liquidity),
  ];

  const totalWeight = factors.reduce((acc, f) => acc + f.weight, 0);
  const effectiveWeight = factors.reduce((acc, f) => acc + f.weight * f.confidence, 0);
  const coverage = totalWeight > 0 ? effectiveWeight / totalWeight : 0;
  const score =
    effectiveWeight > 0
      ? factors.reduce((acc, f) => acc + f.score * f.weight * f.confidence, 0) / effectiveWeight
      : 0;

  // --- Verdict de base sur le score ---
  let verdict =
    score >= thresholds.enter ? 'ENTRER'
      : score >= thresholds.cautious ? 'ENTREE_PRUDENTE'
        : score >= thresholds.neutral ? 'NEUTRE'
          : 'EVITER';

  const warnings = [];
  const daysToEarnings = facts.earningsDate?.date
    ? daysBetween(facts.now, facts.earningsDate.date)
    : null;

  // --- Garde-fous ---
  if (coverage < minCoverage) {
    verdict = 'DONNEES_INSUFFISANTES';
    warnings.push(
      `Seulement ${Math.round(coverage * 100)} % des facteurs ont pu être alimentés : trop peu pour conclure.`,
    );
  } else {
    if (!facts.earningsDate) {
      verdict = capVerdict(verdict, 'NEUTRE');
      warnings.push(
        "Aucune date de publication identifiée : il n'y a pas de pari pre-résultats a jouer tant que l'échéance est inconnue.",
      );
    } else {
      if (facts.earningsDate.confidence === 'estimated') {
        warnings.push(
          "La date de publication est extrapolée, pas confirmée par la société : elle peut bouger de plusieurs jours.",
        );
      }
      if (facts.optionsWindowConflict) {
        verdict = capVerdict(verdict, 'ENTREE_PRUDENTE');
        warnings.push(
          "Le marché options place la publication dans une autre fenêtre que la date estimée : traiter cette date avec méfiance.",
        );
      }
      if (isNum(daysToEarnings)) {
        if (daysToEarnings < 0) {
          verdict = capVerdict(verdict, 'NEUTRE');
          warnings.push('La date de publication retenue est déjà passée : analyse à rafraîchir.');
        } else if (daysToEarnings > maxDaysToEarnings) {
          verdict = capVerdict(verdict, 'NEUTRE');
          warnings.push(
            `La publication est dans ${daysToEarnings} jours : trop loin pour un positionnement pre-résultats, le contexte aura le temps de changer.`,
          );
        } else if (daysToEarnings <= lastCallDays) {
          warnings.push(
            daysToEarnings === 0
              ? "La publication a lieu aujourd'hui : entrer maintenant, c'est prendre tout le risque de gap sans aucune marge de manoeuvre."
              : "Entrer à la veille de la publication, c'est prendre tout le risque de gap sans laisser au marché le temps de valoriser la nouvelle.",
          );
        }
      }
    }

    const implied = facts.options?.impliedMovePercent;
    if (isNum(implied) && implied >= risk.impliedMoveExtremePct) {
      verdict = capVerdict(verdict, 'ENTREE_PRUDENTE');
      warnings.push(
        `Le marché price un mouvement de ${fr(implied, 1)} % : une position en direct expose a un gap de cette ampleur, dans les deux sens.`,
      );
    }

    const volume = facts.summary?.averageVolume;
    const cap = facts.summary?.marketCap;
    if ((isNum(volume) && volume < risk.minAvgVolume) || (isNum(cap) && cap < risk.minMarketCap)) {
      verdict = capVerdict(verdict, 'NEUTRE');
      warnings.push(
        'Titre peu liquide ou de petite taille : les écarts de cotation et le risque de derapage effacent facilement le gain espere.',
      );
    }

    if (isNum(facts.indicators?.rsi14) && facts.indicators.rsi14 > risk.rsiOverbought) {
      warnings.push(
        `RSI a ${Math.round(facts.indicators.rsi14)} : le titre arrive tendu sur l'événement, la moindre deception se paie cher.`,
      );
    }

    if (facts.reactions && facts.reactions.count < 3) {
      warnings.push(
        `Seulement ${facts.reactions.count} réaction(s) passée(s) reconstituee(s) : la référence historique est fragile.`,
      );
    }
    if (facts.reactions?.timingResolution === 'default') {
      warnings.push(
        "L'horaire de publication n'a pas pu être établi : les réactions passées supposent une publication après clôture, ce qui peut decaler la séance retenue.",
      );
    }
  }

  return {
    verdict,
    label: VERDICT_LABELS[verdict],
    score: round(score, 1),
    coverage: round(coverage, 3),
    daysToEarnings,
    factors: factors.sort((a, b) => b.weight * b.confidence - a.weight * a.confidence),
    warnings,
    plan: buildPlan(facts, verdict, daysToEarnings),
  };
}

/**
 * Traduit le verdict en paramètres concrets. L'important n'est pas la
 * direction supposée mais le dimensionnement : sur un résultat, le risque
 * se matérialise à l'ouverture, quand aucun stop ne protège plus.
 */
function buildPlan(facts, verdict, daysToEarnings) {
  const implied = facts.options?.impliedMovePercent;
  // La plus forte amplitude passee peut être une hausse : la retenir comme
  // scenario adverse gonfle le risque affiché sans rien dire de la baisse.
  const worstDrop = facts.reactions?.worstDrop;
  const price = facts.quote?.price ?? facts.indicators?.lastClose;

  const downside = isNum(implied) && isNum(worstDrop)
    ? Math.max(implied, worstDrop)
    : implied ?? worstDrop ?? null;

  const steps = [];

  if (verdict === 'DONNEES_INSUFFISANTES') {
    steps.push("Compléter les données manquantes avant toute décision : en l'état l'analyse ne tranche pas.");
  } else if (verdict === 'EVITER' || verdict === 'NEUTRE') {
    steps.push("Le rapport risque/intérêt ne justifie pas d'ouvrir une position avant la publication.");
    steps.push('Attendre la réaction et se positionner ensuite supprime le risque de gap, au prix du premier mouvement.');
  } else {
    if (isNum(daysToEarnings) && daysToEarnings > 2) {
      steps.push(
        `Fenêtre d'entrée : entre J-${Math.min(daysToEarnings, 7)} et J-2 avant la publication, pour capter la montée en tension sans subir toute la séance d'annonce.`,
      );
    }
    if (isNum(downside) && isNum(price)) {
      steps.push(
        `Dimensionner la position pour qu'un gap de ${fr(downside, 1)} % (${fr((price * downside) / 100, 2)} par titre) reste supportable : c'est le scénario adverse déjà price par le marché.`,
      );
    }
    steps.push(
      "Un stop classique ne protège pas d'un gap d'ouverture : il s'exécute après le décalage, pas pendant. Le dimensionnement est le seul vrai garde-fou.",
    );
    steps.push(
      'Alléger une partie de la position avant la publication conserve une exposition tout en réduisant le risque événementiel.',
    );
  }

  return {
    steps,
    expectedDownsidePercent: isNum(downside) ? round(downside, 2) : null,
    referencePrice: isNum(price) ? round(price, 2) : null,
  };
}
