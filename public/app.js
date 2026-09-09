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
  settingsNote: $('settings-note'),
};

const state = {
  dashboard: null,
  selection: new Set(),
  earnings: {},
  editing: null,
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

/* ---------------- lecture d'un signal ---------------- */

function fillForm(values = {}) {
  const form = els.tradeForm;
  form.classList.remove('hidden');
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
function updateSizing() {
  const form = els.tradeForm;
  const entry = Number(form.entry.value);
  const stop = Number(form.stop.value);
  const settings = state.dashboard?.settings;
  if (!settings || !Number.isFinite(entry) || !Number.isFinite(stop) || entry <= 0 || stop <= 0) {
    els.sizing.textContent = '';
    return;
  }

  const direction = form.side.value === 'short' ? -1 : 1;
  const perShare = (entry - stop) * direction;
  if (perShare <= 0) {
    els.sizing.textContent = "Le stop est du mauvais côté de l'entrée pour ce sens.";
    return;
  }

  const budget = (settings.capital * settings.riskPerTradePct) / 100;
  const quantity = Math.floor(budget / perShare);
  els.sizing.innerHTML =
    `Risquer ${absPct(settings.riskPerTradePct)} de ${money(settings.capital)} sur cette ligne, ` +
    `c'est <strong>${num(quantity, 0)} titres</strong> (${money(perShare * quantity)} de perte au stop). ` +
    `<button type="button" class="link" id="apply-size">Utiliser</button>`;

  const apply = $('apply-size');
  if (apply) apply.onclick = () => { els.tradeForm.quantity.value = quantity; };
}

/* ---------------- rendu du tableau de bord ---------------- */

function render() {
  const d = state.dashboard;
  if (!d) return;

  els.capital.value = d.settings.capital;
  els.risk.value = d.settings.riskPerTradePct;

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
      <div class="sub">${esc(p.source.handle || 'sans auteur')}${p.ageDays ? ` · ${p.ageDays} j` : ''}</div>
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
                  <div class="sub">${esc(p.source.handle || 'sans auteur')}${p.closedAt ? ` · ${esc(p.closedAt.slice(0, 10))}` : ''}</div>
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
  };
}

function resetForm() {
  state.editing = null;
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

els.tradeForm.oninput = updateSizing;

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
      body: { capital: Number(els.capital.value), riskPerTradePct: Number(els.risk.value) },
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
