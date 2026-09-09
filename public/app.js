/**
 * Interface du suivi de positions.
 *
 * Même discipline que le reste du site : tout ce qui vient d'ailleurs -- texte
 * du signal, nom du compte X, message d'erreur du serveur -- passe par `esc`
 * avant d'entrer dans le document.
 *
 * L'état affiché n'est jamais recalculé ici : chaque mutation renvoie le
 * tableau de bord complet, et c'est lui qu'on rend. Une action groupée à
 * moitié appliquée reste ainsi lisible, sans divergence entre l'écran et le
 * fichier.
 */

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  summary: $('summary'),
  attention: $('attention'),
  toolbar: $('toolbar'),
  table: $('table'),
  traders: $('traders'),
  closed: $('closed'),
  signalText: $('signal-text'),
  signalRead: $('signal-read'),
  tradeForm: $('trade-form'),
  sizing: $('sizing'),
  addBtn: $('add-btn'),
  capital: $('capital'),
  risk: $('risk'),
  stopPercent: $('stop-percent'),
  feeFixed: $('fee-fixed'),
  feePercent: $('fee-percent'),
  stopNote: $('stop-note'),
  settingsNote: $('settings-note'),
  shots: $('shots'),
  imageInput: $('image-input'),
  pasteCard: $('paste-form').closest('.card'),
};

const state = {
  dashboard: null,
  selection: new Set(),
  earnings: {},
  editing: null,
  // Captures attachées au formulaire en cours : envoyées au serveur dès le
  // collage, rattachées à la position au moment de valider.
  shots: [],
  // Vrai tant que le stop affiché vient de la règle de sortie et non d'une
  // saisie : dans ce cas seulement, changer l'entrée le recalcule.
  stopAuto: true,
};

/* ---------------- utilitaires ---------------- */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

const num = (value, digits = 2) =>
  isNum(value)
    ? value.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—';

const money = (value, digits = 0) => {
  if (!isNum(value)) return '—';
  const currency = state.dashboard?.settings?.currency || 'USD';
  return value.toLocaleString('fr-FR', {
    style: 'currency',
    currency,
    // « $ » plutôt que « $US » : la devise est rappelée dans les réglages, et
    // la colonne doit rester lisible.
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

const signedMoney = (value, digits = 0) => (isNum(value) && value > 0 ? `+${money(value, digits)}` : money(value, digits));
const pct = (value, digits = 2) => (isNum(value) ? `${value > 0 ? '+' : ''}${num(value, digits)} %` : '—');
const absPct = (value, digits = 1) => (isNum(value) ? `${num(value, digits)} %` : '—');
const tone = (value) => (isNum(value) ? (value > 0 ? 'up' : value < 0 ? 'down' : '') : '');

const SIDE_LABEL = { long: 'Achat', short: 'Vente' };
const STATUS_LABEL = { open: 'ouverte', watch: 'en veille', closed: 'soldée' };
const LEVEL_TONE = { danger: 'red', warn: 'amber', good: 'green', info: 'slate' };

/** Étiquettes courtes des alertes ; le texte complet reste en infobulle. */
const ALERT_LABEL = {
  'stop-hit': 'stop franchi',
  'near-stop': 'près du stop',
  'target-hit': 'objectif atteint',
  'to-breakeven': 'stop à sécuriser',
  'no-stop': 'sans stop',
  oversized: 'risque élevé',
  heavy: 'ligne lourde',
  stale: 'ligne ancienne',
  'missed-entry': 'entrée manquée',
  'poor-rr': 'gain/risque faible',
  'poor-rr-now': 'gain/risque dégradé',
  'no-price': 'sans cotation',
  'portfolio-risk': 'risque global',
  'unbounded-risk': 'risque non borné',
  'over-invested': 'sur-exposition',
  'ticker-concentration': 'concentration',
  'trader-concentration': 'un seul compte',
  'too-many': 'trop de lignes',
};

const alertLabel = (code) => ALERT_LABEL[code] || code;

/* ---------------- appels serveur ---------------- */

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Erreur ${response.status}`);
  return data;
}

function fail(error) {
  els.status.className = 'msg error';
  els.status.textContent = error.message;
}

function clearStatus() {
  els.status.className = 'msg hidden';
  els.status.textContent = '';
}

/** Applique un tableau de bord renvoyé par le serveur. */
function adopt(dashboard) {
  if (!dashboard) return;
  state.dashboard = dashboard;
  // Une ligne supprimée ou soldée ne doit pas rester sélectionnée.
  const alive = new Set(dashboard.positions.map((p) => p.id));
  state.selection = new Set([...state.selection].filter((id) => alive.has(id)));
  render();
}

async function load({ silent = false } = {}) {
  if (!silent) {
    els.status.className = 'msg';
    els.status.innerHTML = '<span class="spinner"></span>Cotations en cours…';
  }
  try {
    adopt(await api('/api/trades'));
    clearStatus();
    loadEarnings();
  } catch (error) {
    fail(error);
  }
}

/**
 * Veille « résultats » : une publication trimestrielle traversée en cours de
 * position est le risque que le copy trading fait oublier. Chargée après coup,
 * parce qu'elle coûte deux requêtes par ticker.
 */
async function loadEarnings() {
  try {
    const { watch } = await api('/api/trades/earnings');
    state.earnings = watch || {};
    render();
  } catch {
    // Bonus : son absence ne change rien au reste de l'écran.
  }
}

/* ---------------- captures d'écran ---------------- */

/**
 * Beaucoup de posts ne chiffrent rien : « regardez le TP final » renvoie au
 * graphique. La capture est alors la seule trace des niveaux promis, et elle
 * mérite d'être rangée avec la position plutôt que perdue dans le fil.
 */
async function uploadShot(file) {
  if (!file || !file.type.startsWith('image/')) return null;
  try {
    const response = await fetch('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Erreur ${response.status}`);
    return data.image;
  } catch (error) {
    fail(error);
    return null;
  }
}

async function addShots(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;

  // Une capture collée alors qu'aucun formulaire n'est ouvert en ouvre un :
  // c'est souvent par là que commence la saisie d'un signal en image.
  if (els.tradeForm.classList.contains('hidden')) fillForm({});

  for (const file of images) {
    const shot = await uploadShot(file);
    if (shot) state.shots.push(shot);
    renderShots();
  }
}

function renderShots() {
  if (!state.shots.length) {
    els.shots.innerHTML = '';
    els.shots.classList.remove('filled');
    return;
  }

  els.shots.classList.add('filled');
  els.shots.innerHTML = state.shots
    .map(
      (shot, index) => `
      <figure class="shot">
        <img src="/api/images/${esc(shot.id)}" alt="Capture ${index + 1} du signal" loading="lazy">
        <button type="button" class="shot-remove" data-remove="${esc(shot.id)}" title="Retirer">✕</button>
      </figure>`,
    )
    .join('');

  for (const image of els.shots.querySelectorAll('img')) {
    image.onclick = () => openViewer(state.shots.map((s) => s.id), [...els.shots.querySelectorAll('img')].indexOf(image));
  }
  for (const button of els.shots.querySelectorAll('[data-remove]')) {
    button.onclick = () => {
      state.shots = state.shots.filter((s) => s.id !== button.dataset.remove);
      renderShots();
    };
  }
}

/** Visionneuse plein écran : une capture de graphique ne se lit pas en vignette. */
function openViewer(ids, start = 0) {
  if (!ids.length) return;
  let index = Math.max(0, Math.min(start, ids.length - 1));

  const overlay = document.createElement('div');
  overlay.className = 'viewer';
  overlay.innerHTML = `
    <div class="viewer-bar">
      ${ids.length > 1 ? `<span class="viewer-count">${index + 1} / ${ids.length}</span>` : ''}
      <button class="viewer-btn" data-zoom="out" title="Dézoomer (-)">−</button>
      <button class="viewer-btn" data-zoom="fit" title="Ajuster à l'écran (0)">Ajuster</button>
      <button class="viewer-btn zoom-label" data-zoom="full" title="Taille réelle (1)">100 %</button>
      <button class="viewer-btn" data-zoom="in" title="Zoomer (+)">+</button>
      <a class="viewer-btn" data-role="open" href="#" target="_blank" rel="noopener" title="Ouvrir l'image seule">Onglet</a>
      <button class="viewer-btn" data-role="close" title="Fermer (Échap)">✕</button>
    </div>
    ${ids.length > 1 ? '<button class="viewer-nav prev" title="Précédente (←)">‹</button>' : ''}
    <div class="viewer-stage"><img alt="Capture du signal" draggable="false"></div>
    ${ids.length > 1 ? '<button class="viewer-nav next" title="Suivante (→)">›</button>' : ''}
    <div class="viewer-hint">molette pour zoomer · glisser pour déplacer · double-clic pour la taille réelle</div>`;

  const stage = overlay.querySelector('.viewer-stage');
  const image = overlay.querySelector('img');
  const label = overlay.querySelector('.zoom-label');
  const link = overlay.querySelector('[data-role="open"]');

  // Une capture de graphique fait souvent deux fois la largeur de l'écran :
  // ajustée, elle devient illisible. La visionneuse garde donc une échelle
  // propre, un déplacement, et un retour immédiat à la taille réelle.
  let scale = 1;
  let fitScale = 1;
  let x = 0;
  let y = 0;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function apply() {
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    if (label) label.textContent = `${Math.round(scale * 100)} %`;
    stage.classList.toggle('pannable', scale > fitScale + 0.001);
  }

  /** Recentre, et recadre pour qu'on ne perde jamais l'image hors de l'écran. */
  function settle() {
    const box = stage.getBoundingClientRect();
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;

    x = width <= box.width ? (box.width - width) / 2 : clamp(x, box.width - width, 0);
    y = height <= box.height ? (box.height - height) / 2 : clamp(y, box.height - height, 0);
    apply();
  }

  function fit() {
    const box = stage.getBoundingClientRect();
    if (!image.naturalWidth) return;
    // Jamais d'agrandissement à l'ouverture : une petite capture s'affiche à
    // sa taille, une grande est réduite juste ce qu'il faut.
    fitScale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight, 1);
    scale = fitScale;
    settle();
  }

  function zoomAt(clientX, clientY, factor) {
    const box = stage.getBoundingClientRect();
    const px = clientX - box.left;
    const py = clientY - box.top;
    const next = clamp(scale * factor, Math.min(fitScale, 0.1), 8);

    // Le point sous le curseur ne bouge pas : c'est ce qui rend le zoom
    // utilisable pour aller lire un niveau précis du graphique.
    x = px - ((px - x) * next) / scale;
    y = py - ((py - y) * next) / scale;
    scale = next;
    settle();
  }

  function show(next) {
    index = (next + ids.length) % ids.length;
    image.src = `/api/images/${ids[index]}`;
    link.href = `/api/images/${ids[index]}`;
    const count = overlay.querySelector('.viewer-count');
    if (count) count.textContent = `${index + 1} / ${ids.length}`;
  }

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', fit);
  };

  function onKey(event) {
    const actions = {
      Escape: close,
      ArrowRight: () => show(index + 1),
      ArrowLeft: () => show(index - 1),
      0: fit,
      1: () => { scale = 1; settle(); },
      '+': () => zoomAt(innerWidth / 2, innerHeight / 2, 1.25),
      '=': () => zoomAt(innerWidth / 2, innerHeight / 2, 1.25),
      '-': () => zoomAt(innerWidth / 2, innerHeight / 2, 0.8),
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  }

  image.onload = fit;

  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    // Le pincement d'un pavé tactile arrive ici avec ctrlKey : même geste.
    zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.15 : 0.87);
  }, { passive: false });

  stage.addEventListener('dblclick', (event) => {
    if (scale > fitScale + 0.001) fit();
    else zoomAt(event.clientX, event.clientY, 1 / scale);
  });

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const from = { x: event.clientX - x, y: event.clientY - y };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('dragging');

    const move = (moved) => {
      x = moved.clientX - from.x;
      y = moved.clientY - from.y;
      settle();
    };
    const up = () => {
      stage.classList.remove('dragging');
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
    };

    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
  });

  overlay.addEventListener('click', (event) => {
    const zoom = event.target.dataset?.zoom;
    if (zoom === 'in') zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
    if (zoom === 'out') zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
    if (zoom === 'fit') fit();
    if (zoom === 'full') { scale = 1; settle(); }
    if (event.target.dataset?.role === 'close' || event.target === overlay) close();
    if (event.target.classList.contains('prev')) show(index - 1);
    if (event.target.classList.contains('next')) show(index + 1);
  });

  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', fit);
  document.body.appendChild(overlay);
  show(index);
}

/* ---------------- lecture d'un signal ---------------- */

function fillForm(values = {}) {
  const form = els.tradeForm;
  form.classList.remove('hidden');
  // Sans stop fourni, celui qu'affichera le formulaire viendra de la règle de
  // sortie : il reste recalculé tant que l'utilisateur n'y touche pas.
  state.stopAuto = !isNum(values.stop);
  form.ticker.value = values.ticker ?? '';
  form.side.value = values.side ?? 'long';
  form.status.value = values.status ?? 'open';
  form.entry.value = isNum(values.entry) ? values.entry : '';
  form.stop.value = isNum(values.stop) ? values.stop : '';
  form.targets.value = (values.targets || []).join(', ');
  form.quantity.value = isNum(values.quantity) ? values.quantity : '';
  form.handle.value = values.handle ?? '';
  form.note.value = values.note ?? '';
  updateSizing();
  form.ticker.focus();
}

function renderSignal(signal, suggestion) {
  const origin = (field) =>
    ({ found: 'lu dans le signal', guessed: 'déduit', default: 'valeur par défaut' }[signal.origins[field]] || 'absent');

  const rows = [
    ['Ticker', signal.ticker || '—', 'ticker'],
    ['Sens', signal.side ? SIDE_LABEL[signal.side] : '—', 'side'],
    ['Entrée', signal.entryRange ? `${num(signal.entryRange[0])} – ${num(signal.entryRange[1])}` : num(signal.entry), 'entry'],
    ['Stop', num(signal.stop), 'stop'],
    ['Objectifs', signal.targets.length ? signal.targets.map((t) => num(t)).join(' · ') : '—', 'targets'],
  ];

  els.signalRead.className = 'signal-read';
  els.signalRead.innerHTML = `
    <div class="signal-grid">
      ${rows
        .map(
          ([label, value, field]) => `
        <div class="signal-cell">
          <div class="k">${esc(label)}</div>
          <div class="v">${esc(value)}</div>
          <div class="n">${esc(origin(field))}</div>
        </div>`,
        )
        .join('')}
    </div>
    ${
      signal.source.handle
        ? `<p class="verdict-line">Compte : <strong>${esc(signal.source.handle)}</strong></p>`
        : '<p class="verdict-line faint">Aucun compte X identifié dans le texte : renseignez-le pour suivre ses résultats.</p>'
    }
    ${
      signal.warnings.length
        ? `<ul class="list warn">${signal.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
        : ''
    }
    ${
      suggestion && !suggestion.stopFromSignal && isNum(suggestion.stop)
        ? `<p class="verdict-line">Aucun stop dans le post : votre règle de sortie à
             ${absPct(suggestion.stopPercent)} le place à <strong>${num(suggestion.stop)}</strong>.</p>`
        : ''
    }
    ${
      isNum(suggestion?.quantity)
        ? `<p class="verdict-line">Taille pour risquer ${absPct(suggestion.riskPerTradePct)} de ${money(suggestion.capital)} :
             <strong>${num(suggestion.quantity, 0)} titres</strong>.</p>`
        : ''
    }`;
}

async function readSignal(text) {
  try {
    const { signal, suggestion } = await api('/api/trades/parse', { method: 'POST', body: { text } });
    state.editing = null;
    els.addBtn.textContent = 'Ajouter la position';
    renderSignal(signal, suggestion);
    fillForm({
      ticker: signal.ticker,
      side: signal.side,
      entry: signal.entry,
      stop: signal.stop,
      targets: signal.targets,
      quantity: suggestion?.quantity ?? signal.quantity,
      handle: signal.source.handle,
      status: 'open',
    });
    clearStatus();
  } catch (error) {
    fail(error);
  }
}

/** Taille suggérée, recalculée à chaque frappe dans le formulaire. */
/**
 * Plan de taille, calculé par le serveur pendant la saisie.
 *
 * Deux questions que l'écran ne doit pas confondre. « Combien risquer » : la
 * taille qui met en jeu le pourcentage de capital choisi si le stop est touché.
 * « À partir de combien ça vaut la peine » : en dessous d'une certaine taille,
 * les frais d'aller-retour prennent une part absurde du gain visé.
 *
 * Aucune des deux ne rend un trade gagnant -- la taille ne change que la somme
 * en jeu.
 */
let planTimer = null;

function updateSizing() {
  clearTimeout(planTimer);
  planTimer = setTimeout(loadPlan, 400);
}

async function loadPlan() {
  const form = els.tradeForm;
  const entry = Number(form.entry.value);

  if (!Number.isFinite(entry) || entry <= 0) {
    els.sizing.textContent = '';
    els.stopNote.textContent = '';
    return;
  }

  const params = new URLSearchParams({ entry, side: form.side.value });
  const stop = Number(form.stop.value);
  if (form.stop.value.trim() !== '' && Number.isFinite(stop) && stop > 0 && !state.stopAuto) {
    params.set('stop', stop);
  }
  const target = Number(form.targets.value.split(/[,;\s]+/).filter(Boolean)[0]);
  if (Number.isFinite(target) && target > 0) params.set('target', target);

  try {
    const data = await api(`/api/trades/plan?${params}`);

    // Le signal n'a pas donné de stop : la règle de sortie le pose, et le dit.
    if (state.stopAuto && data.stop !== null) {
      form.stop.value = data.stop;
      els.stopNote.textContent = `règle de sortie : -${num(data.settings.stopPercent, 1)} % de l'entrée`;
    } else {
      els.stopNote.textContent = '';
    }

    renderPlan(data.plan, data.settings);
  } catch {
    // Un plan indisponible ne bloque pas la saisie.
  }
}

function renderPlan(plan, settings) {
  if (!plan) {
    els.sizing.textContent = '';
    return;
  }

  if (!plan.quantity) {
    els.sizing.textContent = "Sans stop exploitable, aucune taille ne peut être calculée : indiquez-le, ou laissez la règle de sortie s'appliquer.";
    return;
  }

  const lignes = [
    `Risquer ${absPct(plan.riskPercent)} de ${money(plan.capital)}, c'est <strong>${num(plan.quantity, 0)} titres</strong> ` +
      `(${money(plan.notional)} engagés, ${money(plan.riskAmount)} de perte au stop). ` +
      `<button type="button" class="link" id="apply-size">Utiliser</button>`,
  ];

  if (plan.fees.declared) {
    lignes.push(
      `Frais aller-retour à cette taille : <strong>${money(plan.fees.roundTrip, 2)}</strong>. ` +
        `Il faut dépasser <strong>${num(plan.fees.breakEven)}</strong> pour gagner un centime.`,
    );
    if (plan.minQuantity) {
      lignes.push(
        `En dessous de <strong>${num(plan.minQuantity, 0)} titres</strong>, les frais prennent plus du cinquième du gain visé : ` +
          `le trade ne vaut pas la peine d'être pris.`,
      );
    }
    if (plan.feeWarning) lignes.push(esc(plan.feeWarning));
  } else {
    lignes.push(
      `<span class="faint">Frais de courtage non renseignés : le seuil de rentabilité ne peut pas être calculé. ` +
        `Indiquez-les en haut de page.</span>`,
    );
  }

  if (isNum(plan.netAtTarget)) {
    lignes.push(
      `Au premier objectif : <strong class="up">${signedMoney(plan.netAtTarget, 2)}</strong> net de frais. ` +
        `Au stop : <strong class="down">${signedMoney(plan.netAtStop, 2)}</strong>.`,
    );
  }

  els.sizing.innerHTML = lignes.map((l) => `<span class="plan-line">${l}</span>`).join('');

  const apply = $('apply-size');
  if (apply) apply.onclick = () => { els.tradeForm.quantity.value = plan.quantity; };
}

/* ---------------- rendu du tableau de bord ---------------- */

function render() {
  const d = state.dashboard;
  if (!d) return;

  els.capital.value = d.settings.capital;
  els.risk.value = d.settings.riskPerTradePct;
  els.stopPercent.value = d.settings.stopPercent;
  els.feeFixed.value = d.settings.feeFixed;
  els.feePercent.value = d.settings.feePercent;

  renderSummary(d);
  renderAttention(d);
  renderToolbar(d);
  renderTable(d);
  renderTraders(d);
  renderClosed(d);
}

function renderSummary(d) {
  const s = d.summary;
  const risk = s.risk;

  els.summary.innerHTML = `
  <section class="card">
    <h2>État du portefeuille</h2>
    <div class="stats">
      <div class="stat">
        <div class="k">Exposition</div>
        <div class="v">${money(s.exposure)}</div>
        <div class="n">${absPct(s.exposurePercent)} du capital</div>
      </div>
      <div class="stat">
        <div class="k">Si tous les stops sautent</div>
        <div class="v ${isNum(risk.percent) && risk.percent > risk.limitPercent ? 'down' : ''}">-${money(risk.bounded)}</div>
        <div class="n">${absPct(risk.percent)} du capital · limite ${absPct(risk.limitPercent)}</div>
      </div>
      <div class="stat">
        <div class="k">Latent</div>
        <div class="v ${tone(s.unrealized)}">${signedMoney(s.unrealized)}</div>
        <div class="n">${pct(s.unrealizedPercent)} de l'engagé</div>
      </div>
      <div class="stat">
        <div class="k">Réalisé</div>
        <div class="v ${tone(s.realized)}">${signedMoney(s.realized)}</div>
        <div class="n">${s.counts.closed} soldée${s.counts.closed > 1 ? 's' : ''}${isNum(s.realizedR) ? ` · ${num(s.realizedR)} R cumulés` : ''}</div>
      </div>
      <div class="stat">
        <div class="k">Lignes</div>
        <div class="v">${s.counts.open}</div>
        <div class="n">${s.counts.watch} en veille · ${risk.withoutStop} sans stop</div>
      </div>
      <div class="stat">
        <div class="k">Sans stop</div>
        <div class="v ${risk.withoutStop ? 'down' : ''}">${money(risk.unboundedExposure)}</div>
        <div class="n">perte maximale inconnue</div>
      </div>
    </div>
  </section>`;
}

/** Ce qui réclame une décision : alertes de portefeuille et lignes en danger. */
function renderAttention(d) {
  const flagged = d.positions
    .filter((p) => p.alerts.some((a) => a.level === 'danger' || a.level === 'good'))
    .map((p) => ({ position: p, alerts: p.alerts.filter((a) => a.level === 'danger' || a.level === 'good') }));

  if (!d.summary.alerts.length && !flagged.length) {
    els.attention.innerHTML = d.summary.counts.open
      ? `<section class="card"><h2>À traiter</h2><p class="verdict-line faint">Rien ne réclame de décision immédiate : aucun stop franchi, aucun objectif atteint.</p></section>`
      : '';
    return;
  }

  els.attention.innerHTML = `
  <section class="card">
    <h2>À traiter</h2>
    ${
      d.summary.alerts.length
        ? `<ul class="list">${d.summary.alerts
            .map((a) => `<li><span class="tag t-${LEVEL_TONE[a.level]}">${esc(alertLabel(a.code))}</span> ${esc(a.message)}</li>`)
            .join('')}</ul>`
        : ''
    }
    ${
      flagged.length
        ? `<ul class="list attention-list">${flagged
            .map(
              ({ position, alerts }) => `
          <li>
            <span class="mono sym">${esc(position.ticker)}</span>
            <span class="msgs">${alerts.map((a) => `<span class="t-${LEVEL_TONE[a.level]}">${esc(a.message)}</span>`).join(' ')}</span>
            <button class="link" data-select="${esc(position.id)}">sélectionner</button>
          </li>`,
            )
            .join('')}</ul>`
        : ''
    }
  </section>`;

  for (const button of els.attention.querySelectorAll('[data-select]')) {
    button.onclick = () => {
      state.selection.add(button.dataset.select);
      render();
      els.toolbar.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  }
}

function renderToolbar(d) {
  const count = state.selection.size;
  const disabled = count ? '' : 'disabled';

  els.toolbar.innerHTML = `
    <div class="select-row">
      <span class="count">${count} ligne${count > 1 ? 's' : ''} sélectionnée${count > 1 ? 's' : ''}</span>
      <button class="link" data-pick="all">toutes</button>
      <button class="link" data-pick="alert">celles en alerte</button>
      <button class="link" data-pick="none">aucune</button>
    </div>
    <div class="batch-row">
      <button class="batch" data-action="close" ${disabled}>Clôturer au marché</button>
      <button class="batch" data-action="protect" ${disabled}>Stop à -${num(d.settings.stopPercent, 1)} %</button>
      <button class="batch" data-action="breakeven" ${disabled}>Stop à l'équilibre</button>
      <span class="trail">
        <button class="batch" data-action="trail" ${disabled}>Stop suiveur</button>
        <input id="trail-pct" type="number" value="3" min="0.5" max="49" step="0.5" aria-label="Distance du stop suiveur en pourcent"> %
      </span>
      <button class="batch" data-action="take" ${disabled}>Prendre au marché</button>
      <button class="batch danger" data-action="delete" ${disabled}>Supprimer</button>
    </div>`;

  const pick = {
    all: () => d.positions.filter((p) => p.status !== 'closed').map((p) => p.id),
    alert: () => d.positions.filter((p) => p.alerts.some((a) => a.level === 'danger' || a.level === 'good')).map((p) => p.id),
    none: () => [],
  };

  for (const button of els.toolbar.querySelectorAll('[data-pick]')) {
    button.onclick = () => {
      state.selection = new Set(pick[button.dataset.pick]());
      render();
    };
  }

  for (const button of els.toolbar.querySelectorAll('[data-action]')) {
    button.onclick = () => runBatch(button.dataset.action);
  }
}

function alertTags(position) {
  if (!position.alerts.length) return '';
  return position.alerts
    .map((a) => `<span class="pill t-${LEVEL_TONE[a.level]}" title="${esc(a.message)}">${esc(alertLabel(a.code))}</span>`)
    .join('');
}

/**
 * Publication de résultats à venir. Au-delà de trois semaines, l'échéance ne
 * change rien à la conduite d'un trade de swing : on ne l'affiche pas, pour
 * que le rappel garde son sens quand il apparaît.
 */
/** Pastille « captures » : le graphique du post, à un clic de la ligne. */
function shotBadge(position) {
  const ids = position.attachments || [];
  if (!ids.length) return '';
  return `<button class="shot-badge" data-shots="${esc(ids.join(','))}" title="Voir la capture du signal">📎 ${ids.length}</button>`;
}

function earningsTag(ticker) {
  const e = state.earnings[ticker];
  if (!e || !isNum(e.days) || e.days < 0 || e.days > 21) return '';
  const label = e.days === 0 ? "résultats aujourd'hui" : `résultats dans ${e.days} j`;
  return `<span class="pill ${e.imminent ? 't-amber' : 't-slate'}" title="Publication le ${esc(e.date)} (${esc(e.confidence)})">${esc(label)}</span>`;
}

function renderTable(d) {
  const rows = d.positions.filter((p) => p.status !== 'closed');

  if (!rows.length) {
    els.table.innerHTML = `<p class="verdict-line faint">Aucune position suivie pour l'instant. Collez un signal ci-dessus.</p>`;
    return;
  }

  els.table.innerHTML = `
  <div class="table-scroll">
    <table class="positions">
      <thead>
        <tr>
          <th></th>
          <th>Ligne</th>
          <th class="num">Qté</th>
          <th class="num">Entrée</th>
          <th class="num">Prix</th>
          <th class="num">P&amp;L</th>
          <th class="num">R</th>
          <th class="num">Stop</th>
          <th class="num">Objectif</th>
          <th>État</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(row).join('')}
      </tbody>
    </table>
  </div>`;

  for (const box of els.table.querySelectorAll('input[type=checkbox][data-id]')) {
    box.onchange = () => {
      if (box.checked) state.selection.add(box.dataset.id);
      else state.selection.delete(box.dataset.id);
      renderToolbar(state.dashboard);
    };
  }

  for (const input of els.table.querySelectorAll('input.stop-input')) {
    input.onchange = async () => {
      const value = input.value.trim();
      try {
        adopt(
          (await api(`/api/trades/${encodeURIComponent(input.dataset.id)}`, {
            method: 'PATCH',
            body: { stop: value === '' ? null : Number(value) },
          })).dashboard,
        );
        clearStatus();
      } catch (error) {
        fail(error);
        render();
      }
    };
  }

  for (const button of els.table.querySelectorAll('[data-shots]')) {
    button.onclick = () => openViewer(button.dataset.shots.split(','));
  }

  for (const button of els.table.querySelectorAll('[data-edit]')) {
    button.onclick = () => startEdit(button.dataset.edit);
  }
  for (const button of els.table.querySelectorAll('[data-close]')) {
    button.onclick = () => runBatch('close', { ids: [button.dataset.close] });
  }
  for (const button of els.table.querySelectorAll('[data-delete]')) {
    button.onclick = () => runBatch('delete', { ids: [button.dataset.delete] });
  }
}

function row(p) {
  const checked = state.selection.has(p.id) ? 'checked' : '';
  const watching = p.status === 'watch';

  return `
  <tr class="${p.alerts.some((a) => a.level === 'danger') ? 'flagged' : ''}">
    <td><input type="checkbox" data-id="${esc(p.id)}" ${checked} aria-label="Sélectionner ${esc(p.ticker)}"></td>
    <td>
      <div class="sym mono">${esc(p.ticker)} <span class="side ${p.side}">${esc(SIDE_LABEL[p.side])}</span></div>
      <div class="sub">${esc(p.source.handle || 'sans auteur')}${p.ageDays ? ` · ${p.ageDays} j` : ''} ${shotBadge(p)}</div>
    </td>
    <td class="num">${watching ? '—' : num(p.quantity, 0)}</td>
    <td class="num">${num(p.entry)}</td>
    <td class="num">${num(p.price)}<div class="sub">${pct(p.drift)}</div></td>
    <td class="num ${tone(p.pnl)}">${watching ? '—' : signedMoney(p.pnl, 2)}<div class="sub">${watching ? '' : pct(p.pnlPercent)}</div></td>
    <td class="num ${tone(p.rMultiple)}">${isNum(p.rMultiple) ? num(p.rMultiple) : '—'}</td>
    <td class="num">
      <input class="stop-input" type="number" step="any" min="0" value="${isNum(p.stop) ? p.stop : ''}"
             data-id="${esc(p.id)}" aria-label="Stop de ${esc(p.ticker)}" placeholder="aucun">
      <div class="sub">${isNum(p.stopDistancePercent) ? `${absPct(p.stopDistancePercent)} de marge` : 'non borné'}</div>
    </td>
    <td class="num">${isNum(p.nextTarget) ? num(p.nextTarget) : '—'}<div class="sub">${isNum(p.targetDistancePercent) ? absPct(p.targetDistancePercent) : ''}</div></td>
    <td>
      <div class="pills">${earningsTag(p.ticker)}${alertTags(p)}</div>
      <div class="sub">${esc(STATUS_LABEL[p.status])}${isNum(p.rewardRisk) ? ` · gain/risque ${num(p.rewardRisk)}` : ''}</div>
    </td>
    <td class="actions">
      <button class="link" data-edit="${esc(p.id)}" title="Modifier">✎</button>
      ${watching ? '' : `<button class="link" data-close="${esc(p.id)}" title="Clôturer au marché">⨯</button>`}
      <button class="link danger" data-delete="${esc(p.id)}" title="Supprimer">🗑</button>
    </td>
  </tr>`;
}

function renderTraders(d) {
  if (!d.traders.length) {
    els.traders.innerHTML = '';
    return;
  }

  els.traders.innerHTML = `
  <section class="card">
    <h2>Comptes suivis</h2>
    <p class="verdict-line faint">
      Le seul chiffre qui compte en copy trading : qui vous fait gagner de l'argent. Il ne devient
      lisible qu'après plusieurs dizaines de trades soldés — l'outil refuse de trancher avant.
    </p>
    <div class="table-scroll">
      <table class="positions">
        <thead>
          <tr>
            <th>Compte</th>
            <th class="num">Ouvertes</th>
            <th class="num">Soldées</th>
            <th class="num">Réussite</th>
            <th class="num">R moyen</th>
            <th class="num">Réalisé</th>
            <th class="num">Exposition</th>
            <th>Bilan</th>
          </tr>
        </thead>
        <tbody>
          ${d.traders
            .map(
              (t) => `
            <tr>
              <td class="mono">${esc(t.handle)}</td>
              <td class="num">${t.open}${t.watch ? ` <span class="sub">+${t.watch}</span>` : ''}</td>
              <td class="num">${t.closed}</td>
              <td class="num">${isNum(t.winRate) ? absPct(t.winRate) : '—'}</td>
              <td class="num ${tone(t.avgR)}">${isNum(t.avgR) ? num(t.avgR) : '—'}</td>
              <td class="num ${tone(t.realized)}">${signedMoney(t.realized)}</td>
              <td class="num">${money(t.exposure)}</td>
              <td><span class="tag t-${esc(t.verdict.tone)}">${esc(t.verdict.label)}</span>
                  <div class="sub">${esc(t.verdict.note)}</div></td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
  </section>`;
}

function renderClosed(d) {
  const closed = d.positions.filter((p) => p.status === 'closed');
  if (!closed.length) {
    els.closed.innerHTML = '';
    return;
  }

  els.closed.innerHTML = `
  <section class="card">
    <details class="sources">
      <summary>${closed.length} position${closed.length > 1 ? 's' : ''} soldée${closed.length > 1 ? 's' : ''}</summary>
      <div class="table-scroll">
        <table class="positions">
          <thead>
            <tr>
              <th>Ligne</th><th class="num">Qté</th><th class="num">Entrée</th>
              <th class="num">Sortie</th><th class="num">Résultat</th><th class="num">R</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${closed
              .map(
                (p) => `
              <tr>
                <td>
                  <div class="sym mono">${esc(p.ticker)} <span class="side ${p.side}">${esc(SIDE_LABEL[p.side])}</span></div>
                  <div class="sub">${esc(p.source.handle || 'sans auteur')}${p.closedAt ? ` · ${esc(p.closedAt.slice(0, 10))}` : ''} ${shotBadge(p)}</div>
                </td>
                <td class="num">${num(p.quantity, 0)}</td>
                <td class="num">${num(p.entry)}</td>
                <td class="num">${num(p.exit)}</td>
                <td class="num ${tone(p.pnl)}">${signedMoney(p.pnl, 2)}<div class="sub">${pct(p.pnlPercent)}</div></td>
                <td class="num ${tone(p.rMultiple)}">${isNum(p.rMultiple) ? num(p.rMultiple) : '—'}</td>
                <td class="actions"><button class="link danger" data-delete="${esc(p.id)}" title="Supprimer">🗑</button></td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </details>
  </section>`;

  for (const button of els.closed.querySelectorAll('[data-delete]')) {
    button.onclick = () => runBatch('delete', { ids: [button.dataset.delete] });
  }
  for (const button of els.closed.querySelectorAll('[data-shots]')) {
    button.onclick = () => openViewer(button.dataset.shots.split(','));
  }
}

/* ---------------- actions ---------------- */

const CONFIRM = {
  delete: (n) => `Supprimer ${n} ligne${n > 1 ? 's' : ''} ? L'historique correspondant sera perdu.`,
  close: (n) => `Clôturer ${n} ligne${n > 1 ? 's' : ''} au dernier prix connu ?`,
};

async function runBatch(action, { ids } = {}) {
  const selected = ids || [...state.selection];
  if (!selected.length) return;

  const ask = CONFIRM[action];
  if (ask && !window.confirm(ask(selected.length))) return;

  const body = { action, ids: selected };
  if (action === 'trail') {
    const percent = Number($('trail-pct')?.value);
    if (!Number.isFinite(percent) || percent <= 0) return fail(new Error('Distance du stop suiveur invalide.'));
    body.percent = percent;
  }

  try {
    const result = await api('/api/trades/batch', { method: 'POST', body });
    adopt(result.dashboard);

    const done = result.changed?.length ?? result.deleted ?? 0;
    const skipped = result.skipped || [];
    els.status.className = skipped.length ? 'msg' : 'msg hidden';
    if (skipped.length) {
      els.status.innerHTML =
        `${done} ligne${done > 1 ? 's' : ''} modifiée${done > 1 ? 's' : ''}, ${skipped.length} laissée${skipped.length > 1 ? 's' : ''} de côté : ` +
        skipped.map((s) => `<strong>${esc(s.ticker)}</strong> (${esc(s.reason)})`).join(', ');
    }
  } catch (error) {
    fail(error);
  }
}

function startEdit(id) {
  const position = state.dashboard.positions.find((p) => p.id === id);
  if (!position) return;

  state.editing = id;
  els.signalRead.className = 'hidden';
  els.addBtn.textContent = 'Enregistrer les modifications';
  state.shots = (position.attachments || []).map((imageId) => ({ id: imageId }));
  renderShots();
  fillForm({
    ticker: position.ticker,
    side: position.side,
    status: position.status,
    entry: position.entry,
    stop: position.stop,
    targets: position.targets,
    quantity: position.quantity,
    handle: position.source.handle,
    note: position.note,
  });
  els.tradeForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function formValues() {
  const form = els.tradeForm;
  const number = (field) => {
    const value = form[field].value.trim();
    return value === '' ? null : Number(value);
  };

  return {
    ticker: form.ticker.value.trim(),
    side: form.side.value,
    status: form.status.value,
    entry: number('entry'),
    stop: number('stop'),
    quantity: number('quantity'),
    targets: form.targets.value
      .split(/[,;\s]+/)
      .filter(Boolean)
      .map(Number),
    handle: form.handle.value.trim() || null,
    note: form.note.value.trim() || null,
    attachments: state.shots.map((shot) => shot.id),
  };
}

function resetForm() {
  state.editing = null;
  state.shots = [];
  renderShots();
  els.tradeForm.reset();
  els.tradeForm.classList.add('hidden');
  els.signalRead.className = 'hidden';
  els.sizing.textContent = '';
  els.addBtn.textContent = 'Ajouter la position';
  els.signalText.value = '';
}

/* ---------------- branchements ---------------- */

$('paste-form').onsubmit = (event) => {
  event.preventDefault();
  const text = els.signalText.value.trim();
  if (!text) return;
  readSignal(text);
};

$('manual-btn').onclick = () => {
  state.editing = null;
  els.signalRead.className = 'hidden';
  els.addBtn.textContent = 'Ajouter la position';
  fillForm({});
};

$('cancel-btn').onclick = resetForm;

/* --- Captures : coller, déposer, choisir --- */

// Un Ctrl+V sur une capture l'attache, où que soit le curseur. Le collage de
// texte, lui, suit son cours normal dans la zone de saisie.
document.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  event.preventDefault();
  addShots(files);
});

els.pasteCard.addEventListener('dragover', (event) => {
  if (![...event.dataTransfer.types].includes('Files')) return;
  event.preventDefault();
  els.pasteCard.classList.add('dropping');
});
els.pasteCard.addEventListener('dragleave', (event) => {
  if (event.target === els.pasteCard) els.pasteCard.classList.remove('dropping');
});
els.pasteCard.addEventListener('drop', (event) => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  els.pasteCard.classList.remove('dropping');
  addShots(event.dataTransfer.files);
});

$('pick-image').onclick = () => els.imageInput.click();
els.imageInput.onchange = () => {
  addShots(els.imageInput.files);
  els.imageInput.value = '';
};

/* --- Entrée au prix du marché --- */

$('market-price').onclick = async () => {
  const ticker = els.tradeForm.ticker.value.trim();
  if (!ticker) return fail(new Error('Saisissez d abord le ticker.'));

  try {
    const { quote } = await api(`/api/trades/quote?ticker=${encodeURIComponent(ticker)}`);
    els.tradeForm.entry.value = quote.price;
    updateSizing();
    clearStatus();
  } catch (error) {
    fail(error);
  }
};

els.tradeForm.oninput = (event) => {
  if (event.target.name === 'stop') state.stopAuto = false;
  updateSizing();
};

els.tradeForm.onsubmit = async (event) => {
  event.preventDefault();
  const values = formValues();

  try {
    const response = state.editing
      ? await api(`/api/trades/${encodeURIComponent(state.editing)}`, { method: 'PATCH', body: values })
      : await api('/api/trades', {
          method: 'POST',
          body: { ...values, signalText: els.signalText.value.trim() || null },
        });
    adopt(response.dashboard);
    resetForm();
    clearStatus();
  } catch (error) {
    fail(error);
  }
};

$('settings-form').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const response = await api('/api/settings', {
      method: 'PATCH',
      body: {
        capital: Number(els.capital.value),
        riskPerTradePct: Number(els.risk.value),
        stopPercent: Number(els.stopPercent.value),
        feeFixed: Number(els.feeFixed.value),
        feePercent: Number(els.feePercent.value),
      },
    });
    adopt(response.dashboard);
    els.settingsNote.textContent = 'Enregistré.';
    setTimeout(() => { els.settingsNote.textContent = ''; }, 2500);
  } catch (error) {
    fail(error);
  }
};

/* Rafraîchissement : le cache des cotations dure une minute, inutile d'aller
   plus vite. En arrière-plan, on ne sollicite rien. */
setInterval(() => {
  if (document.visibilityState === 'visible' && !state.editing) load({ silent: true });
}, 60_000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !state.editing) load({ silent: true });
});

load();
