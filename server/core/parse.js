/**
 * Normalisation des données scrapees.
 *
 * Les sources renvoient des chaînes destinees a l'affichage humain
 * ("$1,234.56", "3.21%", "N/A", "09/08/2026", "Sep 24, 2026"). Tout passe
 * par ici avant d'entrer dans le moteur d'analyse.
 */

const NA = new Set(['', 'n/a', 'na', 'null', 'undefined', '--', '-', 'nm']);

/** "$1,234.56" -> 1234.56 ; "(2.5)" -> -2.5 ; "N/A" -> null */
export function toNumber(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (input === null || input === undefined) return null;

  let text = String(input).trim();
  if (NA.has(text.toLowerCase())) return null;

  const negative = /^\(.*\)$/.test(text);
  text = text.replace(/^\((.*)\)$/, '$1');
  text = text.replace(/[$€£¥,\s]/g, '').replace(/%$/, '');

  // Suffixes d'echelle : 1.2B -> 1 200 000 000
  const scaleMatch = text.match(/^(-?\d*\.?\d+)([KMBT])$/i);
  if (scaleMatch) {
    const factors = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
    const value = Number(scaleMatch[1]) * factors[scaleMatch[2].toLowerCase()];
    return negative ? -value : value;
  }

  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** "3.21%" -> 3.21 (on garde l'unite "pourcent", pas la fraction). */
export const toPercent = toNumber;

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Accepte "09/08/2026", "9/8/2026", "Sep 24, 2026", "2026-09-08".
 * Retourne une Date en UTC a minuit, ou null.
 */
export function parseDate(input) {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (input === null || input === undefined) return null;

  const text = String(input).trim();
  if (!text || NA.has(text.toLowerCase())) return null;

  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return utc(+m[1], +m[2] - 1, +m[3]);

  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return utc(+m[3], +m[1] - 1, +m[2]);

  m = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return utc(+m[3], month, +m[2]);
  }

  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function utc(year, month, day) {
  const d = new Date(Date.UTC(year, month, day));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Timestamp UNIX (secondes ou millisecondes) -> Date. */
export function fromUnix(value) {
  const n = toNumber(value);
  if (n === null) return null;
  return new Date(n > 1e11 ? n : n * 1000);
}

export function toISODate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** Nombre de jours calendaires entre deux dates (b - a). */
export function daysBetween(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) return null;
  const dayMs = 86_400_000;
  const from = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const to = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((to - from) / dayMs);
}

export function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Decode les entites XML/HTML les plus courantes des flux RSS. */
export function decodeEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .trim();
}

/** Retire les balises HTML d'un fragment scrapé. */
export function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalise un ticker saisi par l'utilisateur. Retourne null si invalide. */
export function normalizeTicker(input) {
  const t = String(input || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) return null;
  return t;
}
