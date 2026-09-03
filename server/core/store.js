/**
 * Journal d'observations : chaque analyse laisse une trace horodatée.
 *
 * Raison d'être : aucune source gratuite ne donne l'historique de volatilité
 * implicite. On ne peut pas savoir ce que le marché des options pricait il y a
 * trois semaines -- sauf à l'avoir noté soi-même. Ce journal est donc la seule
 * façon de répondre un jour à « depuis combien de temps est-ce anticipé ».
 *
 * Il se constitue au fil des consultations : les premières analyses d'un titre
 * ne diront rien, les suivantes montreront la pente. C'est aussi le jeu de
 * données point-in-time qui manque pour backtester un jour le facteur le plus
 * lourd du barème.
 *
 * Format : une ligne JSON par observation, un fichier par ticker. Volontairement
 * trivial -- pas de base de données à installer, un fichier lisible à l'oeil,
 * et une écriture qui ne peut pas casser une analyse.
 */

import { appendFile, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.SNAPSHOT_DIR || path.join(ROOT, '..', '..', 'data', 'snapshots');

/** Au-delà, on réécrit le fichier en ne gardant que les observations récentes. */
const MAX_LINES = 500;

/**
 * Nom de fichier sûr pour un ticker.
 *
 * Le point est autorisé (BRK.B), mais jamais en tête : un nom commençant par
 * des points n'a aucun sens pour un ticker et brouille la lecture du
 * répertoire. Tout le reste, séparateurs de chemin compris, est retiré, de
 * sorte que le résultat ne puisse désigner qu'un fichier de ce répertoire.
 */
export function safeFileName(ticker) {
  const cleaned = String(ticker).toUpperCase().replace(/[^A-Z0-9.-]/g, '').replace(/^[.\-]+/, '');
  return `${cleaned || 'INCONNU'}.jsonl`;
}

const fileFor = (ticker) => path.join(DIR, safeFileName(ticker));

/**
 * Ajoute une observation. N'échoue jamais : un disque plein ou en lecture
 * seule ne doit pas empêcher de rendre une analyse.
 */
export async function appendSnapshot(ticker, snapshot) {
  try {
    await mkdir(DIR, { recursive: true });
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...snapshot })}\n`;
    await appendFile(fileFor(ticker), line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Lit les observations d'un ticker, de la plus ancienne à la plus récente. */
export async function readSnapshots(ticker) {
  try {
    const raw = await readFile(fileFor(ticker), 'utf8');
    const lines = raw.split('\n').filter(Boolean);

    if (lines.length > MAX_LINES) {
      // Élagage opportuniste, sans bloquer l'appelant.
      writeFile(fileFor(ticker), `${lines.slice(-MAX_LINES).join('\n')}\n`, 'utf8').catch(() => {});
    }

    return lines
      .slice(-MAX_LINES)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  } catch {
    return [];
  }
}

/**
 * Observations rattachées à une échéance de publication donnée.
 *
 * Le filtrage par date de publication est essentiel : comparer le mouvement
 * implicite d'un trimestre à celui du précédent n'aurait aucun sens, ce ne
 * sont pas les mêmes événements.
 */
export async function readCycleSnapshots(ticker, earningsDate) {
  if (!earningsDate) return [];
  const all = await readSnapshots(ticker);
  return all.filter(
    (s) => s.earningsDate === earningsDate && typeof s.impliedMovePercent === 'number',
  );
}
