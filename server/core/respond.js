/**
 * Petites fonctions partagées par les routes : réponse JSON et lecture du
 * corps de requête.
 */

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Corps JSON borné en taille : au-delà, on coupe plutôt que d'accumuler. */
export const MAX_BODY_BYTES = 64 * 1024;

export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('Corps de requête trop volumineux.');
        error.status = 413;
        req.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const error = new Error('Corps JSON invalide : objet attendu.');
          error.status = 400;
          return reject(error);
        }
        resolve(parsed);
      } catch {
        const error = new Error('Corps JSON illisible.');
        error.status = 400;
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

/**
 * Garde-fou des requêtes modifiantes.
 *
 * L'outil tourne sans authentification sur une machine personnelle. Rien
 * n'empêcherait une page web ouverte dans le même navigateur d'envoyer un
 * formulaire vers `localhost:3000` et de solder des positions. Deux barrières
 * suffisent à l'écarter :
 *
 *   - exiger `application/json`, qu'un formulaire HTML ne peut pas produire
 *     sans passer par une requête préalable (CORS) que le serveur refuse ;
 *   - refuser une origine explicite qui ne serait pas la nôtre.
 */
export function rejectCrossSite(req) {
  // Un DELETE n'a pas de corps : lui réclamer un type de contenu n'aurait pas
  // de sens, et un formulaire HTML ne sait de toute façon pas l'émettre.
  const type = String(req.headers['content-type'] || '');
  if (req.method !== 'DELETE' && !type.startsWith('application/json')) {
    return { status: 415, error: 'Content-Type « application/json » attendu.' };
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        return { status: 403, error: 'Origine non autorisée.' };
      }
    } catch {
      return { status: 403, error: 'Origine non autorisée.' };
    }
  }

  return null;
}
