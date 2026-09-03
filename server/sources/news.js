/**
 * Source : actualités du titre, via flux RSS publics.
 *
 * Aucun agregateur n'est fiable en continu -- Google News repond parfois un
 * flux quasi vide sans erreur HTTP. On interroge donc plusieurs fournisseurs
 * dans l'ordre et on retient le premier qui rapporte assez de titres, avec
 * fusion et dedoublonnage en dernier recours.
 *
 * Les titres sont renvoyés bruts à l'interface : l'utilisateur doit pouvoir
 * vérifier ce sur quoi le score de tonalité s'appuie.
 */

import { CONFIG } from '../config.js';
import { fetchText } from '../core/http.js';
import { decodeEntities, stripTags } from '../core/parse.js';

/** Nombre de titres en deca duquel on tente le fournisseur suivant. */
const ENOUGH = 6;

/**
 * Nasdaq renvoie des raisons sociales suffixees ("Apple Inc. Common Stock").
 * Ces suffixes polluent la recherche : on les retire pour ne garder que le nom.
 */
export function cleanCompanyName(name) {
  if (!name) return null;
  const cleaned = String(name)
    .replace(/\s*\([^)]*\)/g, '')
    .replace(
      /\s+(Class\s+[A-Z]\s+)?(Common Stock|Ordinary Shares?|Common Shares?|Depositary Shares?|American Depositary Shares?|Units?)\b.*$/i,
      '',
    )
    .replace(/[,\s]+$/, '')
    .trim();
  return cleaned || null;
}

const PROVIDERS = [
  {
    id: 'google',
    label: 'Google News',
    url: (ticker, name) =>
      `https://news.google.com/rss/search?q=${encodeURIComponent(name ? `"${name}" stock` : `${ticker} stock earnings`)}&hl=en-US&gl=US&ceid=US:en`,
  },
  {
    id: 'bing',
    label: 'Bing News',
    url: (ticker, name) =>
      `https://www.bing.com/news/search?q=${encodeURIComponent(`${ticker} ${name || ''} stock`.trim())}&format=RSS`,
  },
  {
    id: 'seekingalpha',
    label: 'Seeking Alpha',
    url: (ticker) => `https://seekingalpha.com/api/sa/combined/${encodeURIComponent(ticker)}.xml`,
  },
];

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? decodeEntities(match[1]) : null;
}

/** Parse un flux RSS générique en articles normalises. */
export function parseFeed(xml, providerLabel) {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

  return blocks
    .map((block) => {
      const rawTitle = tag(block, 'title') || '';
      const source = tag(block, 'source') || tag(block, 'sa:author_name') || providerLabel;

      // Google suffixe le titre par " - Source" : on l'enleve pour l'analyse.
      const title = source && rawTitle.endsWith(` - ${source}`)
        ? rawTitle.slice(0, -(source.length + 3))
        : rawTitle;

      const published = tag(block, 'pubDate');
      const date = published ? new Date(published) : null;

      return {
        title: stripTags(title),
        source,
        link: tag(block, 'link'),
        publishedAt: date && !Number.isNaN(date.getTime()) ? date : null,
      };
    })
    .filter((item) => item.title);
}

/** Deduplique sur le titre normalise, en gardant le plus recent. */
function dedupe(articles) {
  const seen = new Map();
  for (const article of articles) {
    const key = article.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    const previous = seen.get(key);
    if (!previous || (article.publishedAt?.getTime() || 0) > (previous.publishedAt?.getTime() || 0)) {
      seen.set(key, article);
    }
  }
  return [...seen.values()];
}

export async function fetchNews(ticker, tracker, companyName = null, limit = CONFIG.analysis.newsLimit) {
  const name = cleanCompanyName(companyName);
  const collected = [];

  for (const provider of PROVIDERS) {
    try {
      const xml = await fetchText(provider.url(ticker, name), {
        label: `${provider.label} · actualités ${ticker}`,
        ttl: CONFIG.cacheTtl.news,
        tracker,
        // Signal d'appoint : on ne lui accorde ni réessai ni temps d'attente
        // long, le fournisseur suivant prend le relais.
        timeoutMs: 6000,
        retries: 0,
        // Fournisseurs interchangeables : une panne écarté tout le domaine.
        circuit: 'host',
      });
      const articles = parseFeed(xml, provider.label);
      collected.push(...articles);

      // Un flux correctement rempli suffit : inutile de solliciter les autres.
      if (articles.length >= ENOUGH) break;
    } catch {
      // L'échec est déjà tracé ; on passe au fournisseur suivant.
    }
  }

  if (!collected.length) return [];

  return dedupe(collected)
    .sort((a, b) => (b.publishedAt?.getTime() || 0) - (a.publishedAt?.getTime() || 0))
    .slice(0, limit);
}
