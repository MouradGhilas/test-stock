/** Petites fonctions statistiques, sans dependance externe. */

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

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

export function round(value, digits = 2) {
  if (!isNum(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
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
