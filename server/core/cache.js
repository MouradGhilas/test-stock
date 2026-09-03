/**
 * Cache memoire a TTL, avec deduplication des requêtes en vol.
 *
 * Deux appels simultanes sur la même cle ne declenchent qu'un seul fetch :
 * c'est ce qui evite de marteler les sources quand plusieurs onglets
 * analysent le même ticker.
 */

const store = new Map();
const inflight = new Map();

export function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

export function set(key, value, ttlSeconds) {
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  return value;
}

/**
 * Retourne la valeur en cache, sinon exécute `producer` (une seule fois
 * même en cas d'appels concurrents) et mémorise le résultat.
 */
export async function remember(key, ttlSeconds, producer) {
  const cached = get(key);
  if (cached !== undefined) return { value: cached, cached: true };

  if (inflight.has(key)) {
    return { value: await inflight.get(key), cached: true };
  }

  const promise = (async () => producer())();
  inflight.set(key, promise);
  try {
    const value = await promise;
    set(key, value, ttlSeconds);
    return { value, cached: false };
  } finally {
    inflight.delete(key);
  }
}

export function clear() {
  store.clear();
  inflight.clear();
}

export function stats() {
  let live = 0;
  const now = Date.now();
  for (const entry of store.values()) if (entry.expiresAt > now) live += 1;
  return { entries: store.size, live, inflight: inflight.size };
}
