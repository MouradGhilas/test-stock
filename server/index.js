/**
 * Serveur HTTP : sert l'interface et expose l'API d'analyse.
 * Sans dependance externe -- `node:http` suffit pour ce perimêtre.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { analyzeTicker } from './analyze.js';
import { fetchEarningsCalendar } from './sources/nasdaq.js';
import { createTracker } from './core/http.js';
import { stats as cacheStats } from './core/cache.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* --- Limitation de debit : l'analyse sollicite une dizaine de sources --- */
const RATE_LIMIT = { windowMs: 60_000, max: 20 };
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const window = hits.get(ip)?.filter((t) => now - t < RATE_LIMIT.windowMs) ?? [];
  window.push(now);
  hits.set(ip, window);

  // Purge opportuniste pour éviter que la table ne grossisse indéfiniment.
  if (hits.size > 1000) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < RATE_LIMIT.windowMs)) hits.delete(key);
    }
  }
  return window.length > RATE_LIMIT.max;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, relative);

  // Barrière anti-traversée : le chemin résolu doit rester sous public/.
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: 'Accès refusé.' });
  }

  try {
    const content = await fs.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Content-Length': content.length,
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Page introuvable');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Méthode non autorisée.' });
  }

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { status: 'ok', uptime: process.uptime(), cache: cacheStats() });
  }

  // Calendrier des publications à venir : l'entrée naturelle dans l'outil,
  // avant même de savoir quel ticker on veut regarder.
  if (url.pathname === '/api/calendar') {
    const ip = req.socket.remoteAddress || 'inconnu';
    if (rateLimited(ip)) {
      return sendJson(res, 429, { error: 'Trop de requêtes. Patientez une minute.' });
    }

    const days = Math.min(10, Math.max(1, Number(url.searchParams.get('days')) || 5));
    const minCap = Math.max(0, Number(url.searchParams.get('minCap')) || CONFIG.analysis.calendarMinMarketCap);

    try {
      const tracker = createTracker();
      const calendar = await fetchEarningsCalendar(tracker, { days, minCap });
      return sendJson(res, 200, { ...calendar, minCap, sources: tracker.entries });
    } catch (error) {
      console.error('[calendrier]', error);
      return sendJson(res, 502, { error: 'Calendrier des résultats indisponible pour le moment.' });
    }
  }

  if (url.pathname === '/api/analyze') {
    const ip = req.socket.remoteAddress || 'inconnu';
    if (rateLimited(ip)) {
      return sendJson(res, 429, {
        error: "Trop de requêtes. Chaque analyse interroge une dizaine de sources : patientez une minute.",
      });
    }

    const ticker = url.searchParams.get('ticker');
    if (!ticker) return sendJson(res, 400, { error: 'Paramètre « ticker » manquant.' });

    try {
      const report = await analyzeTicker(ticker);
      return sendJson(res, 200, report);
    } catch (error) {
      const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
      if (status >= 500) console.error(`[analyse ${ticker}]`, error);
      return sendJson(res, status, { error: error.message });
    }
  }

  return serveStatic(res, url.pathname);
});

server.listen(CONFIG.server.port, CONFIG.server.host, () => {
  console.log(`Analyse pre-résultats : http://localhost:${CONFIG.server.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
