/** Petites fonctions statistiques, sans dependance externe. */

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function mean(values) {
  const v = values.filter(isNum);
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export function median(values) {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function stdev(values) {
  const v = values.filter(isNum);
  if (v.length < 2) return null;
  const m = mean(v);
  const variance = v.reduce((acc, x) => acc + (x - m) ** 2, 0) / (v.length - 1);
  return Math.sqrt(variance);
}

/** Interpolation lineaire d'une valeur x entre deux bornes, ramenee sur [outMin, outMax]. */
export function scale(x, inMin, inMax, outMin, outMax) {
  if (!isNum(x) || inMax === inMin) return null;
  const t = clamp((x - inMin) / (inMax - inMin), 0, 1);
  return outMin + t * (outMax - outMin);
}

export function pctChange(from, to) {
  if (!isNum(from) || !isNum(to) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

export function round(value, digits = 2) {
  if (!isNum(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Corrélation linéaire de Pearson entre deux séries appariées. */
export function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => isNum(x) && isNum(y));
  if (pairs.length < 3) return null;

  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : num / den;
}

/** Rangs moyens d'une série, ex aequo partagés. */
function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);

  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[order[k][1]] = rank;
    i = j + 1;
  }
  return out;
}

/**
 * Corrélation de rang de Spearman. Plus robuste que Pearson sur des
 * rendements financiers, dont les valeurs extrêmes dominent la variance.
 */
export function spearman(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => isNum(x) && isNum(y));
  if (pairs.length < 3) return null;
  return pearson(ranks(pairs.map((p) => p[0])), ranks(pairs.map((p) => p[1])));
}

/**
 * Erreur standard de la moyenne : sans elle, comparer deux moyennes
 * d'échantillon ne dit rien de la solidité de l'écart observé.
 */
export function standardError(values) {
  const v = values.filter(isNum);
  const sd = stdev(v);
  return sd === null ? null : sd / Math.sqrt(v.length);
}
