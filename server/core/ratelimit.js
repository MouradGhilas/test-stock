/**
 * Limitation de débit en mémoire, par clé (généralement « route:adresse IP »).
 *
 * L'enjeu n'est pas la sécurité -- l'outil tourne en local -- mais la
 * politesse envers les sources gratuites : une analyse sollicite une dizaine
 * d'API publiques, un tableau de bord une cotation par ligne ouverte.
 */

const buckets = new Map();

/**
 * Enregistre un appel et dit s'il dépasse le quota.
 * @returns {boolean} vrai si la requête doit être refusée.
 */
export function rateLimited(key, { windowMs = 60_000, max = 20 } = {}) {
  const now = Date.now();
  const window = buckets.get(key)?.filter((t) => now - t < windowMs) ?? [];
  window.push(now);
  buckets.set(key, window);

  // Purge opportuniste : sans elle, la table grossit indéfiniment.
  if (buckets.size > 1000) {
    for (const [other, times] of buckets) {
      if (!times.some((t) => now - t < windowMs)) buckets.delete(other);
    }
  }

  return window.length > max;
}

/** Remet les compteurs à zéro (tests). */
export function reset() {
  buckets.clear();
}
