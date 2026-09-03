/**
 * Indicateurs techniques calcules sur l'historique quotidien.
 * Les bougies sont attendues par ordre chronologique croissant.
 */

import { mean, stdev, isNum } from '../core/stats.js';

const closes = (bars) => bars.map((b) => b.close).filter(isNum);

/** Moyenne mobile simple sur les `period` dernières séances. */
export function sma(bars, period) {
  const values = closes(bars);
  if (values.length < period) return null;
  return mean(values.slice(-period));
}

/**
 * RSI de Wilder. Au-dessus de 70 le titre est considere sur-acacte,
 * en dessous de 30 sur-vendu.
 */
export function rsi(bars, period = 14) {
  const values = closes(bars);
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Lissage exponentiel de Wilder sur le reste de la serie.
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }

  // Serie parfaitement plate : ni gain ni perte. Le rapport n'est pas defini,
  // et l'interpretation correcte est la neutralite, pas le surachat maximal.
  if (avgLoss === 0 && avgGain === 0) return 50;
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Average True Range : amplitude moyenne d'une séance, en valeur absolue. */
export function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < bars.length; i += 1) {
    const { high, low } = bars[i];
    const prevClose = bars[i - 1].close;
    if (!isNum(high) || !isNum(low) || !isNum(prevClose)) continue;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  return trueRanges.length >= period ? mean(trueRanges.slice(-period)) : null;
}

/** Volatilité realisee annualisee, en pourcentage. */
export function realizedVolatility(bars, period = 30) {
  const values = closes(bars);
  if (values.length < period + 1) return null;

  const returns = [];
  for (let i = values.length - period; i < values.length; i += 1) {
    if (values[i - 1] > 0) returns.push(Math.log(values[i] / values[i - 1]));
  }

  const sd = stdev(returns);
  return sd === null ? null : sd * Math.sqrt(252) * 100;
}

/** Performance sur les `sessions` dernières séances, en pourcentage. */
export function performance(bars, sessions) {
  const values = closes(bars);
  if (values.length <= sessions) return null;
  const from = values[values.length - 1 - sessions];
  const to = values[values.length - 1];
  return from > 0 ? ((to - from) / from) * 100 : null;
}

/** Extremes sur 52 semaines et distance actuelle a ces extremes. */
export function fiftyTwoWeekRange(bars) {
  const window = bars.slice(-252);
  const highs = window.map((b) => b.high ?? b.close).filter(isNum);
  const lows = window.map((b) => b.low ?? b.close).filter(isNum);
  const last = closes(bars).at(-1);
  if (!highs.length || !lows.length || !isNum(last)) return null;

  const high = Math.max(...highs);
  const low = Math.min(...lows);
  return {
    high,
    low,
    fromHighPercent: high > 0 ? ((last - high) / high) * 100 : null,
    fromLowPercent: low > 0 ? ((last - low) / low) * 100 : null,
  };
}

/** Ensemble des indicateurs utilises par le moteur de décision. */
export function computeIndicators(bars) {
  if (!bars || bars.length < 20) return null;
  const last = bars.at(-1);

  return {
    lastClose: last.close,
    lastDate: last.date,
    sessions: bars.length,
    sma20: sma(bars, 20),
    sma50: sma(bars, 50),
    sma200: sma(bars, 200),
    rsi14: rsi(bars, 14),
    atr14: atr(bars, 14),
    atrPercent: (() => {
      const a = atr(bars, 14);
      return a !== null && last.close > 0 ? (a / last.close) * 100 : null;
    })(),
    realizedVol30: realizedVolatility(bars, 30),
    perf5: performance(bars, 5),
    perf21: performance(bars, 21),
    perf63: performance(bars, 63),
    range52w: fiftyTwoWeekRange(bars),
  };
}
