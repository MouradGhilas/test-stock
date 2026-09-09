/**
 * Arithmétique du portefeuille : ce que valent les positions, ce qu'elles
 * risquent, et ce qui mérite qu'on lève les yeux.
 *
 * Tout est pur : on entre des trades et des prix, on sort des chiffres et des
 * alertes. Aucun appel réseau, aucun accès disque -- c'est ce qui rend la
 * partie la plus délicate (le risque) vérifiable au test près.
 *
 * Le parti pris : l'outil ne dit jamais quoi acheter. Il dit ce qu'on a déjà
 * engagé, ce qu'on perd si tous les stops sautent, et quelles lignes ont
 * dérivé loin du signal qui les a déclenchées.
 */

import { CONFIG } from '../config.js';
import { round, standardError } from '../core/stats.js';

const DAY_MS = 86_400_000;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** Sens algébrique : +1 à l'achat, -1 à la vente à découvert. */
const dirOf = (side) => (side === 'short' ? -1 : 1);

function alert(code, level, message) {
  return { code, level, message };
}

/**
 * Taille de position pour risquer `riskPercent` du capital sur la distance
 * entre l'entrée et le stop. C'est la seule façon de rendre comparables des
 * signaux qui donnent des niveaux mais jamais de quantité.
 */
export function suggestQuantity({ capital, riskPercent, entry, stop, side = 'long' }) {
  if (!isNum(capital) || !isNum(riskPercent) || !isNum(entry) || !isNum(stop)) return null;
  const perShare = (entry - stop) * dirOf(side);
  if (perShare <= 0) return null;

  const budget = (capital * riskPercent) / 100;
  const quantity = Math.floor(budget / perShare);
  return quantity > 0 ? quantity : null;
}

/**
 * Enrichit un trade d'un prix de marché : P&L, multiple de R, distances,
 * alertes. Un prix absent (source en panne) n'est pas une erreur -- la ligne
 * s'affiche sans valorisation.
 */
export function enrich(trade, { price = null, settings = {}, now = new Date() } = {}) {
  const p = CONFIG.portfolio;
  const capital = isNum(settings.capital) ? settings.capital : p.defaultCapital;
  const direction = dirOf(trade.side);
  const closed = trade.status === 'closed';
  const watching = trade.status === 'watch';

  const last = closed ? trade.exit : price;
  const quantity = isNum(trade.quantity) ? trade.quantity : null;

  const cost = quantity !== null ? quantity * trade.entry : null;
  const value = quantity !== null && isNum(last) ? quantity * last : null;

  const pnl = quantity !== null && isNum(last) ? (last - trade.entry) * quantity * direction : null;
  const pnlPercent = isNum(pnl) && cost ? (pnl / cost) * 100 : null;

  // Risque courant : ce que coûte la ligne si le stop, là où il est
  // aujourd'hui, est touché. Un stop remonté au-dessus de l'entrée ne coûte
  // plus rien -- il verrouille un gain, compté à part.
  const riskPerShare = isNum(trade.stop) ? (trade.entry - trade.stop) * direction : null;
  const riskAmount = isNum(riskPerShare) && quantity !== null ? Math.max(0, riskPerShare) * quantity : null;
  const lockedIn = isNum(riskPerShare) && quantity !== null ? Math.max(0, -riskPerShare) * quantity : null;
  const riskOfCapital = isNum(riskAmount) && capital > 0 ? (riskAmount / capital) * 100 : null;

  // Le multiple de R se mesure contre le risque *initial* : c'est lui qui rend
  // deux trades comparables, quel que soit le déplacement du stop depuis.
  const initialStop = isNum(trade.initialStop) ? trade.initialStop : trade.stop;
  const initialRisk =
    isNum(initialStop) && quantity !== null ? (trade.entry - initialStop) * direction * quantity : null;
  const rMultiple = isNum(pnl) && isNum(initialRisk) && initialRisk > 0 ? pnl / initialRisk : null;

  // Distance au stop, comptée dans le sens qui fait mal : négative, le stop
  // est déjà franchi.
  const stopDistance =
    isNum(trade.stop) && isNum(last) && last > 0 ? ((last - trade.stop) * direction * 100) / last : null;

  const nextTarget =
    trade.targets.find((t) => isNum(last) && (t - last) * direction > 0) ?? trade.targets[0] ?? null;
  const targetDistance =
    isNum(nextTarget) && isNum(last) && last > 0 ? ((nextTarget - last) * direction * 100) / last : null;

  const firstTarget = trade.targets[0] ?? null;
  const rewardRisk =
    isNum(firstTarget) && isNum(riskPerShare) && riskPerShare > 0
      ? ((firstTarget - trade.entry) * direction) / riskPerShare
      : null;

  // Rapport gain/risque tel qu'il serait en entrant maintenant : c'est le seul
  // chiffre qui compte quand on lit le signal avec quelques heures de retard.
  const rewardRiskNow =
    isNum(firstTarget) && isNum(trade.stop) && isNum(last)
      ? (() => {
          const reward = (firstTarget - last) * direction;
          const risk = (last - trade.stop) * direction;
          return risk > 0 ? reward / risk : null;
        })()
      : null;

  const drift = isNum(last) && trade.entry > 0 ? ((last - trade.entry) * direction * 100) / trade.entry : null;

  const since = closed ? trade.closedAt : trade.openedAt;
  const ageDays = since ? Math.max(0, Math.round((now.getTime() - new Date(since).getTime()) / DAY_MS)) : null;

  const alerts = [];

  if (!closed && !isNum(price)) {
    alerts.push(alert('no-price', 'info', 'Cotation indisponible : ligne non valorisée.'));
  }

  if (trade.status === 'open') {
    if (!isNum(trade.stop)) {
      alerts.push(alert('no-stop', 'warn', 'Aucun stop : la perte possible sur cette ligne est illimitée.'));
    } else if (isNum(stopDistance) && stopDistance <= 0) {
      alerts.push(alert('stop-hit', 'danger', `Stop franchi (${round(trade.stop, 2)}) : la ligne devrait être soldée.`));
    } else if (isNum(stopDistance) && stopDistance <= p.nearStopPct) {
      alerts.push(alert('near-stop', 'warn', `À ${round(stopDistance, 2)} % du stop.`));
    }

    if (isNum(targetDistance) && targetDistance <= 0 && isNum(nextTarget)) {
      alerts.push(alert('target-hit', 'good', `Objectif ${round(nextTarget, 2)} atteint : prise de gain à décider.`));
    }

    if (isNum(rMultiple) && rMultiple >= 1 && isNum(trade.stop) && (trade.stop - trade.entry) * direction < 0) {
      alerts.push(alert('to-breakeven', 'good', `+${round(rMultiple, 2)} R acquis : le stop peut passer à l'équilibre.`));
    }

    if (isNum(riskOfCapital) && riskOfCapital > p.maxRiskPerTradePct) {
      alerts.push(
        alert('oversized', 'warn', `Risque de ${round(riskOfCapital, 2)} % du capital, au-dessus de la limite de ${p.maxRiskPerTradePct} %.`),
      );
    }

    if (isNum(value) && capital > 0 && (value / capital) * 100 > p.maxPositionPct) {
      alerts.push(
        alert('heavy', 'warn', `La ligne pèse ${round((value / capital) * 100, 1)} % du capital.`),
      );
    }

    if (isNum(ageDays) && ageDays > p.staleDays) {
      alerts.push(alert('stale', 'info', `Ouverte depuis ${ageDays} jours : la thèse du signal tient-elle encore ?`));
    }
  }

  if (watching) {
    if (isNum(drift) && drift > p.missedEntryPct) {
      alerts.push(
        alert('missed-entry', 'warn', `Le prix a déjà pris ${round(drift, 2)} % dans le sens du signal : entrée manquée.`),
      );
    }
    if (isNum(rewardRiskNow) && rewardRiskNow < 1) {
      alerts.push(
        alert('poor-rr-now', 'warn', `À ce prix, le rapport gain/risque tombe à ${round(rewardRiskNow, 2)} : le signal a perdu son intérêt.`),
      );
    }
  }

  if (!closed && isNum(rewardRisk) && rewardRisk < 1) {
    alerts.push(alert('poor-rr', 'warn', `Le signal lui-même n'offre que ${round(rewardRisk, 2)} de gain par unité de risque.`));
  }

  return {
    ...trade,
    price: isNum(price) ? price : null,
    last: isNum(last) ? last : null,
    cost: round(cost, 2),
    value: round(value, 2),
    pnl: round(pnl, 2),
    pnlPercent: round(pnlPercent, 2),
    riskPerShare: round(riskPerShare, 4),
    riskAmount: round(riskAmount, 2),
    initialRisk: isNum(initialRisk) && initialRisk > 0 ? round(initialRisk, 2) : null,
    lockedIn: isNum(lockedIn) && lockedIn > 0 ? round(lockedIn, 2) : null,
    riskOfCapital: round(riskOfCapital, 2),
    rMultiple: round(rMultiple, 2),
    stopDistancePercent: round(stopDistance, 2),
    nextTarget,
    targetDistancePercent: round(targetDistance, 2),
    rewardRisk: round(rewardRisk, 2),
    rewardRiskNow: round(rewardRiskNow, 2),
    drift: round(drift, 2),
    ageDays,
    alerts,
  };
}

/** Agrège une liste de positions enrichies en une photographie du portefeuille. */
export function summarize(positions, { settings = {} } = {}) {
  const p = CONFIG.portfolio;
  const capital = isNum(settings.capital) ? settings.capital : p.defaultCapital;

  const open = positions.filter((x) => x.status === 'open');
  const watch = positions.filter((x) => x.status === 'watch');
  const closed = positions.filter((x) => x.status === 'closed');

  const sum = (list, key) => list.reduce((acc, x) => acc + (isNum(x[key]) ? x[key] : 0), 0);
  // Une ligne dont la cotation manque compte tout de même dans l'exposition,
  // à son prix de revient : l'ignorer sous-estimerait l'engagement réel.
  const sumExposure = (list) =>
    list.reduce((acc, x) => acc + (isNum(x.value) ? x.value : isNum(x.cost) ? x.cost : 0), 0);

  const exposure = sumExposure(open);
  const invested = sum(open, 'cost');
  const unrealized = sum(open, 'pnl');
  const realized = sum(closed, 'pnl');

  // Risque borné : la somme des pertes si chaque stop était touché. Les lignes
  // sans stop en sont exclues -- non parce qu'elles ne risquent rien, mais
  // parce que leur perte n'a pas de borne calculable. Elles sont comptées à
  // part, c'est le chiffre le plus important de cet écran.
  const withStop = open.filter((x) => isNum(x.riskAmount));
  const withoutStop = open.filter((x) => !isNum(x.riskAmount));
  const riskOpen = sum(withStop, 'riskAmount');
  const unboundedExposure = sumExposure(withoutStop);

  const group = (list, keyOf) => {
    const map = new Map();
    for (const item of list) {
      const key = keyOf(item);
      const bucket = map.get(key) || { key, count: 0, exposure: 0, risk: 0 };
      bucket.count += 1;
      bucket.exposure += isNum(item.value) ? item.value : isNum(item.cost) ? item.cost : 0;
      bucket.risk += isNum(item.riskAmount) ? item.riskAmount : 0;
      map.set(key, bucket);
    }
    return [...map.values()]
      .map((b) => ({
        ...b,
        exposure: round(b.exposure, 2),
        risk: round(b.risk, 2),
        sharePercent: exposure > 0 ? round((b.exposure / exposure) * 100, 1) : null,
      }))
      .sort((a, b) => b.exposure - a.exposure);
  };

  const byTicker = group(open, (x) => x.ticker);
  const byTrader = group(open, (x) => x.source?.handle || 'signal sans auteur');

  const alerts = [];
  const riskPercent = capital > 0 ? (riskOpen / capital) * 100 : null;

  if (isNum(riskPercent) && riskPercent > p.maxPortfolioRiskPct) {
    alerts.push(
      alert('portfolio-risk', 'danger', `Si tous les stops sautaient le même jour : -${round(riskPercent, 1)} % du capital, au-dessus de la limite de ${p.maxPortfolioRiskPct} %.`),
    );
  }

  if (withoutStop.length) {
    alerts.push(
      alert('unbounded-risk', 'danger', `${withoutStop.length} ligne${withoutStop.length > 1 ? 's' : ''} sans stop (${round(unboundedExposure, 0)} engagés) : perte maximale inconnue.`),
    );
  }

  if (capital > 0 && (exposure / capital) * 100 > 100) {
    alerts.push(alert('over-invested', 'warn', `Exposition à ${round((exposure / capital) * 100, 0)} % du capital : effet de levier de fait.`));
  }

  const topTicker = byTicker[0];
  if (topTicker && isNum(topTicker.sharePercent) && topTicker.sharePercent > p.maxTickerPct && byTicker.length > 1) {
    alerts.push(alert('ticker-concentration', 'warn', `${topTicker.key} pèse ${topTicker.sharePercent} % de l'exposition.`));
  }

  const topTrader = byTrader[0];
  if (topTrader && isNum(topTrader.sharePercent) && topTrader.sharePercent > p.maxTraderPct && byTrader.length > 1) {
    alerts.push(
      alert('trader-concentration', 'warn', `${topTrader.key} est derrière ${topTrader.sharePercent} % de l'exposition : c'est un pari sur une personne.`),
    );
  }

  if (open.length > p.maxOpenPositions) {
    alerts.push(
      alert('too-many', 'info', `${open.length} lignes ouvertes : au-delà d'une quinzaine, le suivi manuel décroche.`),
    );
  }

  const ranked = open.filter((x) => isNum(x.pnl)).sort((a, b) => b.pnl - a.pnl);
  const closedR = closed.map((x) => x.rMultiple).filter(isNum);

  return {
    capital,
    counts: { open: open.length, watch: watch.length, closed: closed.length },
    exposure: round(exposure, 2),
    exposurePercent: capital > 0 ? round((exposure / capital) * 100, 1) : null,
    invested: round(invested, 2),
    unrealized: round(unrealized, 2),
    unrealizedPercent: invested > 0 ? round((unrealized / invested) * 100, 2) : null,
    realized: round(realized, 2),
    realizedR: closedR.length ? round(closedR.reduce((a, b) => a + b, 0), 2) : null,
    risk: {
      bounded: round(riskOpen, 2),
      percent: round(riskPercent, 2),
      withoutStop: withoutStop.length,
      unboundedExposure: round(unboundedExposure, 2),
      limitPercent: p.maxPortfolioRiskPct,
    },
    concentration: { byTicker, byTrader },
    best: ranked[0] ? { id: ranked[0].id, ticker: ranked[0].ticker, pnl: ranked[0].pnl } : null,
    worst: ranked.length > 1 ? { id: ranked.at(-1).id, ticker: ranked.at(-1).ticker, pnl: ranked.at(-1).pnl } : null,
    alerts,
  };
}

/**
 * Bilan par compte suivi.
 *
 * Le chiffre qui décide de tout, en copy trading, n'est pas le P&L du jour :
 * c'est de savoir quel compte vous fait gagner de l'argent. Cet écran répond à
 * cette question -- et refuse d'y répondre tant que l'échantillon est court.
 * Dix trades soldés ne distinguent pas la compétence de la chance ; l'outil le
 * dit au lieu de couronner le dernier coup de chance.
 */
export function traderScoreboard(positions) {
  const p = CONFIG.portfolio;
  const map = new Map();

  for (const position of positions) {
    const key = position.source?.handle || 'signal sans auteur';
    const bucket = map.get(key) || { handle: key, open: 0, watch: 0, closed: 0, wins: 0, pnl: 0, exposure: 0, unrealized: 0, rs: [] };

    if (position.status === 'open') {
      bucket.open += 1;
      bucket.exposure += isNum(position.value) ? position.value : isNum(position.cost) ? position.cost : 0;
      bucket.unrealized += isNum(position.pnl) ? position.pnl : 0;
    } else if (position.status === 'watch') {
      bucket.watch += 1;
    } else {
      bucket.closed += 1;
      bucket.pnl += isNum(position.pnl) ? position.pnl : 0;
      if (isNum(position.pnl) && position.pnl > 0) bucket.wins += 1;
      if (isNum(position.rMultiple)) bucket.rs.push(position.rMultiple);
    }

    map.set(key, bucket);
  }

  return [...map.values()]
    .map((b) => {
      const avgR = b.rs.length ? b.rs.reduce((a, x) => a + x, 0) / b.rs.length : null;
      const error = b.rs.length > 1 ? standardError(b.rs) : null;
      // Écart-type de la moyenne : un gain moyen de +0,4 R sur six trades très
      // dispersés n'est pas distinguable de zéro.
      const tStat = isNum(avgR) && isNum(error) && error > 0 ? avgR / error : null;

      let verdict;
      if (b.closed < p.minClosedForVerdict) {
        verdict = {
          label: 'échantillon trop court',
          tone: 'slate',
          note: `${b.closed} trade${b.closed > 1 ? 's' : ''} soldé${b.closed > 1 ? 's' : ''} : en dessous de ${p.minClosedForVerdict}, on ne distingue pas la compétence de la chance.`,
        };
      } else if (isNum(tStat) && Math.abs(tStat) < 2) {
        verdict = {
          label: 'indécidable',
          tone: 'slate',
          note: `Gain moyen de ${round(avgR, 2)} R, mais trop dispersé pour être distingué de zéro (t = ${round(tStat, 2)}).`,
        };
      } else if (isNum(avgR) && avgR > 0) {
        verdict = { label: 'positif', tone: 'green', note: `${round(avgR, 2)} R par trade sur ${b.closed} soldés (t = ${round(tStat, 2)}).` };
      } else {
        verdict = { label: 'perdant', tone: 'red', note: `${round(avgR, 2)} R par trade sur ${b.closed} soldés (t = ${round(tStat, 2)}).` };
      }

      return {
        handle: b.handle,
        open: b.open,
        watch: b.watch,
        closed: b.closed,
        winRate: b.closed ? round((b.wins / b.closed) * 100, 1) : null,
        realized: round(b.pnl, 2),
        avgR: round(avgR, 2),
        sumR: b.rs.length ? round(b.rs.reduce((a, x) => a + x, 0), 2) : null,
        tStat: round(tStat, 2),
        exposure: round(b.exposure, 2),
        unrealized: round(b.unrealized, 2),
        verdict,
      };
    })
    .sort((a, b) => (b.open + b.closed) - (a.open + a.closed) || (b.realized ?? 0) - (a.realized ?? 0));
}
