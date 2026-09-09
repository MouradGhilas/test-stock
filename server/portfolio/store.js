/**
 * Magasin des positions : un fichier JSON, écrit d'un bloc.
 *
 * Le journal d'observations (`core/store.js`) écrit en append : il ne perd
 * jamais rien mais ne sait rien modifier. Ici c'est l'inverse -- on déplace des
 * stops, on solde des lignes -- donc un document réécrit à chaque changement.
 *
 * Deux précautions, parce que c'est le seul endroit de l'application où une
 * panne perd des données de l'utilisateur :
 *
 *   1. écriture dans un fichier temporaire puis `rename`, atomique sur le même
 *      système de fichiers : une coupure laisse l'ancien fichier intact plutôt
 *      qu'un JSON tronqué ;
 *   2. sérialisation des écritures, pour que deux requêtes simultanées ne se
 *      relisent pas mutuellement et n'en perdent pas une au passage.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config.js';
import { normalizeNewTrade, applyPatch } from './trade.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.TRADES_DIR || path.join(ROOT, '..', '..', 'data');
const FILE = path.join(DIR, 'trades.json');

export const DEFAULT_SETTINGS = {
  capital: CONFIG.portfolio.defaultCapital,
  riskPerTradePct: CONFIG.portfolio.riskPerTradePct,
  // Sortie appliquée d'office quand le signal ne donne pas de stop.
  stopPercent: CONFIG.portfolio.defaultStopPercent,
  // Frais de courtage par ordre, pour le seuil de rentabilité.
  feeFixed: CONFIG.portfolio.feeFixed,
  feePercent: CONFIG.portfolio.feePercent,
  currency: 'USD',
};

/* --- File d'attente d'écriture : une mutation à la fois --- */
let queue = Promise.resolve();

function serialize(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

function invalid(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** Lit le portefeuille. Un fichier absent ou illisible donne un portefeuille vide. */
export async function read() {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    return {
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      trades: Array.isArray(parsed.trades) ? parsed.trades : [],
    };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, trades: [] };
  }
}

async function write(portfolio) {
  await mkdir(DIR, { recursive: true });
  const temporary = `${FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(portfolio, null, 2)}\n`, 'utf8');
  await rename(temporary, FILE);
}

/** Lecture, modification, écriture -- sans qu'une autre requête s'y glisse. */
function mutate(change) {
  return serialize(async () => {
    const portfolio = await read();
    const result = await change(portfolio);
    await write(portfolio);
    return result;
  });
}

function find(portfolio, id) {
  const index = portfolio.trades.findIndex((t) => t.id === id);
  if (index < 0) throw invalid('Position introuvable.', 404);
  return index;
}

/* ------------------------------------------------------------------ */
/* Opérations                                                          */
/* ------------------------------------------------------------------ */

export function createTrade(input) {
  return mutate((portfolio) => {
    const trade = normalizeNewTrade(input);
    portfolio.trades.push(trade);
    return trade;
  });
}

export function updateTrade(id, patch) {
  return mutate((portfolio) => {
    const index = find(portfolio, id);
    const updated = applyPatch(portfolio.trades[index], patch);
    portfolio.trades[index] = updated;
    return updated;
  });
}

/**
 * Supprime des positions et rend celles qui l'ont été : l'appelant s'en sert
 * pour effacer les captures qui les accompagnaient.
 */
export function deleteTrades(ids) {
  const wanted = new Set(ids);
  return mutate((portfolio) => {
    const removed = portfolio.trades.filter((t) => wanted.has(t.id));
    portfolio.trades = portfolio.trades.filter((t) => !wanted.has(t.id));
    return { deleted: removed.length, removed };
  });
}

/**
 * Applique la même modification à plusieurs lignes.
 *
 * C'est l'opération qui manque quand on suit quinze signaux : solder tout ce
 * qui a touché son stop, remonter dix stops à l'équilibre. Le tout dans une
 * seule écriture -- soit tout passe, soit rien.
 *
 * @param {string[]} ids
 * @param {(trade: object) => object|null} patchFor Modification par ligne, ou
 *   `null` pour laisser la ligne inchangée.
 */
export function patchMany(ids, patchFor) {
  const wanted = new Set(ids);
  return mutate((portfolio) => {
    const changed = [];
    const skipped = [];

    portfolio.trades = portfolio.trades.map((trade) => {
      if (!wanted.has(trade.id)) return trade;
      let patch;
      try {
        patch = patchFor(trade);
      } catch (error) {
        skipped.push({ id: trade.id, ticker: trade.ticker, reason: error.message });
        return trade;
      }
      if (!patch) {
        skipped.push({ id: trade.id, ticker: trade.ticker, reason: 'rien à modifier' });
        return trade;
      }
      try {
        const updated = applyPatch(trade, patch);
        changed.push(updated);
        return updated;
      } catch (error) {
        skipped.push({ id: trade.id, ticker: trade.ticker, reason: error.message });
        return trade;
      }
    });

    return { changed, skipped };
  });
}

export function updateSettings(patch = {}) {
  return mutate((portfolio) => {
    const settings = { ...portfolio.settings };

    if ('capital' in patch) {
      const capital = Number(patch.capital);
      if (!Number.isFinite(capital) || capital <= 0) throw invalid('Capital : nombre strictement positif attendu.');
      settings.capital = capital;
    }

    if ('riskPerTradePct' in patch) {
      const risk = Number(patch.riskPerTradePct);
      if (!Number.isFinite(risk) || risk <= 0 || risk > 100) throw invalid('Risque par position : pourcentage entre 0 et 100 attendu.');
      settings.riskPerTradePct = risk;
    }

    // Un pourcentage de réglage, borné. Zéro est accepté pour des frais -- la
    // plupart des courtiers n'en prennent plus -- mais pas pour un stop, qui
    // sortirait alors au prix d'entrée.
    const percentField = (field, label, min, max) => {
      if (!(field in patch)) return;
      const value = Number(patch[field]);
      if (!Number.isFinite(value) || value < min || value > max) {
        throw invalid(`${label} : pourcentage entre ${min} et ${max} attendu.`);
      }
      settings[field] = value;
    };

    percentField('stopPercent', 'Sortie automatique', 0.1, 99);
    percentField('feePercent', 'Frais proportionnels', 0, 10);

    if ('feeFixed' in patch) {
      const value = Number(patch.feeFixed);
      if (!Number.isFinite(value) || value < 0) throw invalid('Frais fixes : montant positif ou nul attendu.');
      settings.feeFixed = value;
    }

    if ('currency' in patch) {
      const currency = String(patch.currency).toUpperCase().slice(0, 4);
      if (!/^[A-Z]{3,4}$/.test(currency)) throw invalid('Devise invalide.');
      settings.currency = currency;
    }

    portfolio.settings = settings;
    return settings;
  });
}

export const FILE_PATH = FILE;
