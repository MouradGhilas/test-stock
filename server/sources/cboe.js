/**
 * Source : chaîne d'options differee du CBOE.
 *
 * C'est la pièce maîtresse d'une analyse pre-résultats : le marché options
 * price déjà un mouvement pour le jour de la publication. Le comparer aux
 * réactions historiques dit si le pari est cher ou non.
 *
 * Méthode. Le straddle "à la monnaie" d'une échéance donnée mesure le
 * mouvement attendu jusqu'a cette échéance -- événement *et* volatilité
 * ordinaire mélangés. Si la première échéance après les résultats tombe
 * trois semaines plus tard, on surestime largement l'impact du résultat.
 * On isolé donc l'événement par difference de variance entre une échéance
 * qui précède la publication (volatilité ordinaire seule) et une échéance
 * qui la suit :
 *
 *     V_event = T_post * (sigma_post^2 - sigma_pre^2)
 *     mouvement_evenement = sqrt(V_event)
 *
 * sigma_pre sert d'estimation de la volatilité ordinaire sur toute la
 * période ; ce qui dépasse est attribué au résultat. A défaut de deux
 * échéances exploitables, on retombe sur le straddle brut, signale comme tel.
 */

import { CONFIG } from '../config.js';
import { fetchJson } from '../core/http.js';
import { mean } from '../core/stats.js';

const BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';
const DAY_MS = 86_400_000;
const YEAR_DAYS = 365;

/** "AAPL260902C00205000" -> { expiry, type, strike }. Le suffixe fait 15 caracteres. */
export function parseOptionSymbol(symbol) {
  const text = String(symbol || '');
  if (text.length < 16) return null;

  const match = text.slice(-15).match(/^(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) return null;

  const [, yy, mm, dd, type, strikeRaw] = match;
  const expiry = new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd)));
  if (Number.isNaN(expiry.getTime())) return null;

  return { expiry, type, strike: Number(strikeRaw) / 1000 };
}

/** Prix retenu : milieu de fourchette, sinon théorique, sinon dernier échange. */
function optionPrice(option) {
  const bid = Number(option?.bid) || 0;
  const ask = Number(option?.ask) || 0;
  if (bid > 0 && ask > 0 && ask >= bid) return (bid + ask) / 2;
  if (Number(option?.theo) > 0) return Number(option.theo);
  if (Number(option?.last_trade_price) > 0) return Number(option.last_trade_price);
  return null;
}

/** Regroupe la chaîne brute par échéance. */
export function groupByExpiry(options) {
  const chains = new Map();
  for (const option of options || []) {
    const parsed = parseOptionSymbol(option.option);
    if (!parsed) continue;
    const key = parsed.expiry.getTime();
    if (!chains.has(key)) {
      chains.set(key, { expiry: parsed.expiry, calls: new Map(), puts: new Map() });
    }
    const bucket = chains.get(key);
    (parsed.type === 'C' ? bucket.calls : bucket.puts).set(parsed.strike, option);
  }
  return [...chains.values()].sort((a, b) => a.expiry - b.expiry);
}

/** Caracteristiques à la monnaie d'une échéance : straddle et volatilité implicite. */
export function atmProfile(chain, spot) {
  const strikes = [...chain.calls.keys()].filter((k) => chain.puts.has(k));
  if (!strikes.length) return null;

  const strike = strikes.reduce((best, k) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best));
  const call = chain.calls.get(strike);
  const put = chain.puts.get(strike);

  const callPrice = optionPrice(call);
  const putPrice = optionPrice(put);
  const ivs = [Number(call?.iv), Number(put?.iv)].filter((iv) => Number.isFinite(iv) && iv > 0);

  return {
    expiry: chain.expiry,
    strike,
    straddle: callPrice !== null && putPrice !== null ? callPrice + putPrice : null,
    iv: ivs.length ? mean(ivs) : null,
    strikesAvailable: strikes.length,
  };
}

/**
 * Déduit la fenetre de publication a partir de la structure par terme.
 *
 * La volatilité implicite d'une échéance qui englobe des résultats est
 * mécaniquement plus élevée que celle de l'échéance précédente. Le plus gros
 * saut de volatilité encadre donc la date de publication. C'est un controle
 * indépendant, très utile quand la date vient d'une extrapolation : si la
 * date estimée tombe hors de cette fenetre, c'est que l'estimation est fausse.
 *
 * @returns {{after: Date, before: Date, ivJumpPoints: number}|null}
 */
export function inferEarningsWindow(chains, spot, now = Date.now()) {
  const points = chains
    .map((chain) => ({ chain, days: (chain.expiry.getTime() - now) / DAY_MS, atm: atmProfile(chain, spot) }))
    // Les échéances très courtes ont une volatilité implicite erratique, les
    // très longues noient l'événement dans le bruit.
    .filter((p) => p.days >= 5 && p.days <= 150 && p.atm?.iv)
    .sort((a, b) => a.days - b.days);

  if (points.length < 2) return null;

  let best = null;
  for (let i = 1; i < points.length; i += 1) {
    const jump = points[i].atm.iv - points[i - 1].atm.iv;
    if (!best || jump > best.jump) best = { jump, index: i };
  }

  // Sous un point de volatilité, le saut n'est pas significatif.
  if (!best || best.jump < 0.01) return null;

  return {
    after: points[best.index - 1].chain.expiry,
    before: points[best.index].chain.expiry,
    ivJumpPoints: best.jump * 100,
  };
}

async function loadChain(ticker, tracker) {
  const attempts = [ticker.toUpperCase(), `_${ticker.toUpperCase()}`];
  let lastError;
  for (const symbol of attempts) {
    try {
      return await fetchJson(`${BASE}/${symbol}.json`, {
        label: `CBOE · chaîne d'options ${ticker}`,
        ttl: CONFIG.cacheTtl.options,
        tracker,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * @param {Date|null} earningsDate Publication visee : l'échéance retenue doit
 *   la couvrir, et l'échéance de référence doit la preceder.
 */
export async function fetchImpliedMove(ticker, tracker, earningsDate = null) {
  const payload = await loadChain(ticker, tracker);
  const data = payload?.data;
  const spot = Number(data?.current_price);
  if (!data || !Number.isFinite(spot) || spot <= 0) return null;

  const chains = groupByExpiry(data.options);
  if (!chains.length) return null;

  const impliedWindow = inferEarningsWindow(chains, spot);

  const now = Date.now();
  // La réaction au résultat a lieu au plus tard le lendemain de la publication.
  const floor = earningsDate ? new Date(earningsDate.getTime() + DAY_MS) : new Date(now + 5 * DAY_MS);

  const post = chains.find((c) => c.expiry >= floor) || chains[chains.length - 1];
  const postAtm = atmProfile(post, spot);
  if (!postAtm || postAtm.straddle === null) return null;

  const tPost = Math.max(1, (post.expiry.getTime() - now) / DAY_MS) / YEAR_DAYS;
  const straddleMovePercent = (postAtm.straddle / spot) * 100;

  // Échéance de référence : la dernière qui précède la publication, avec au
  // moins trois jours de vie résiduelle (en deca, la volatilité implicite
  // devient trop bruitee pour servir de référence).
  const reference = earningsDate
    ? [...chains]
        .reverse()
        .find((c) => c.expiry < earningsDate && c.expiry.getTime() - now > 3 * DAY_MS)
    : null;
  const referenceAtm = reference ? atmProfile(reference, spot) : null;

  let impliedMovePercent = straddleMovePercent;
  let method = 'straddle';
  let baselineVol = null;

  if (referenceAtm?.iv && postAtm.iv && postAtm.iv > referenceAtm.iv) {
    const eventVariance = tPost * (postAtm.iv ** 2 - referenceAtm.iv ** 2);
    if (eventVariance > 0) {
      impliedMovePercent = Math.sqrt(eventVariance) * 100;
      method = 'decomposition';
      baselineVol = referenceAtm.iv;
    }
  }

  const daysAfterEarnings = earningsDate
    ? Math.round((post.expiry.getTime() - earningsDate.getTime()) / DAY_MS)
    : null;

  return {
    spot,
    method,
    impliedMovePercent,
    straddleMovePercent,
    expiry: post.expiry,
    daysAfterEarnings,
    coversEarnings: Boolean(earningsDate) && post.expiry >= floor,
    atmStrike: postAtm.strike,
    straddlePrice: postAtm.straddle,
    atmImpliedVol: postAtm.iv,
    baselineVol,
    referenceExpiry: method === 'decomposition' ? reference.expiry : null,
    iv30: Number(data.iv30) || null,
    putCallOpenInterest: ratio(post, 'open_interest'),
    putCallVolume: ratio(post, 'volume'),
    skew: computeSkew(post),
    strikesAvailable: postAtm.strikesAvailable,
    impliedWindow,
  };
}

function ratio(chain, field) {
  const sum = (map) => [...map.values()].reduce((acc, o) => acc + (Number(o[field]) || 0), 0);
  const calls = sum(chain.calls);
  return calls > 0 ? sum(chain.puts) / calls : null;
}

/**
 * Skew : volatilité moyenne des puts hors de la monnaie moins celle des calls
 * equivalents. Positif = la protection à la baisse coute cher.
 */
function computeSkew(chain) {
  const pick = (map) =>
    [...map.values()]
      .filter((o) => {
        const delta = Math.abs(Number(o.delta));
        const iv = Number(o.iv);
        return delta >= 0.15 && delta <= 0.35 && Number.isFinite(iv) && iv > 0;
      })
      .map((o) => Number(o.iv));

  const putIv = mean(pick(chain.puts));
  const callIv = mean(pick(chain.calls));
  if (putIv === null || callIv === null) return null;
  return (putIv - callIv) * 100;
}
