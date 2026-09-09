/**
 * Captures d'écran attachées aux positions.
 *
 * Beaucoup de signaux ne chiffrent rien : « regardez le TP final » renvoie au
 * graphique, et les niveaux n'existent que là. La capture n'est donc pas une
 * décoration, c'est la seule trace de ce qui a été promis -- celle qu'on
 * relira pour savoir si la thèse tient encore.
 *
 * Le stockage reste volontairement bête : un fichier par image, un identifiant
 * tiré au sort, aucun traitement d'image. Deux précautions, parce que ces
 * octets viennent du presse-papiers et seront resservis par le serveur :
 *
 *   1. le type est déduit des octets d'en-tête, jamais de ce qu'annonce le
 *      navigateur -- un fichier HTML servi depuis notre origine serait une
 *      faille, pas une image ;
 *   2. l'identifiant est vérifié caractère par caractère avant de toucher au
 *      disque, de sorte qu'aucune requête ne puisse désigner un autre fichier.
 */

import { writeFile, readFile, unlink, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(process.env.TRADES_DIR || path.join(ROOT, '..', '..', 'data'), 'images');

/** Une capture d'écran de graphique pèse rarement plus de deux mégaoctets. */
export const MAX_BYTES = 8 * 1024 * 1024;

/** Nombre de captures par position : au-delà, ce n'est plus une pièce jointe. */
export const MAX_PER_TRADE = 6;

/**
 * Signatures des formats acceptés. Reconnaître l'image à ses octets est ce qui
 * garantit que le serveur ne resservira jamais autre chose qu'une image.
 */
const SIGNATURES = [
  { type: 'image/png', ext: 'png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', ext: 'gif', test: (b) => b.length > 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a') },
  {
    type: 'image/webp',
    ext: 'webp',
    test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/** Type réel d'un contenu, ou null si ce n'est pas une image reconnue. */
export function detectType(buffer) {
  return SIGNATURES.find((s) => s.test(buffer)) ?? null;
}

/** Un identifiant d'image : 32 caractères hexadécimaux, rien d'autre. */
export const isImageId = (id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);

function invalid(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const fileFor = (id, ext) => path.join(DIR, `${id}.${ext}`);

/**
 * Enregistre une capture et retourne son descripteur.
 * @throws erreur 400 si le contenu n'est pas une image reconnue, 413 s'il est
 *   trop lourd.
 */
export async function saveImage(buffer) {
  if (!buffer?.length) throw invalid('Image vide.');
  if (buffer.length > MAX_BYTES) throw invalid('Image trop lourde (8 Mo maximum).', 413);

  const signature = detectType(buffer);
  if (!signature) throw invalid('Format non reconnu : PNG, JPEG, GIF ou WebP attendus.');

  await mkdir(DIR, { recursive: true });
  const id = randomUUID().replace(/-/g, '');
  await writeFile(fileFor(id, signature.ext), buffer);

  return { id, type: signature.type, bytes: buffer.length, addedAt: new Date().toISOString() };
}

/** Relit une capture. Retourne null si elle n'existe pas ou plus. */
export async function readImage(id) {
  if (!isImageId(id)) return null;

  for (const signature of SIGNATURES) {
    try {
      const buffer = await readFile(fileFor(id, signature.ext));
      // Le type est redéduit à la relecture : le nom de fichier ne fait pas foi.
      const real = detectType(buffer);
      if (real) return { buffer, type: real.type };
    } catch {
      // Format suivant.
    }
  }
  return null;
}

export async function deleteImages(ids = []) {
  await Promise.all(
    ids.filter(isImageId).flatMap((id) =>
      SIGNATURES.map((signature) => unlink(fileFor(id, signature.ext)).catch(() => {})),
    ),
  );
}

/** Vrai si la capture est bien sur le disque. */
export async function imageExists(id) {
  return (await readImage(id)) !== null;
}

/**
 * Supprime les captures qu'aucune position ne réclame.
 *
 * Une image envoyée puis abandonnée -- collée dans le formulaire, puis
 * « Annuler » -- resterait sinon indéfiniment. On laisse passer une journée :
 * une image envoyée il y a dix secondes appartient peut-être à un formulaire
 * encore ouvert.
 */
export async function pruneOrphans(referenced, olderThanMs = 86_400_000) {
  const keep = new Set(referenced);
  let removed = 0;

  try {
    const files = await readdir(DIR);
    const now = Date.now();

    for (const file of files) {
      const id = file.replace(/\.[a-z]+$/, '');
      if (!isImageId(id) || keep.has(id)) continue;

      const target = path.join(DIR, file);
      const info = await stat(target).catch(() => null);
      if (!info || now - info.mtimeMs < olderThanMs) continue;

      await unlink(target).catch(() => {});
      removed += 1;
    }
  } catch {
    // Pas de répertoire d'images : rien à purger.
  }

  return removed;
}

export const IMAGES_DIR = DIR;
