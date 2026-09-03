/**
 * Source : EDGAR, le dépôt officiel de la SEC.
 *
 * Une société américaine annonce ses résultats par un formulaire 8-K portant
 * l'item 2.02 (« Results of Operations and Financial Condition »). EDGAR
 * horodate chaque dépôt à la seconde. Cela apporte deux choses qu'aucune
 * autre source gratuite ne donne :
 *
 *  1. **L'horaire de publication, en fait établi plutôt que déduit.** Savoir
 *     si la société a publié avant l'ouverture ou après la clôture détermine
 *     la séance de réaction ; se tromper inverse le signe de la réaction.
 *     L'heure d'acceptation du dépôt tranche la question.
 *
 *  2. **La profondeur d'historique.** Les fournisseurs de marché exposent
 *     quatre trimestres ; EDGAR remonte à 1994. Sur quatre observations,
 *     « le titre monte 75 % du temps » ne veut rien dire -- trois fois sur
 *     quatre arrive par hasard. Sur vingt, la mesure devient lisible.
 *
 * La SEC impose un User-Agent identifiant l'appelant : il est déclaré dans
 * la configuration.
 */

import { CONFIG } from '../config.js';
import { fetchJson } from '../core/http.js';
import { parseDate } from '../core/parse.js';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS = (cik) => `https://data.sec.gov/submissions/CIK${cik}.json`;
const ARCHIVE = (name) => `https://data.sec.gov/submissions/${name}`;

/** Item 8-K signalant une publication de résultats. */
const EARNINGS_ITEM = '2.02';

const headers = () => ({ 'User-Agent': CONFIG.http.secUserAgent });

/* ------------------------------------------------------------------ */
/* Horaires : tout se raisonne en heure de New York                    */
/* ------------------------------------------------------------------ */

const NEW_YORK = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

const OPEN_MINUTES = 9 * 60 + 30;
const CLOSE_MINUTES = 16 * 60;

/**
 * Convertit un horodatage UTC en date et heure de séance new-yorkaise.
 * Le passage par le fuseau est indispensable : un dépôt accepté à
 * 00h30 UTC correspond à 19h30 la veille à New York.
 */
export function toMarketTime(isoUtc) {
  // `new Date(null)` vaut l'époque Unix, pas une date invalide : sans ce
  // filtre, un horodatage manquant deviendrait silencieusement 1969.
  if (typeof isoUtc !== 'string' || !isoUtc.trim()) return null;

  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return null;

  const parts = Object.fromEntries(
    NEW_YORK.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour) % 24;
  const minutes = hour * 60 + Number(parts.minute);

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes,
    timing:
      minutes >= CLOSE_MINUTES ? 'after-close'
        : minutes < OPEN_MINUTES ? 'before-open'
          : 'during-session',
  };
}

/* ------------------------------------------------------------------ */
/* Résolution du ticker vers l'identifiant SEC                         */
/* ------------------------------------------------------------------ */

/** @returns {string|null} CIK sur 10 chiffres, format attendu par EDGAR. */
export async function resolveCik(ticker, tracker) {
  const table = await fetchJson(TICKERS_URL, {
    label: 'SEC · table des identifiants',
    ttl: CONFIG.cacheTtl.slow,
    tracker,
    headers: headers(),
  });

  // EDGAR note les classes d'actions avec un tiret (BRK-B) là où les places
  // de marché utilisent un point (BRK.B).
  const wanted = String(ticker).toUpperCase().replace(/\./g, '-');

  for (const entry of Object.values(table || {})) {
    if (String(entry.ticker).toUpperCase() === wanted) {
      return String(entry.cik_str).padStart(10, '0');
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Publications de résultats                                           */
/* ------------------------------------------------------------------ */

function extractFilings(recent) {
  if (!recent?.form) return [];

  const out = [];
  for (let i = 0; i < recent.form.length; i += 1) {
    if (recent.form[i] !== '8-K') continue;
    if (!String(recent.items?.[i] || '').includes(EARNINGS_ITEM)) continue;

    const accepted = recent.acceptanceDateTime?.[i];
    const market = accepted ? toMarketTime(accepted) : null;
    // Sans horodatage exploitable, le dépôt n'apporte pas ce qu'on vient
    // chercher : on garde la date, mais l'horaire reste inconnu.
    const reportedAt = parseDate(market?.date || recent.filingDate?.[i]);
    if (!reportedAt) continue;

    out.push({
      reportedAt,
      timing: market?.timing ?? null,
      acceptedAt: accepted || null,
      accession: recent.accessionNumber?.[i] || null,
    });
  }
  return out;
}

/**
 * Dates et horaires des publications de résultats passées, de la plus
 * récente à la plus ancienne.
 *
 * @param {number} years Profondeur souhaitée. Au-delà de ce que couvre le
 *   fichier courant, EDGAR renvoie vers des archives, chargées à la demande.
 */
export async function fetchEarningsFilings(ticker, tracker, years = 6) {
  const cik = await resolveCik(ticker, tracker);
  if (!cik) return null;

  const submissions = await fetchJson(SUBMISSIONS(cik), {
    label: `SEC · publications 8-K ${ticker}`,
    ttl: CONFIG.cacheTtl.earnings,
    tracker,
    headers: headers(),
  });

  let filings = extractFilings(submissions?.filings?.recent);

  const horizon = new Date();
  horizon.setUTCFullYear(horizon.getUTCFullYear() - years);

  // Les sociétés qui déposent beaucoup débordent du fichier courant : on ne
  // charge une archive que si l'horizon demandé n'est pas déjà couvert.
  const oldest = filings.at(-1)?.reportedAt;
  if (!oldest || oldest > horizon) {
    for (const file of submissions?.filings?.files || []) {
      if (parseDate(file.filingTo) < horizon) continue;
      try {
        const archive = await fetchJson(ARCHIVE(file.name), {
          label: `SEC · archive ${ticker}`,
          ttl: CONFIG.cacheTtl.slow,
          tracker,
          headers: headers(),
        });
        filings = filings.concat(extractFilings(archive));
      } catch {
        // Archive indisponible : l'historique récent suffit à travailler.
      }
    }
  }

  return filings
    .filter((f) => f.reportedAt >= horizon)
    .sort((a, b) => b.reportedAt - a.reportedAt);
}
