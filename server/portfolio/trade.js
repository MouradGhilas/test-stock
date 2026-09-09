/**
 * Le trade : forme canonique et validation.
 *
 * Un trade copié depuis X n'est pas une ligne de courtier, c'est une intention
 * notée à la volée. Le modèle reste donc tolérant -- pas d'objectif, pas de
 * quantité tant que la position est en veille -- mais il refuse ce qui rendrait
 * les calculs faux : une quantité négative, un stop du mauvais côté, un ticker
 * fantaisiste. Mieux vaut un refus explicite qu'un portefeuille dont les
 * chiffres ne veulent rien dire.
 *
 * Trois états :
 *   watch  -- signal noté, position pas encore prise
 *   open   -- position en cours
 *   closed -- position soldée, avec son prix de sortie
 */

import { randomUUID } from 'node:crypto';
import { normalizeTicker, toNumber } from '../core/parse.js';

export const SIDES = new Set(['long', 'short']);
export const STATUSES = new Set(['watch', 'open', 'closed']);

/** Erreur de saisie : remonte en 400, jamais en 500. */
function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function positiveNumber(value, label, { required = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw invalid(`${label} : valeur manquante.`);
    return null;
  }
  const number = toNumber(value);
  if (number === null || !Number.isFinite(number) || number <= 0) {
    throw invalid(`${label} : nombre strictement positif attendu.`);
  }
  return number;
}

function cleanText(value, max = 280) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim().slice(0, max);
  return text || null;
}

/** "@Trader", "trader", " @trader " -> "@trader". */
export function normalizeHandle(value) {
  const text = String(value ?? '').trim().replace(/^@+/, '');
  const match = text.match(/^[A-Za-z0-9_]{1,15}$/);
  return match ? `@${text}` : null;
}

function normalizeTargets(value, { entry, side }) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,;\s]+/);
  const targets = [];

  for (const item of list) {
    if (item === null || item === undefined || item === '') continue;
    const number = toNumber(item);
    if (number === null || number <= 0) throw invalid('Objectif : nombre strictement positif attendu.');
    if (!targets.includes(number)) targets.push(number);
  }

  if (entry !== null && side) {
    const direction = side === 'long' ? 1 : -1;
    const wrongSide = targets.filter((t) => (t - entry) * direction <= 0);
    if (wrongSide.length) {
      throw invalid(
        `Objectif du mauvais côté de l'entrée pour une position ${side === 'long' ? 'longue' : 'vendeuse'} : ${wrongSide.join(', ')}.`,
      );
    }
  }

  return targets.sort((a, b) => (side === 'short' ? b - a : a - b));
}

/**
 * À la création, le stop doit borner la perte : sous l'entrée à l'achat,
 * au-dessus à la vente. Un stop du mauvais côté à ce stade est un signal mal
 * lu, pas une intention.
 *
 * Cette règle ne vaut qu'à la création. Une fois la position en cours, un stop
 * remonté au-dessus de l'entrée est au contraire l'objectif : il ne borne plus
 * une perte, il sécurise un gain. Seul le prix de marché pourrait arbitrer un
 * stop déplacé, et le modèle ne le connaît pas -- `applyPatch` laisse donc
 * passer tout stop positif.
 */
function checkStop(stop, entry, side) {
  if (stop === null || entry === null) return stop;
  const direction = side === 'long' ? 1 : -1;
  if ((entry - stop) * direction < 0) {
    throw invalid(
      side === 'long'
        ? "Le stop doit être sous le prix d'entrée pour une position longue."
        : "Le stop doit être au-dessus du prix d'entrée pour une vente à découvert.",
    );
  }
  return stop;
}

function isoDate(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

/**
 * Construit un trade à partir d'une saisie d'interface.
 * @throws erreur `status: 400` si la saisie est inexploitable.
 */
export function normalizeNewTrade(input = {}, now = new Date()) {
  const ticker = normalizeTicker(input.ticker);
  if (!ticker) throw invalid('Ticker invalide.');

  const side = String(input.side || 'long').toLowerCase();
  if (!SIDES.has(side)) throw invalid('Sens invalide : « long » ou « short » attendu.');

  const status = String(input.status || 'open').toLowerCase();
  if (!STATUSES.has(status)) throw invalid('Statut invalide.');

  const entry = positiveNumber(input.entry, "Prix d'entrée");
  // Une position en veille n'engage encore aucun capital : la quantité peut
  // attendre le moment où l'on prend réellement le signal.
  const quantity = positiveNumber(input.quantity, 'Quantité', { required: status !== 'watch' }) ?? null;
  const stop = checkStop(positiveNumber(input.stop, 'Stop', { required: false }), entry, side);
  const targets = normalizeTargets(input.targets, { entry, side });

  const nowIso = now.toISOString();
  const trade = {
    id: `t_${randomUUID().slice(0, 8)}`,
    ticker,
    side,
    status,
    quantity,
    entry,
    stop,
    // Le stop d'origine ne bouge plus : c'est l'unité de risque qui rend les
    // trades comparables entre eux. Sans lui, remonter un stop suffirait à
    // gonfler tous les multiples de R du portefeuille.
    initialStop: stop,
    targets,
    exit: null,
    openedAt: status === 'watch' ? null : isoDate(input.openedAt, nowIso),
    closedAt: null,
    source: {
      handle: normalizeHandle(input.handle ?? input.source?.handle),
      url: cleanText(input.url ?? input.source?.url, 300),
      text: cleanText(input.signalText ?? input.source?.text, 600),
    },
    note: cleanText(input.note),
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (status === 'closed') {
    trade.exit = positiveNumber(input.exit, 'Prix de sortie');
    trade.closedAt = isoDate(input.closedAt, nowIso);
  }

  return trade;
}

/** Champs modifiables après coup. Le reste (id, dates de création) est figé. */
const PATCHABLE = new Set([
  'ticker', 'side', 'status', 'quantity', 'entry', 'stop', 'targets',
  'exit', 'note', 'handle', 'url', 'openedAt', 'closedAt',
]);

/**
 * Applique une modification partielle et revalide l'ensemble : un stop déplacé
 * doit rester cohérent avec l'entrée, une clôture doit porter un prix.
 */
export function applyPatch(trade, patch = {}, now = new Date()) {
  const unknown = Object.keys(patch).filter((key) => !PATCHABLE.has(key));
  if (unknown.length) throw invalid(`Champ non modifiable : ${unknown.join(', ')}.`);

  const next = { ...trade, source: { ...trade.source } };

  if ('ticker' in patch) {
    const ticker = normalizeTicker(patch.ticker);
    if (!ticker) throw invalid('Ticker invalide.');
    next.ticker = ticker;
  }

  if ('side' in patch) {
    const side = String(patch.side).toLowerCase();
    if (!SIDES.has(side)) throw invalid('Sens invalide.');
    next.side = side;
  }

  if ('entry' in patch) next.entry = positiveNumber(patch.entry, "Prix d'entrée");
  if ('quantity' in patch) next.quantity = positiveNumber(patch.quantity, 'Quantité', { required: false });

  if ('stop' in patch) {
    next.stop = positiveNumber(patch.stop, 'Stop', { required: false });
    // Premier stop posé après coup : il devient la référence de risque.
    if (next.initialStop === null || next.initialStop === undefined) next.initialStop = next.stop;
  }
  if ('note' in patch) next.note = cleanText(patch.note);
  if ('handle' in patch) next.source.handle = normalizeHandle(patch.handle);
  if ('url' in patch) next.source.url = cleanText(patch.url, 300);
  if ('openedAt' in patch) next.openedAt = isoDate(patch.openedAt, next.openedAt);

  // Les objectifs se revalident contre l'entrée courante, qui a pu changer
  // dans la même modification. Le stop, lui, est libre : voir `checkStop`.
  next.targets = normalizeTargets('targets' in patch ? patch.targets : next.targets, {
    entry: next.entry,
    side: next.side,
  });

  if ('status' in patch) {
    const status = String(patch.status).toLowerCase();
    if (!STATUSES.has(status)) throw invalid('Statut invalide.');
    next.status = status;
  }

  if ('exit' in patch && patch.exit !== null) next.exit = positiveNumber(patch.exit, 'Prix de sortie');

  if (next.status === 'closed') {
    if (next.exit === null) throw invalid('Une clôture demande un prix de sortie.');
    if (next.quantity === null) throw invalid('Une clôture demande une quantité.');
    next.closedAt = isoDate('closedAt' in patch ? patch.closedAt : next.closedAt, now.toISOString());
  } else {
    next.exit = 'exit' in patch ? next.exit : trade.exit;
    next.closedAt = null;
    if (next.status === 'open' && !next.openedAt) next.openedAt = now.toISOString();
    if (next.status === 'open' && next.quantity === null) throw invalid('Une position ouverte demande une quantité.');
  }

  next.updatedAt = now.toISOString();
  return next;
}
