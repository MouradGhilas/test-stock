/**
 * Source : API publique de nasdaq.com (celle qui alimenté leur site).
 *
 * C'est le socle de l'analyse : cotation, historique de prix, historique des
 * surprises de résultats, révisions d'estimations, consensus analystes,
 * short interest, actionnariat institutionnel et date des prochains résultats.
 */

import { CONFIG } from '../config.js';
import { fetchJson } from '../core/http.js';
import { toNumber, parseDate, toISODate, addDays, daysBetween } from '../core/parse.js';
import { median } from '../core/stats.js';

const BASE = 'https://api.nasdaq.com/api';

/** Deballe l'enveloppe Nasdaq { data, status:{rCode} } et signale les erreurs metier. */
function unwrap(payload, label) {
  const code = payload?.status?.rCode;
  if (code && code !== 200) {
    const message = payload?.status?.bCodeMessage?.[0]?.errorMessage || `code ${code}`;
    const error = new Error(`${label} : ${message}`);
    error.status = code === 400 ? 404 : 502;
    throw error;
  }
  return payload?.data ?? null;
}

async function nasdaq(path, { label, ttl, tracker }) {
  const payload = await fetchJson(`${BASE}${path}`, {
    label,
    ttl,
    tracker,
    headers: { Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' },
  });
  return unwrap(payload, label);
}

/* ------------------------------------------------------------------ */
/* Cotation et identite                                                */
/* ------------------------------------------------------------------ */

export async function fetchQuote(ticker, tracker) {
  const data = await nasdaq(`/quote/${ticker}/info?assetclass=stocks`, {
    label: `Nasdaq · cotation ${ticker}`,
    ttl: CONFIG.cacheTtl.quote,
    tracker,
  });
  if (!data) return null;

  const primary = data.primaryData || {};
  return {
    symbol: data.symbol || ticker,
    companyName: data.companyName || null,
    exchange: data.exchange || null,
    price: toNumber(primary.lastSalePrice),
    change: toNumber(primary.netChange),
    changePercent: toNumber(primary.percentageChange),
    volume: toNumber(primary.volume),
    isRealTime: primary.isRealTime ?? null,
    asOf: primary.lastTradeTimestamp || null,
  };
}

export async function fetchSummary(ticker, tracker) {
  const data = await nasdaq(`/quote/${ticker}/summary?assetclass=stocks`, {
    label: `Nasdaq · fiche société ${ticker}`,
    ttl: CONFIG.cacheTtl.slow,
    tracker,
  });
  const s = data?.summaryData;
  if (!s) return null;

  const [high52, low52] = String(s.FiftTwoWeekHighLow?.value || '').split('/').map(toNumber);

  return {
    sector: s.Sector?.value || null,
    industry: s.Industry?.value || null,
    marketCap: toNumber(s.MarketCap?.value),
    averageVolume: toNumber(s.AverageVolume?.value),
    previousClose: toNumber(s.PreviousClose?.value),
    oneYearTarget: toNumber(s.OneYrTarget?.value),
    fiftyTwoWeekHigh: high52 ?? null,
    fiftyTwoWeekLow: low52 ?? null,
    dividendYield: toNumber(s.Yield?.value),
  };
}

/* ------------------------------------------------------------------ */
/* Historique de prix                                                  */
/* ------------------------------------------------------------------ */

/** Retourne les bougies quotidiennes par ordre chronologique croissant. */
export async function fetchHistory(ticker, tracker, days = CONFIG.analysis.historyDays) {
  const today = new Date();
  const from = toISODate(addDays(today, -days));
  const to = toISODate(today);

  const data = await nasdaq(
    `/quote/${ticker}/historical?assetclass=stocks&fromdate=${from}&todate=${to}&limit=${days}`,
    { label: `Nasdaq · historique ${ticker}`, ttl: CONFIG.cacheTtl.history, tracker },
  );

  const rows = data?.tradesTable?.rows || [];
  const bars = rows
    .map((row) => ({
      date: parseDate(row.date),
      open: toNumber(row.open),
      high: toNumber(row.high),
      low: toNumber(row.low),
      close: toNumber(row.close),
      volume: toNumber(row.volume),
    }))
    .filter((bar) => bar.date && bar.close !== null)
    .sort((a, b) => a.date - b.date);

  return bars;
}

/* ------------------------------------------------------------------ */
/* Résultats : surprises passées, estimations, date du prochain rendez-vous */
/* ------------------------------------------------------------------ */

export async function fetchEarningsSurprises(ticker, tracker) {
  const data = await nasdaq(`/company/${ticker}/earnings-surprise`, {
    label: `Nasdaq · surprises de résultats ${ticker}`,
    ttl: CONFIG.cacheTtl.earnings,
    tracker,
  });

  const rows = data?.earningsSurpriseTable?.rows || [];
  return rows
    .map((row) => ({
      fiscalQuarter: row.fiscalQtrEnd || null,
      reportedAt: parseDate(row.dateReported),
      eps: toNumber(row.eps),
      consensus: toNumber(row.consensusForecast),
      surprisePercent: toNumber(row.percentageSurprise),
    }))
    .filter((row) => row.reportedAt)
    .sort((a, b) => b.reportedAt - a.reportedAt);
}

export async function fetchEarningsForecast(ticker, tracker) {
  const data = await nasdaq(`/analyst/${ticker}/earnings-forecast`, {
    label: `Nasdaq · estimations analystes ${ticker}`,
    ttl: CONFIG.cacheTtl.earnings,
    tracker,
  });

  const map = (rows) =>
    (rows || []).map((row) => ({
      period: row.fiscalEnd || null,
      consensus: toNumber(row.consensusEPSForecast),
      high: toNumber(row.highEPSForecast),
      low: toNumber(row.lowEPSForecast),
      estimates: toNumber(row.noOfEstimates),
      revisionsUp: toNumber(row.up),
      revisionsDown: toNumber(row.down),
    }));

  return {
    quarterly: map(data?.quarterlyForecast?.rows),
    yearly: map(data?.yearlyForecast?.rows),
  };
}

/**
 * Date des prochains résultats.
 *
 * Trois niveaux de fiabilite, du meilleur au moins bon :
 *  1. `confirmed`  - le calendrier Nasdaq liste le titre à cette date ;
 *  2. `expected`   - le fournisseur (Zacks) annonce la date ;
 *  3. `estimated`  - on l'extrapole du rythme trimestriel passe.
 * Le niveau est remonte à l'UI : un pari base sur une date estimée n'a pas
 * la même valeur qu'un pari base sur une date confirmée.
 */
export async function fetchEarningsDate(ticker, tracker, surprises = []) {
  let vendor = null;
  try {
    vendor = await nasdaq(`/analyst/${ticker}/earnings-date`, {
      label: `Nasdaq · date des résultats ${ticker}`,
      ttl: CONFIG.cacheTtl.earnings,
      tracker,
    });
  } catch {
    // Non bloquant : on bascule sur l'estimation.
  }

  const text = `${vendor?.announcement || ''} ${vendor?.reportText || ''}`;
  const announced = parseAnnouncedDate(vendor);
  // Une date déjà passée signale une donnée fournisseur perimee : on
  // préfère l'extrapolation a une échéance qui n'a plus de sens.
  const stillAhead = announced && daysBetween(new Date(), announced) >= 0;

  if (stillAhead) {
    return {
      date: announced,
      timing: parseTiming(text),
      confidence: /is expected\*? to report/i.test(text) ? 'expected' : 'estimated',
      source: 'Nasdaq (Zacks)',
    };
  }

  const projected = projectNextEarnings(surprises);
  if (!projected) return null;

  // Le calendrier officiel ne porte que sur les semaines a venir : au-dela,
  // le balayage coute une dizaine de requêtes pour rien.
  const horizon = daysBetween(new Date(), projected.date);
  if (horizon !== null && horizon <= 35) {
    const confirmed = await confirmInCalendar(ticker, projected.date, tracker);
    if (confirmed) return confirmed;
  }

  return { ...projected, source: 'Extrapolation du rythme trimestriel' };
}

function parseAnnouncedDate(vendor) {
  if (!vendor) return null;
  const fromAnnouncement = String(vendor.announcement || '').split(':').slice(1).join(':').trim();
  const parsed = parseDate(fromAnnouncement);
  if (parsed) return parsed;

  const match = String(vendor.reportText || '').match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
  return match ? parseDate(match[1]) : null;
}

function parseTiming(text) {
  if (/after\s+(the\s+)?market\s+close|after[- ]hours/i.test(text)) return 'after-close';
  if (/before\s+(the\s+)?market\s+open|pre[- ]?market/i.test(text)) return 'before-open';
  return 'unknown';
}

/**
 * Extrapole la prochaîne publication a partir des dates passées.
 *
 * L'ancrage le plus fiable est annuel : une société publie son trimestre
 * fiscal a peu pres a la même date d'une annee sur l'autre. On prend donc la
 * publication du même trimestre un an plus tot et on ajoute 52 semaines, ce
 * qui conserve aussi le jour de semaine. Sans quatre trimestres d'historique,
 * on retombe sur l'écart median entre publications (~91 jours), nettement
 * moins fiable pour les sociétés au calendrier fiscal decale.
 */
export function projectNextEarnings(surprises, now = new Date()) {
  const dates = (surprises || []).map((s) => s.reportedAt).filter(Boolean).sort((a, b) => b - a);
  if (!dates.length) return null;

  const gaps = [];
  for (let i = 0; i < dates.length - 1; i += 1) {
    const gap = daysBetween(dates[i + 1], dates[i]);
    if (gap > 60 && gap < 130) gaps.push(gap);
  }
  const cadence = Math.round(gaps.length ? median(gaps) : 91);

  // 52 semaines après le même trimestre fiscal de l'an dernier.
  const sameQuarterLastYear = dates[3] || null;
  let next = sameQuarterLastYear ? addDays(sameQuarterLastYear, 364) : null;
  let basis = 'annuel';

  // L'ancrage annuel doit tomber après la dernière publication connue, sinon
  // il est incoherent et la cadence trimestrielle reprend la main.
  if (!next || daysBetween(dates[0], next) < 45) {
    next = addDays(dates[0], cadence);
    basis = 'cadence';
  }

  // Si la date obtenue est déjà passée, l'historique n'a pas été rafraichi :
  // on avance de trimestre en trimestre jusqu'a repasser dans le futur.
  let guard = 0;
  while (daysBetween(now, next) < 0 && guard < 8) {
    next = addDays(next, cadence);
    basis = 'cadence';
    guard += 1;
  }

  if (next.getUTCDay() === 6) next = addDays(next, 2);
  if (next.getUTCDay() === 0) next = addDays(next, 1);

  return { date: next, timing: 'unknown', confidence: 'estimated', basis };
}

/**
 * Cherche le ticker dans le calendrier officiel, sur une fenetre de jours
 * ouvres autour de la date visee. Les jours sont interroges en parallele et
 * on retient la correspondance la plus proche de l'estimation.
 */
async function confirmInCalendar(ticker, aroundDate, tracker) {
  const offsets = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7]
    .map((offset) => ({ offset, day: addDays(aroundDate, offset) }))
    .filter(({ day }) => day.getUTCDay() !== 0 && day.getUTCDay() !== 6);

  const lookups = await Promise.allSettled(
    offsets.map(async ({ offset, day }) => {
      const data = await nasdaq(`/calendar/earnings?date=${toISODate(day)}`, {
        label: `Nasdaq · calendrier ${toISODate(day)}`,
        ttl: CONFIG.cacheTtl.calendar,
        tracker,
      });
      const hit = (data?.rows || []).find(
        (row) => String(row.symbol).toUpperCase() === ticker.toUpperCase(),
      );
      return hit ? { offset, day, hit } : null;
    }),
  );

  const found = lookups
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result) => result.value)
    .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0];

  if (!found) return null;

  const timings = { 'time-after-hours': 'after-close', 'time-pre-market': 'before-open' };
  return {
    date: found.day,
    timing: timings[found.hit.time] || 'unknown',
    confidence: 'confirmed',
    source: 'Calendrier officiel Nasdaq',
    consensusEps: toNumber(found.hit.epsForecast),
    fiscalQuarter: found.hit.fiscalQuarterEnding || null,
  };
}

/* ------------------------------------------------------------------ */
/* Consensus, short interest, actionnariat                             */
/* ------------------------------------------------------------------ */

export async function fetchRatings(ticker, tracker) {
  const data = await nasdaq(`/analyst/${ticker}/ratings`, {
    label: `Nasdaq · consensus analystes ${ticker}`,
    ttl: CONFIG.cacheTtl.slow,
    tracker,
  });
  if (!data) return null;

  const count = toNumber(String(data.ratingsSummary || '').match(/(\d+)\s+analysts?/i)?.[1]);
  return {
    consensus: data.meanRatingType || null,
    analystCount: count ?? (data.brokerNames?.length || null),
    summary: data.ratingsSummary || null,
  };
}

export async function fetchShortInterest(ticker, tracker) {
  const data = await nasdaq(`/quote/${ticker}/short-interest?assetClass=stocks`, {
    label: `Nasdaq · short interest ${ticker}`,
    ttl: CONFIG.cacheTtl.slow,
    tracker,
  });

  const rows = (data?.shortInterestTable?.rows || [])
    .map((row) => ({
      settlementDate: parseDate(row.settlementDate),
      shares: toNumber(row.interest),
      avgDailyVolume: toNumber(row.avgDailyShareVolume),
      daysToCover: toNumber(row.daysToCover),
    }))
    .filter((row) => row.settlementDate)
    .sort((a, b) => b.settlementDate - a.settlementDate);

  return rows.length ? rows : null;
}

export async function fetchInstitutional(ticker, tracker) {
  const data = await nasdaq(
    `/company/${ticker}/institutional-holdings?limit=15&type=TOTAL&sortColumn=marketValue&sortOrder=DESC`,
    { label: `Nasdaq · actionnariat institutionnel ${ticker}`, ttl: CONFIG.cacheTtl.slow, tracker },
  );
  if (!data) return null;

  const byLabel = (label) =>
    (data.activePositions?.rows || []).find((row) =>
      String(row.positions || '').toLowerCase().includes(label),
    );

  const increased = byLabel('increased');
  const decreased = byLabel('decreased');

  return {
    institutionalOwnershipPercent: toNumber(data.ownershipSummary?.SharesOutstandingPCT?.value),
    increasedHolders: toNumber(increased?.holders),
    decreasedHolders: toNumber(decreased?.holders),
    increasedShares: toNumber(increased?.shares),
    decreasedShares: toNumber(decreased?.shares),
  };
}
