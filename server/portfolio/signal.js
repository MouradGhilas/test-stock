/**
 * Lecture d'un signal de copy trading collé depuis X.
 *
 * Les signaux publiés sur X n'ont aucun format normalisé. On y trouve, dans un
 * ordre quelconque et en deux langues :
 *
 *   $NVDA long entry 178.50 SL 172 TP1 185 TP2 192
 *   BUY $AAPL @ 232,10 — stop 227, objectif 245
 *   Short TSLA below 400 | sl -3% | tp +6%
 *
 * Ce module ne fait qu'une chose : transformer ce texte en champs exploitables,
 * en disant explicitement ce qu'il a trouvé et ce qu'il a deviné. Il ne devine
 * jamais en silence -- chaque champ porte son origine (`found` / `guessed`) et
 * les incohérences remontent en avertissements. La saisie reste corrigeable à
 * la main : l'extraction est une aide, pas une autorité.
 *
 * Fonction pure, sans réseau ni état : tout est testable ligne à ligne.
 */

/* ------------------------------------------------------------------ */
/* Briques de reconnaissance                                           */
/* ------------------------------------------------------------------ */

/**
 * Un nombre tel qu'on l'écrit dans un tweet : "178.50", "178,50", "1,250.75",
 * "$232", "232$". Le groupe 1 capture le nombre, le groupe 2 l'unité
 * éventuelle (% ou $).
 */
const VALUE = String.raw`(?:\$\s*)?(\d{1,3}(?:[   ,]\d{3})+(?:[.,]\d{1,4})?|\d+(?:[.,]\d{1,4})?)\s*(%|\$)?`;

/**
 * Ce qui peut séparer une étiquette de sa valeur. Volontairement court : au
 * delà de quelques caractères, le nombre trouvé n'appartient plus à
 * l'étiquette. « stop is not set, buy 178 » ne doit pas donner un stop à 178.
 */
const SEP = String.raw`(?:\s*(?:at|à|a|vers|below|above|sous|sur|near|autour\s+de)\b)?[\s:=@>|~,+\-–—]{0,4}`;

// Pas de `\b` final : « TP1 » et « SL172 » doivent rester reconnaissables.
// Le nombre devant suivre à quatre caractères près, un mot qui commence par
// l'étiquette ("slow", "buyers") ne peut pas produire de faux positif.
const ENTRY_LABEL = String.raw`\b(?:entr(?:y|ée|ee)(?:\s*(?:price|zone|point|area))?|buy\s*(?:zone|area)?|bought|achat|acheter|prise\s+de\s+position|fill(?:ed)?|in\s+at)`;
const STOP_LABEL = String.raw`\b(?:s\s*[\/.]\s*l|sl|stop(?:\s*[-–]?\s*loss)?|stoploss|invalidation|inval)`;
const TARGET_LABEL = String.raw`\b(?:tps?|take\s*profits?|targets?|objectifs?|obj|cibles?|pt)`;
const SIZE_LABEL = String.raw`\b(?:size|taille|quantit[ée]|qty|position)\b`;

const LONG_WORDS = /\b(?:long|longs|buy|buying|bought|call|calls|achat|acheter|achète|achete|haussier|bullish)\b/i;
const SHORT_WORDS = /\b(?:short|shorting|shorted|sell|selling|sold|put|puts|vente|vendre|vends|baissier|bearish)\b/i;

/**
 * Mots de 1 à 5 lettres qui ressemblent à un ticker sans en être un. La liste
 * n'a pas besoin d'être exhaustive : elle sert au seul cas de repli, quand le
 * signal ne contient pas de cashtag ($NVDA), et le champ est alors marqué
 * « deviné ».
 */
const NOT_A_TICKER = new Set(
  (
    'SL TP TP1 TP2 TP3 TP4 PT BE ATH ATL HOD LOD IV ER EPS CEO CFO IPO ETF NFA DYOR IMO RT ' +
    'USD EUR USA FED CPI PMI PIB GDP AM PM ET EOD EOW YTD DCA ROI RR OK NEW BUY SELL LONG ' +
    'SHORT CALL PUT CALLS PUTS ADD STOP LOSS ENTRY EXIT TARGET RISK SIZE OPEN CLOSE HOLD ' +
    'WATCH ALERT IDEA SETUP SWING DAY TRADE MOVE GAP VWAP MA EMA SMA RSI MACD ATR OTM ITM ' +
    'DD PR FDA SEC AI IA LOL WTF YOLO GG TA FA HTF LTF TF ACHAT VENTE OBJ CIBLE PRIX GAIN ' +
    'PERTE ZONE PLAN THE AND FOR YES NO ON OFF UP DOWN LOW HIGH BIG ALL OUT IN IF ITS ITM ' +
    'HERE NOW SOON JUST VERY LOT NICE HUGE ' +
    // Mots-outils : ils suivent volontiers un « buy » ou un « achat », et
    // seraient sinon pris pour le ticker (« BUY at 50 »).
    'AT TO BY OF IS IT AS SO MY WE DO GO OR AN DE DU LA LE LES UN UNE SUR PAR POUR AVEC ' +
    'PAS PLUS MAIS VERS SOUS AUTOUR ENTRE'
  ).split(/\s+/),
);

/* ------------------------------------------------------------------ */
/* Conversion des nombres                                              */
/* ------------------------------------------------------------------ */

/**
 * "1,250.75" -> 1250.75 ; "178,50" -> 178.5 ; "1 250" -> 1250.
 *
 * Règle de départage quand il n'y a qu'une virgule : suivie d'exactement trois
 * chiffres et précédée d'au plus trois, c'est un séparateur de milliers
 * ("1,250") ; sinon c'est la virgule décimale française ("178,50"). Reste un
 * cas indécidable, "1,500" écrit à la française pour 1,5 -- assez improbable
 * sur un prix d'action pour qu'on préfère 1500.
 */
export function toPrice(raw) {
  let text = String(raw ?? '').replace(/[$\s  ]/g, '');
  if (!text) return null;

  const hasComma = text.includes(',');
  const hasDot = text.includes('.');

  if (hasComma && hasDot) {
    const decimal = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
    const thousand = decimal === ',' ? '.' : ',';
    text = text.split(thousand).join('').replace(decimal, '.');
  } else if (hasComma) {
    text = /^\d{1,3}(,\d{3})+$/.test(text) ? text.split(',').join('') : text.replace(',', '.');
  }

  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ */
/* Extraction champ par champ                                          */
/* ------------------------------------------------------------------ */

/**
 * Toutes les valeurs introduites par une étiquette.
 *
 * @param {string} text     Le signal.
 * @param {string} label    Fragment d'expression régulière de l'étiquette.
 * @param {object} options
 * @param {boolean} options.index  Accepte un numéro d'ordre collé à l'étiquette
 *   ("TP1 185"). Le chiffre n'est pris pour un indice que s'il est suivi d'un
 *   séparateur : dans "TP 185", le 1 appartient au prix.
 * @param {boolean} options.list   Poursuit la lecture après la première valeur
 *   ("objectifs : 185, 192, 200").
 * @returns {Array<{ value: number, unit: string|null, at: number }>}
 */
function readLabeled(text, label, { index = false, list = false } = {}) {
  const idx = index ? String.raw`(?:(\d)[\s:.)\-]+)?` : '';
  const regex = new RegExp(`${label}${idx}${SEP}${VALUE}`, 'gi');
  const found = [];

  for (const match of text.matchAll(regex)) {
    const groups = match.slice(index ? 2 : 1);
    const value = toPrice(groups[0]);
    if (value === null) continue;
    found.push({ value, unit: groups[1] || null, at: match.index });

    if (!list) continue;

    // Suite de la même énumération : « 185, 192 / 200 ».
    const tail = text.slice(match.index + match[0].length);
    const more = new RegExp(`^(?:[\\s,;/|]|et\\b|and\\b)+${VALUE}`, 'i');
    let rest = tail;
    let consumed = match.index + match[0].length;
    let next = rest.match(more);
    while (next) {
      const nextValue = toPrice(next[1]);
      if (nextValue === null) break;
      found.push({ value: nextValue, unit: next[2] || null, at: consumed });
      consumed += next[0].length;
      rest = rest.slice(next[0].length);
      next = rest.match(more);
    }
  }

  return found;
}

/** Position de la première étiquette de stop ou d'objectif, ou +∞. */
function firstRiskLabelAt(text) {
  const stop = text.search(new RegExp(STOP_LABEL, 'i'));
  const target = text.search(new RegExp(TARGET_LABEL, 'i'));
  const positions = [stop, target].filter((p) => p >= 0);
  return positions.length ? Math.min(...positions) : Number.POSITIVE_INFINITY;
}

/** Ticker : cashtag d'abord, sinon un mot en capitales qui n'est pas du jargon. */
function extractTicker(text) {
  const cashtag = text.match(/\$([A-Za-z]{1,5}(?:\.[A-Za-z])?)\b/);
  if (cashtag) return { ticker: cashtag[1].toUpperCase(), origin: 'found' };

  // Repli 1 : un mot en capitales, hors jargon de trading.
  for (const match of text.matchAll(/\b([A-Z]{1,5}(?:\.[A-Z])?)\b/g)) {
    if (!NOT_A_TICKER.has(match[1])) return { ticker: match[1], origin: 'guessed' };
  }

  // Repli 2 : le mot qui suit le sens ("long nvda 178").
  const after = text.match(
    /\b(?:long|short|buy|sell|bought|sold|achat|acheter|vente|vendre)\s+([A-Za-z]{1,5}(?:\.[A-Za-z])?)\b/i,
  );
  if (after && !NOT_A_TICKER.has(after[1].toUpperCase())) {
    return { ticker: after[1].toUpperCase(), origin: 'guessed' };
  }

  return { ticker: null, origin: null };
}

/** Sens de la position, d'après le premier mot-clé rencontré. */
function extractSide(text) {
  const long = text.match(LONG_WORDS);
  const short = text.match(SHORT_WORDS);
  if (long && short) {
    return { side: long.index <= short.index ? 'long' : 'short', origin: 'found' };
  }
  if (long) return { side: 'long', origin: 'found' };
  if (short) return { side: 'short', origin: 'found' };
  return { side: null, origin: null };
}

/** Prix d'entrée, éventuellement donné en fourchette ("178,5 - 180"). */
function extractEntry(text) {
  const labelled = readLabeled(text, ENTRY_LABEL).filter((v) => v.unit !== '%');
  const arobase = text.match(new RegExp(`@\\s*${VALUE}`));

  let hit = labelled[0] || null;
  if (!hit && arobase) {
    const value = toPrice(arobase[1]);
    if (value !== null && arobase[2] !== '%') hit = { value, unit: arobase[2] || null, at: arobase.index };
  }

  // Une étiquette de stop ou d'objectif glissée entre le mot-clé et le nombre
  // change tout : dans « long NVDA sl 172 », 172 est un stop, pas une entrée.
  const carriesRiskLabel = (fragment) =>
    new RegExp(`${STOP_LABEL}|${TARGET_LABEL}`, 'i').test(fragment);

  // Repli : un prix collé au sens, « buy $AAPL 232.10 ».
  if (!hit) {
    const loose = text.match(
      new RegExp(`\\b(?:long|short|buy|sell|bought|sold|achat|acheter|vente|vendre|add)\\b[^\\d\\n]{0,20}${VALUE}`, 'i'),
    );
    if (loose && loose[2] !== '%' && !carriesRiskLabel(loose[0])) {
      const value = toPrice(loose[1]);
      if (value !== null) hit = { value, unit: null, at: loose.index };
    }
  }

  // Dernier repli : le prix collé au cashtag, « $SOFI 12.5 sl 11.8 ». On ne
  // s'y risque que si le texte porte par ailleurs un stop ou un objectif,
  // faute de quoi n'importe quel nombre voisin d'un cashtag ("$NVDA 2026")
  // passerait pour une entrée.
  if (!hit && Number.isFinite(firstRiskLabelAt(text))) {
    const glued = text.match(new RegExp(`\\$[A-Za-z]{1,5}(?:\\.[A-Za-z])?\\s*[@:]?\\s*${VALUE}`));
    if (glued && glued[2] !== '%' && !carriesRiskLabel(glued[0])) {
      const value = toPrice(glued[1]);
      if (value !== null) hit = { value, unit: null, at: glued.index };
    }
  }

  if (!hit || hit.value <= 0) return { entry: null, range: null, origin: null };

  // Fourchette d'entrée : on retient le milieu, en gardant les bornes pour
  // l'affichage. Un signal qui dit « 178-180 » ne prétend pas au centime près.
  // La fourchette doit partir du prix d'entrée déjà trouvé, sinon on lirait
  // « TP 185-190 » comme une fourchette d'entrée.
  const tail = text.slice(hit.at);
  const range = tail.match(new RegExp(`${VALUE}\\s*(?:[-–—/]|à|to)\\s*${VALUE}`, 'i'));
  if (range && toPrice(range[1]) === hit.value) {
    const low = toPrice(range[1]);
    const high = toPrice(range[3]);
    if (low !== null && high !== null && low > 0 && high > 0 && Math.abs(high - low) / low < 0.35) {
      return {
        entry: Math.round(((low + high) / 2) * 10000) / 10000,
        range: [Math.min(low, high), Math.max(low, high)],
        origin: 'found',
      };
    }
  }

  return { entry: hit.value, range: null, origin: 'found' };
}

/**
 * Convertit une valeur en pourcentage en prix.
 * Un stop à « -3 % » est 3 % sous l'entrée pour un achat, au-dessus pour une
 * vente à découvert ; un objectif fait l'inverse. Le signe écrit dans le tweet
 * n'est pas fiable, la géométrie de la position, si.
 */
function fromPercent(percent, entry, side, kind) {
  if (entry === null || !side) return null;
  const distance = Math.abs(percent) / 100;
  const direction = side === 'long' ? 1 : -1;
  const sign = kind === 'stop' ? -1 : 1;
  return Math.round(entry * (1 + sign * direction * distance) * 10000) / 10000;
}

function extractStop(text, entry, side) {
  const hits = readLabeled(text, STOP_LABEL);
  for (const hit of hits) {
    const value = hit.unit === '%' ? fromPercent(hit.value, entry, side, 'stop') : hit.value;
    if (value !== null && value > 0) return value;
  }
  return null;
}

function extractTargets(text, entry, side) {
  const hits = readLabeled(text, TARGET_LABEL, { index: true, list: true });
  const targets = [];

  for (const hit of hits) {
    const value = hit.unit === '%' ? fromPercent(hit.value, entry, side, 'target') : hit.value;
    if (value !== null && value > 0 && !targets.includes(value)) targets.push(value);
  }

  // Du plus proche au plus lointain, dans le sens de la position.
  return targets.sort((a, b) => (side === 'short' ? b - a : a - b));
}

function extractSize(text) {
  const shares = text.match(new RegExp(`${VALUE}\\s*(?:shares?|actions?|titres?|parts?)\\b`, 'i'));
  if (shares && shares[2] !== '%') {
    const quantity = toPrice(shares[1]);
    if (quantity !== null && quantity > 0) return { quantity, riskPercent: null };
  }

  const labelled = readLabeled(text, SIZE_LABEL).find((v) => v.unit !== '%');
  if (labelled && labelled.value > 0) return { quantity: labelled.value, riskPercent: null };

  const risk = text.match(new RegExp(`\\b(?:risk|risque)\\w*${SEP}${VALUE}`, 'i'));
  if (risk && risk[2] === '%') {
    const percent = toPrice(risk[1]);
    if (percent !== null && percent > 0) return { quantity: null, riskPercent: percent };
  }

  return { quantity: null, riskPercent: null };
}

/** Compte X de l'auteur : l'URL du post d'abord, sinon la première mention. */
function extractSource(text) {
  const url = text.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
  if (url) return { handle: `@${url[1]}`, url: url[0] };

  const mention = text.match(/(^|[\s(])@([A-Za-z][A-Za-z0-9_]{1,14})\b/);
  return { handle: mention ? `@${mention[2]}` : null, url: null };
}

/* ------------------------------------------------------------------ */
/* Lecture complète                                                    */
/* ------------------------------------------------------------------ */

/**
 * Lit un signal collé et retourne des champs prêts à corriger puis valider.
 *
 * @param {string} raw Texte brut du post.
 * @returns {{
 *   ticker: string|null, side: string|null, entry: number|null,
 *   entryRange: number[]|null, stop: number|null, targets: number[],
 *   quantity: number|null, riskPercent: number|null,
 *   source: { handle: string|null, url: string|null, text: string },
 *   origins: object, warnings: string[], coverage: number
 * }}
 */
export function parseSignal(raw) {
  const text = String(raw ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\r\t]+/g, ' ')
    .replace(/[  ]{2,}/g, ' ')
    .trim();

  const warnings = [];
  const origins = {};

  const { ticker, origin: tickerOrigin } = extractTicker(text);
  origins.ticker = tickerOrigin;

  const detectedSide = extractSide(text);
  const { entry, range, origin: entryOrigin } = extractEntry(text);
  origins.entry = entryOrigin;

  let side = detectedSide.side;
  origins.side = detectedSide.origin;

  // Sens absent : la géométrie du signal le trahit. Un stop sous l'entrée et
  // un objectif au-dessus, c'est un achat, quel que soit le vocabulaire. Seuls
  // les niveaux absolus servent ici : un stop exprimé en pourcentage se
  // calcule à partir du sens, il ne peut pas servir à le déduire.
  if (!side) {
    const stopGuess = readLabeled(text, STOP_LABEL).find((h) => h.unit !== '%')?.value ?? null;
    const targetGuess =
      readLabeled(text, TARGET_LABEL, { index: true, list: true }).find((h) => h.unit !== '%')?.value ?? null;
    if (entry !== null && stopGuess !== null) {
      side = stopGuess < entry ? 'long' : 'short';
      origins.side = 'guessed';
    } else if (entry !== null && targetGuess !== null) {
      side = targetGuess > entry ? 'long' : 'short';
      origins.side = 'guessed';
    } else {
      side = 'long';
      origins.side = 'default';
      warnings.push("Aucun sens détecté dans le signal : position longue supposée. À vérifier.");
    }
  }

  const stop = extractStop(text, entry, side);
  origins.stop = stop === null ? null : 'found';

  const targets = extractTargets(text, entry, side);
  origins.targets = targets.length ? 'found' : null;

  const { quantity, riskPercent } = extractSize(text);
  origins.quantity = quantity === null ? null : 'found';

  const source = extractSource(text);

  /* --- Cohérence : on signale, on ne corrige pas --- */
  if (!ticker) warnings.push("Aucun ticker reconnu : saisissez-le à la main.");
  else if (tickerOrigin === 'guessed') warnings.push(`Ticker déduit du texte (${ticker}), sans cashtag : à confirmer.`);

  if (entry === null) warnings.push("Aucun prix d'entrée reconnu.");
  if (stop === null) warnings.push('Aucun stop dans ce signal : la perte maximale sera inconnue.');

  const direction = side === 'long' ? 1 : -1;
  if (entry !== null && stop !== null && (entry - stop) * direction <= 0) {
    warnings.push(
      side === 'long'
        ? "Le stop est au-dessus de l'entrée pour une position longue : l'un des deux est mal lu."
        : "Le stop est sous l'entrée pour une vente à découvert : l'un des deux est mal lu.",
    );
  }

  const wrongTargets = targets.filter((t) => (t - entry) * direction <= 0);
  if (entry !== null && wrongTargets.length) {
    warnings.push(
      `Objectif${wrongTargets.length > 1 ? 's' : ''} du mauvais côté de l'entrée : ${wrongTargets.join(', ')}.`,
    );
  }

  const core = ['ticker', 'side', 'entry', 'stop', 'targets'];
  const coverage = core.filter((field) => origins[field] === 'found').length / core.length;

  return {
    ticker,
    side,
    entry,
    entryRange: range,
    stop,
    targets,
    quantity,
    riskPercent,
    source: { ...source, text },
    origins,
    warnings,
    coverage,
  };
}

export default parseSignal;
