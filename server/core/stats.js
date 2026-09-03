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
