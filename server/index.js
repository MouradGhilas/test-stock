/**
 * Serveur HTTP : sert l'interface et expose l'API du suivi de positions.
 * Sans dependance externe -- `node:http` suffit pour ce perimêtre.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { stats as cacheStats } from './core/cache.js';
import { sendJson } from './core/respond.js';
import { handlePortfolioRoute } from './portfolio/routes.js';

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

  // Le suivi de positions porte toute l'API, et il est le seul à écrire :
  // ses routes vivent dans leur module, avec leurs propres garde-fous.
  if (await handlePortfolioRoute(req, res, url)) return undefined;

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Méthode non autorisée.' });
  }

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { status: 'ok', uptime: process.uptime(), cache: cacheStats() });
  }

  return serveStatic(res, url.pathname);
});

server.listen(CONFIG.server.port, CONFIG.server.host, () => {
  console.log(`Suivi des positions : http://localhost:${CONFIG.server.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
