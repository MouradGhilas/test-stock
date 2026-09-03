/**
 * Client HTTP unique de l'application.
 *
 * Il apporte quatre choses que `fetch` seul ne donne pas :
 *  - un timeout dur et des réessais avec backoff exponentiel,
 *  - un plafond de requêtes simultanees (on reste poli avec les sources),
 *  - le cache TTL partage,
 *  - la traçabilité : chaque appel est enregistre dans un "tracker" pour
 *    être affiche à l'utilisateur (URL, statut, latence, taille, cache).
 */

import { CONFIG } from '../config.js';
import { remember, get as cacheGet, set as cacheSet } from './cache.js';

let active = 0;
const queue = [];

function acquire() {
  if (active < CONFIG.http.maxConcurrent) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release() {
  active -= 1;
  const next = queue.shift();
  if (next) {
    active += 1;
    next();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Cree un collecteur de télémétrie a passer aux sources. */
export function createTracker() {
  const entries = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
      return entry;
    },
    /** Marque une source comme non recuperee (erreur, vide, désactivée). */
    note(label, status, detail) {
      return this.record({ label, ok: false, status, detail, ms: 0 });
    },
  };
}

/**
 * Recupere une URL en texte brut.
 * @param {object} options
 * @param {string} options.label  Nom lisible de la source (affiche dans l'UI).
 * @param {number} options.ttl    Durée de cache en secondes.
 */
export async function fetchText(url, options = {}) {
  const {
    label = url,
    ttl = 300,
    headers = {},
    tracker = null,
    timeoutMs = CONFIG.http.timeoutMs,
    retries = CONFIG.http.retries,
    circuit = 'url',
  } = options;

  const started = Date.now();
  const urlKey = `fail:url:${url}`;
  const hostKey = `fail:host:${hostOf(url)}`;

  // Disjoncteur : une source qui vient d'echouer est écartée quelques minutes
  // plutot que re-sollicitée à chaque analyse. Sans cela, un agregateur en
  // panne consomme tout le budget de temps en réessais.
  //
  // Deux granularites. Par défaut on ne mémorise que l'URL exacte : sur une
  // API par ticker, l'échec d'un symbole ne dit rien des autres. Les sources
  // declarees `circuit: 'host'` (les agregateurs d'actualités, interchangeables)
  // coupent au niveau du domaine, mais seulement sur une panne serveur --
  // jamais sur un 404, qui ne concerne que la ressource demandée.
  const recentFailure = cacheGet(urlKey) || (circuit === 'host' ? cacheGet(hostKey) : null);
  if (recentFailure) {
    const error = Object.assign(new Error(recentFailure.message), {
      status: recentFailure.status,
      skipped: true,
    });
    tracker?.record({
      label,
      url,
      ok: false,
      status: recentFailure.status,
      detail: `Source écartée : échec recent (${recentFailure.message})`,
      ms: 0,
    });
    throw error;
  }

  let result;

  try {
    const { value, cached } = await remember(`http:${url}`, ttl, () =>
      request(url, { headers, timeoutMs, retries }),
    );
    result = {
      label,
      url,
      ok: true,
      status: value.status,
      bytes: value.body.length,
      ms: Date.now() - started,
      cached,
    };
    tracker?.record(result);
    return value.body;
  } catch (error) {
    const memo = { status: error.status ?? null, message: error.message };
    cacheSet(urlKey, memo, CONFIG.http.failureTtlSeconds);

    const serverSide = !error.status || error.status >= 500;
    if (circuit === 'host' && serverSide) {
      cacheSet(hostKey, memo, CONFIG.http.failureTtlSeconds);
    }
    tracker?.record({
      label,
      url,
      ok: false,
      status: error.status ?? null,
      detail: error.message,
      ms: Date.now() - started,
    });
    throw error;
  }
}

/** Idem, mais parse le JSON. Retourne null si le corps n'est pas du JSON. */
export async function fetchJson(url, options = {}) {
  const body = await fetchText(url, options);
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error(`Reponse non-JSON depuis ${url}`);
    error.status = 502;
    throw error;
  }
}

async function request(url, { headers, timeoutMs, retries }) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': CONFIG.http.userAgent,
          Accept: 'application/json, text/plain, text/html, */*',
          'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
          ...headers,
        },
      });

      const body = await response.text();

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} sur ${url}`);
        error.status = response.status;
        // 4xx (hors 429) : inutile de reessayer, la reponse ne changera pas.
        if (response.status < 500 && response.status !== 429) throw Object.assign(error, { final: true });
        throw error;
      }

      return { status: response.status, body };
    } catch (error) {
      lastError = error.name === 'AbortError'
        ? Object.assign(new Error(`Timeout après ${timeoutMs} ms sur ${url}`), { status: 504 })
        : error;
      if (lastError.final || attempt === retries) break;
      await sleep(CONFIG.http.backoffMs * 2 ** attempt);
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  throw lastError;
}
