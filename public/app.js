/**
 * Interface : appelle /api/analyze et met en forme le rapport.
 *
 * Tout ce qui provient d'une source externe (titres de presse, noms de
 * sociétés, libellés) passe par `esc` avant insertion : le contenu scrapé
 * n'est jamais injecté tel quel dans le document.
 */

const form = document.getElementById('form');
const input = document.getElementById('ticker');
const submit = document.getElementById('submit');
const statusBox = document.getElementById('status');
const report = document.getElementById('report');

/* ---------------- utilitaires ---------------- */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

const num = (value, digits = 2) =>
  isNum(value) ? value.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';

/** Montant signé (variation en devise), a ne pas confondre avec un pourcentage. */
const signed = (value, digits = 2) => (isNum(value) ? `${value > 0 ? '+' : ''}${num(value, digits)}` : '—');

const pct = (value, digits = 2) => (isNum(value) ? `${value > 0 ? '+' : ''}${num(value, digits)} %` : '—');
const absPct = (value, digits = 2) => (isNum(value) ? `${num(value, digits)} %` : '—');

function compact(value) {
  if (!isNum(value)) return '—';
  const units = [[1e12, 'T'], [1e9, 'Md'], [1e6, 'M'], [1e3, 'k']];
  for (const [size, suffix] of units) {
    if (Math.abs(value) >= size) return `${num(value / size, 2)} ${suffix}`;
  }
  return num(value, 0);
}

const frDate = (iso) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—';

const VERDICT_TONE = {
  ENTRER: 'green',
  ENTREE_PRUDENTE: 'amber',
  NEUTRE: 'slate',
  EVITER: 'red',
  DONNEES_INSUFFISANTES: 'slate',
};

const TONE_COLOR = { green: '#2fbf71', amber: '#e0a340', red: '#e5544b', slate: '#6b7c96', blue: '#4a90d9' };

const TIMING_LABEL = {
  'after-close': 'après clôture',
  'before-open': 'avant ouverture',
  unknown: 'horaire inconnu',
};

const CONFIDENCE_LABEL = {
  confirmed: 'date confirmée au calendrier',
  expected: 'date annoncée par le fournisseur',
  estimated: 'date extrapolée',
};

/* ---------------- appel API ---------------- */

async function analyze(ticker) {
  submit.disabled = true;
  report.innerHTML = '';
  statusBox.className = 'msg';
  statusBox.innerHTML = `<span class="spinner"></span>Collecte des sources pour <span class="mono">${esc(ticker)}</span>… (une dizaine de requêtes, comptez quelques secondes)`;

  try {
    const response = await fetch(`/api/analyze?ticker=${encodeURIComponent(ticker)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Erreur ${response.status}`);

    statusBox.className = 'msg hidden';
    render(data);
    history.replaceState(null, '', `?ticker=${encodeURIComponent(data.ticker)}`);
  } catch (error) {
    statusBox.className = 'msg error';
    statusBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

/* ---------------- rendu ---------------- */

function render(r) {
  report.innerHTML = [
    renderIdentity(r),
    renderVerdict(r),
    renderAnticipation(r),
    renderEvent(r),
    renderPrice(r),
    renderFactors(r),
    renderReactions(r),
    renderNews(r),
    renderCalibration(r),
    renderSources(r),
  ].join('');
}

function renderIdentity(r) {
  const dir = isNum(r.market.changePercent) && r.market.changePercent < 0 ? 'down' : 'up';
  return `
  <div class="card">
    <div class="identity">
      <div>
        <h2>${esc(r.identity.name || r.ticker)}</h2>
        <div class="sub">
          <span class="mono">${esc(r.identity.symbol)}</span>
          ${r.identity.exchange ? ` · ${esc(r.identity.exchange)}` : ''}
          ${r.identity.sector ? ` · ${esc(r.identity.sector)}` : ''}
        </div>
      </div>
      <div class="price">
        <div class="big">${num(r.market.price)}</div>
        <div class="${dir}">${signed(r.market.change)} (${pct(r.market.changePercent)})</div>
      </div>
    </div>
  </div>`;
}

/** Jauge semi-circulaire : le score global sur l'echelle -100 / +100. */
function gauge(score, tone) {
  const radius = 52;
  const cx = 66;
  const cy = 62;
  const ratio = Math.max(0, Math.min(1, (score + 100) / 200));
  const angle = Math.PI * (1 - ratio);
  const x = cx + radius * Math.cos(angle);
  const y = cy - radius * Math.sin(angle);
  const arcLength = Math.PI * radius;

  return `
  <svg class="gauge" viewBox="0 0 132 78" role="img" aria-label="Score global ${score} sur 100">
    <path d="M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}"
          fill="none" stroke="#243044" stroke-width="9" stroke-linecap="round"/>
    <path d="M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${x} ${y}"
          fill="none" stroke="${TONE_COLOR[tone]}" stroke-width="9" stroke-linecap="round"
          stroke-dasharray="${arcLength}" stroke-dashoffset="0"/>
    <text x="${cx}" y="${cy - 12}" text-anchor="middle" fill="${TONE_COLOR[tone]}"
          font-size="25" font-weight="700" font-family="ui-monospace, monospace">${score > 0 ? '+' : ''}${num(score, 1)}</text>
    <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="#5d6b82" font-size="9.5">score global</text>
  </svg>`;
}

function renderVerdict(r) {
  const d = r.decision;
  const tone = VERDICT_TONE[d.verdict] || 'slate';

  const warnings = d.warnings.length
    ? `<ul class="list warn">${d.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
    : '';

  const plan = d.plan.steps.length
    ? `<ul class="list plan">${d.plan.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
    : '';

  return `
  <div class="card">
    <div class="verdict">
      ${gauge(d.score, tone)}
      <div class="verdict-body">
        <p class="verdict-label t-${tone}">${esc(d.label)}</p>
        <p class="verdict-line">
          Verdict établi sur <strong>${Math.round(d.coverage * 100)} %</strong> des facteurs :
          les sources manquantes réduisent la confiance, elles ne pénalisent pas le titre.
        </p>
        ${isNum(d.daysToEarnings) ? `<p class="verdict-line">Publication dans <strong>${d.daysToEarnings} jour(s)</strong>.</p>` : ''}
      </div>
    </div>
    ${warnings ? `<h2 style="margin-top:20px">Points de vigilance</h2>${warnings}` : ''}
    ${plan ? `<h2 style="margin-top:20px">Ce que cela implique concrètement</h2>${plan}` : ''}
  </div>`;
}

const ANTICIPATION_TONE = { faible: 'green', modere: 'blue', eleve: 'amber', extreme: 'red' };

/**
 * « Est-ce déjà dans le prix ? » — une question distincte de la qualité du
 * dossier. Un excellent dossier entièrement anticipé reste un mauvais point
 * d'entrée, et cette information ne se lit pas dans un score de qualité.
 */
function renderAnticipation(r) {
  const a = r.anticipation;
  if (!a || a.score === null) return '';

  const tone = ANTICIPATION_TONE[a.level] || 'slate';
  const largeur = Math.max(0, Math.min(100, a.score));

  const lignes = a.signals
    .map((s) => {
      if (!s.available) {
        return `
        <div class="antic-row">
          <div class="antic-head">
            <span class="nm">${esc(s.label)}</span>
            <span class="meta">non mesurable</span>
          </div>
          <p class="antic-read faint">${esc(s.reading)}</p>
        </div>`;
      }
      const couleur = s.anticipation >= 70 ? TONE_COLOR.red
        : s.anticipation >= 45 ? TONE_COLOR.amber
          : TONE_COLOR.green;
      return `
      <div class="antic-row">
        <div class="antic-head">
          <span class="nm">${esc(s.label)}</span>
          <span class="meta">${num(s.anticipation, 0)} / 100 · poids ${s.weight}</span>
        </div>
        <div class="antic-track"><span style="width:${s.anticipation}%;background:${couleur}"></span></div>
        <p class="antic-read">${esc(s.reading)}</p>
      </div>`;
    })
    .join('');

  return `
  <div class="card">
    <h2>Est-ce déjà dans le prix ?</h2>
    <div class="antic-score">
      <div class="antic-value t-${tone}">${num(a.score, 0)}<span>/100</span></div>
      <div class="antic-body">
        <p class="antic-label t-${tone}">${esc(a.label)}</p>
        <div class="antic-track big"><span style="width:${largeur}%;background:${TONE_COLOR[tone]}"></span></div>
        <p class="verdict-line">${esc(a.summary)}</p>
      </div>
    </div>
    <p class="verdict-line faint" style="margin-top:12px">
      Ces signaux mesurent les traces publiques d'un positionnement en cours de constitution.
      Ils ne disent pas qui se positionne, et ne détectent aucune manipulation : les
      intervenants qui voient le carnet d'ordres en temps réel restent hors de portée
      d'une donnée différée. Mesuré sur ${Math.round(a.coverage * 100)} % des signaux.
    </p>
    <div class="antic-list">${lignes}</div>
  </div>`;
}

/** L'événement lui-même : date, mouvement price par le marché, référence historique. */
function renderEvent(r) {
  const e = r.earnings;
  const o = r.options;
  const h = r.history;

  const stats = [
    {
      k: 'Prochains résultats',
      v: e ? frDate(e.date) : 'inconnue',
      n: e ? `${CONFIDENCE_LABEL[e.confidence] || e.confidence} · ${TIMING_LABEL[e.timing] || ''}` : 'aucune date identifiée',
    },
    {
      k: 'Échéance',
      v: e && isNum(e.daysAway) ? `J-${e.daysAway}` : '—',
      n: e?.fiscalQuarter ? `trimestre ${esc(e.fiscalQuarter)}` : '',
    },
    {
      k: 'Mouvement implicite',
      v: absPct(o?.impliedMovePercent),
      n: o ? (o.method === 'decomposition' ? 'isole par écart de variance' : 'straddle à la monnaie') : 'options indisponibles',
    },
    {
      k: 'Réaction médiane passée',
      v: absPct(h?.medianAbsMove),
      n: h ? `sur ${h.count} publication(s)` : 'historique indisponible',
    },
    {
      k: 'Scénario adverse',
      v: absPct(r.decision.plan.expectedDownsidePercent),
      n: 'ampleur à supporter sans stop utile',
    },
    {
      k: 'Capitalisation',
      v: compact(r.market.marketCap),
      n: `volume moyen ${compact(r.market.averageVolume)}`,
    },
  ];

  // Comparaison visuelle : ce que price le marché contre ce que fait le titre.
  const implied = o?.impliedMovePercent;
  const historical = h?.medianAbsMove;
  const worst = h?.worstDrop;
  const max = Math.max(implied || 0, historical || 0, worst || 0, 1);

  const row = (name, value, color) => `
    <div class="barrow">
      <span class="name">${name}</span>
      <span class="track"><span class="fill" style="width:${Math.min(100, ((value || 0) / max) * 100)}%;background:${color}"></span></span>
      <span class="val">${absPct(value, 1)}</span>
    </div>`;

  const comparison = isNum(implied) || isNum(historical)
    ? `<h2 style="margin-top:22px">Ce que le marché price face a l'historique</h2>
       <div class="bars">
         ${row('Mouvement implicite', implied, TONE_COLOR.blue)}
         ${row('Médiane historique', historical, TONE_COLOR.slate)}
         ${row('Pire baisse passée', worst, TONE_COLOR.red)}
       </div>
       ${renderRatioNote(implied, historical)}`
    : '';

  const windowNote = e?.windowConflict
    ? `<p class="verdict-line" style="margin-top:14px;color:#f0d7a8">
         Le marché options situe la publication entre le ${frDate(o?.impliedWindow?.after)} et le
         ${frDate(o?.impliedWindow?.before)}, ce qui contredit la date retenue.
       </p>`
    : '';

  return `
  <div class="card">
    <h2>L'événement</h2>
    <div class="stats">
      ${stats.map((s) => `<div class="stat"><div class="k">${s.k}</div><div class="v">${s.v}</div><div class="n">${s.n}</div></div>`).join('')}
    </div>
    ${windowNote}
    ${comparison}
  </div>`;
}

function renderRatioNote(implied, historical) {
  if (!isNum(implied) || !isNum(historical) || historical === 0) return '';
  const ratio = implied / historical;
  const text =
    ratio > 1.3
      ? `Le marché price <strong>${num(ratio, 2)} fois</strong> l'amplitude habituelle : la barre à franchir pour que la position soit gagnante est haute.`
      : ratio < 0.85
        ? `Le marché price <strong>${num(ratio, 2)} fois</strong> l'amplitude habituelle : l'événement parait sous-estime, une surprise se paierait plus cher que ne le suggere la prime.`
        : `Mouvement implicite cohérent avec l'historique (<strong>${num(ratio, 2)} fois</strong>) : pas d'anomalie exploitable de ce cote.`;
  return `<p class="verdict-line" style="margin-top:12px">${text}</p>`;
}

/** Courbe de clôture sur les derniers mois. */
function renderPrice(r) {
  const series = r.priceSeries || [];
  if (series.length < 10) return '';

  const width = 1000;
  const height = 150;
  const values = series.map((p) => p.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const points = series.map((p, i) => {
    const x = (i / (series.length - 1)) * width;
    const y = height - ((p.close - min) / span) * (height - 16) - 8;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const rising = values.at(-1) >= values[0];
  const color = rising ? TONE_COLOR.green : TONE_COLOR.red;
  const ind = r.indicators;

  return `
  <div class="card">
    <h2>Cours sur ${series.length} séances</h2>
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:150px" role="img"
         aria-label="Evolution du cours sur ${series.length} seances">
      <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5"
                vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="stats" style="margin-top:14px">
      <div class="stat"><div class="k">Plus haut / bas 52 s.</div><div class="v">${num(r.market.fiftyTwoWeekHigh)} / ${num(r.market.fiftyTwoWeekLow)}</div></div>
      <div class="stat"><div class="k">Perf 1 mois</div><div class="v ${isNum(ind?.perf21) && ind.perf21 < 0 ? 'down' : 'up'}">${pct(ind?.perf21, 1)}</div></div>
      <div class="stat"><div class="k">Perf 3 mois</div><div class="v ${isNum(ind?.perf63) && ind.perf63 < 0 ? 'down' : 'up'}">${pct(ind?.perf63, 1)}</div></div>
      <div class="stat"><div class="k">RSI 14</div><div class="v">${num(ind?.rsi14, 1)}</div></div>
      <div class="stat"><div class="k">Volatilité realisee 30j</div><div class="v">${absPct(ind?.realizedVol30, 1)}</div></div>
      <div class="stat"><div class="k">Objectif analystes 1 an</div><div class="v">${num(r.market.oneYearTarget)}</div></div>
    </div>
  </div>`;
}

function renderFactors(r) {
  const factors = r.decision.factors
    .map((f) => {
      const tone = f.confidence === 0 ? 'slate' : f.score > 15 ? 'green' : f.score < -15 ? 'red' : 'slate';
      const half = Math.abs(f.score) / 2;
      const seg = f.score >= 0
        ? `left:50%;width:${half}%;background:${TONE_COLOR[tone]}`
        : `right:50%;width:${half}%;background:${TONE_COLOR[tone]}`;

      const details = f.details.length
        ? `<div class="details">${f.details.map((d) => `<span class="detail">${esc(d.label)} <b>${esc(d.value)}</b></span>`).join('')}</div>`
        : '';

      return `
      <div class="factor">
        <div class="factor-head">
          <span class="nm">${esc(f.label)}</span>
          <span class="meta">poids ${f.weight} · confiance ${Math.round(f.confidence * 100)} % · score ${f.score > 0 ? '+' : ''}${num(f.score, 1)}</span>
        </div>
        <div class="scorebar"><span class="zero"></span><span class="seg" style="${seg}"></span></div>
        <p>${esc(f.summary)}</p>
        ${details}
      </div>`;
    })
    .join('');

  return `
  <div class="card">
    <h2>Les facteurs, du plus déterminant au moins déterminant</h2>
    ${factors}
  </div>`;
}

function renderReactions(r) {
  const h = r.history;
  if (!h?.events?.length) return '';

  const max = Math.max(...h.events.map((e) => Math.abs(e.reactionPercent)), 1);
  // Au-delà d'une dizaine de barres la lecture se perd ; les agrégats sous le
  // graphique portent bien sur l'ensemble des publications.
  const rows = h.events
    .slice(0, 10)
    .map((e) => {
      const up = e.reactionPercent >= 0;
      const width = (Math.abs(e.reactionPercent) / max) * 50;
      const seg = up
        ? `left:50%;width:${width}%;background:${TONE_COLOR.green}`
        : `right:50%;width:${width}%;background:${TONE_COLOR.red}`;
      return `
      <div class="barrow">
        <span class="name">${frDate(e.reportedAt)}${isNum(e.surprisePercent) ? ` <span class="mono" style="color:var(--faint)">surprise ${pct(e.surprisePercent, 1)}</span>` : ''}</span>
        <span class="track" style="position:relative"><span class="zero" style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:#243044"></span><span class="fill" style="position:absolute;top:0;height:100%;${seg}"></span></span>
        <span class="val ${up ? 'up' : 'down'}">${pct(e.reactionPercent, 1)}</span>
      </div>`;
    })
    .join('');

  const resolution = {
    filing: `séance de réaction établie sur l'horodatage des ${h.timingFromFilings} dépôts 8-K à la SEC`,
    mixed: `horaire officiel pour ${h.timingFromFilings} publication(s) sur ${h.count}, déduit pour les autres`,
    inferred: 'séance de réaction déduite du schéma de publication de la société',
    hint: "séance de réaction alignée sur l'horaire annoncé pour la prochaine publication",
    default: 'horaire inconnu : publication supposée après clôture',
  }[h.timingResolution];

  return `
  <div class="card">
    <h2>Réaction du titre à ses dernières publications (${h.count} sur ${h.yearsCovered} ans)</h2>
    <div class="bars">${rows}</div>
    <p class="verdict-line" style="margin-top:14px">
      Le titre a monte <strong>${Math.round(h.positiveRate * 100)} %</strong> du temps,
      réaction médiane <strong>${pct(h.medianMove, 1)}</strong>,
      amplitude médiane <strong>${absPct(h.medianAbsMove, 1)}</strong>.
      ${isNum(h.medianRunUp) ? `Parcours median des cinq séances précédant la publication : <strong>${pct(h.medianRunUp, 1)}</strong>.` : ''}
    </p>
    <p class="verdict-line" style="color:var(--faint);font-size:12.5px">${esc(resolution || '')} (${TIMING_LABEL[h.timing] || h.timing}).</p>
  </div>`;
}

function renderNews(r) {
  if (!r.news?.articles?.length) return '';

  const items = r.news.articles
    .map((a) => {
      const color = a.sentiment > 0.12 ? TONE_COLOR.green : a.sentiment < -0.12 ? TONE_COLOR.red : TONE_COLOR.slate;
      const date = a.publishedAt
        ? new Date(a.publishedAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
        : '';
      const terms = a.terms.length ? ` · termes releves : ${esc(a.terms.slice(0, 5).join(', '))}` : '';
      return `
      <li>
        <span class="dot" style="background:${color}"></span>
        <span>
          ${a.link ? `<a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a>` : esc(a.title)}
          <div class="meta">${esc(date)}${a.source ? ` · ${esc(a.source)}` : ''}${terms}</div>
        </span>
      </li>`;
    })
    .join('');

  const c = r.news.counts;
  return `
  <div class="card">
    <h2>Actualités recentes</h2>
    <p class="verdict-line" style="margin-top:-6px">
      ${c.total} titres : <span class="t-green">${c.positive} positifs</span>,
      <span class="t-red">${c.negative} negatifs</span>, ${c.neutral} neutres.
      Tonalité pondérée par fraîcheur : <strong>${num(r.news.overall, 2)}</strong>.
    </p>
    <ul class="list news">${items}</ul>
  </div>`;
}

/**
 * Ce que vaut le barème, mesuré plutôt qu'affirmé.
 *
 * Un score de décision qu'on n'a jamais confronté aux faits est une opinion
 * déguisée en chiffre. Le résultat du backtest est donc affiché dans la page,
 * y compris -- surtout -- quand il est défavorable.
 */
function renderCalibration(r) {
  const c = r.config?.calibration;
  if (!c) return '';

  return `
  <div class="card">
    <h2>Ce que ce score sait faire, et ce qu'il ne sait pas faire</h2>
    <p class="verdict-line">${esc(c.note)}</p>
    <div class="stats" style="margin-top:14px">
      <div class="stat"><div class="k">Publications rejouées</div><div class="v">${num(c.observations, 0)}</div><div class="n">${c.tickers} sociétés · ${c.years} ans</div></div>
      <div class="stat"><div class="k">Corrélation score / réaction</div><div class="v">${num(c.spearman, 3)}</div><div class="n">Spearman · t = ${num(c.tStat, 2)}</div></div>
      <div class="stat"><div class="k">Taux de hausse de référence</div><div class="v">${num(c.baselinePositiveRate * 100, 1)} %</div><div class="n">toutes publications confondues</div></div>
      <div class="stat"><div class="k">Position tenue jusqu'aux résultats</div><div class="v">${pct(c.baselineMeanHold, 2)}</div><div class="n">en moyenne, soit la dérive du marché</div></div>
      <div class="stat"><div class="k">Part du barème testée</div><div class="v">${c.testedWeight} / 100</div><div class="n">le reste n'a pas d'historique gratuit</div></div>
      <div class="stat"><div class="k">Dernière calibration</div><div class="v" style="font-size:15px">${esc(c.date)}</div><div class="n">npm run backtest</div></div>
    </div>
  </div>`;
}

/** Journal intégral des appels : l'utilisateur doit pouvoir auditer la collecte. */
function renderSources(r) {
  const rows = r.sources
    .map((s) => `
      <tr>
        <td style="color:${s.ok ? TONE_COLOR.green : TONE_COLOR.red}">${s.ok ? 'OK' : 'ECHEC'}</td>
        <td>${esc(s.label)}${s.url ? `<div class="u">${esc(s.url)}</div>` : ''}${s.detail ? `<div class="u">${esc(s.detail)}</div>` : ''}</td>
        <td class="num">${s.status ?? '—'}</td>
        <td class="num">${s.ms} ms</td>
        <td class="num">${s.cached ? 'cache' : s.bytes ? `${(s.bytes / 1024).toFixed(1)} ko` : ''}</td>
      </tr>`)
    .join('');

  const failed = r.sources.filter((s) => !s.ok).length;

  return `
  <div class="card">
    <details class="sources">
      <summary>Sources scrapées — ${r.sources.length} appels, ${failed} en échec, ${(r.elapsedMs / 1000).toFixed(1)} s</summary>
      <table class="srctable">${rows}</table>
    </details>
  </div>`;
}

/* ---------------- calendrier des publications ---------------- */

const calendarBody = document.getElementById('calendar-body');
const calendarStatus = document.getElementById('calendar-status');

const TIMING_SHORT = {
  'after-close': 'après clôture',
  'before-open': 'avant ouverture',
  unknown: 'horaire non communiqué',
};

const jourLong = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });

/**
 * Liste les publications à venir. C'est l'entrée naturelle dans l'outil :
 * la question de départ n'est pas « que vaut telle action » mais « qui publie
 * cette semaine, et lequel de ces dossiers mérite qu'on s'y arrête ».
 */
async function loadCalendar() {
  try {
    const response = await fetch('/api/calendar?days=5');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Erreur ${response.status}`);
    if (!data.days?.length) {
      calendarStatus.textContent = "Aucune publication annoncée sur les prochains jours ouvrés.";
      return;
    }

    const aujourdhui = new Date().toISOString().slice(0, 10);

    calendarStatus.innerHTML =
      `<strong>${data.retained}</strong> sociétés de plus de ${num(data.minCap / 1e9, 0)} Md$ publient ` +
      `d'ici le ${frDate(data.to)}. Cliquez pour analyser.`;

    calendarBody.innerHTML = data.days
      .map((jour) => `
        <div class="cal-day">
          <div class="cal-date">
            ${esc(jourLong(jour.date))}
            ${jour.date === aujourdhui ? '<span class="today">aujourd\'hui</span>' : ''}
          </div>
          <div class="cal-list">
            ${jour.companies.slice(0, 12).map((c) => `
              <button class="cal-item" type="button" data-ticker="${esc(c.symbol)}">
                <span class="cap">${compact(c.marketCap)}</span>
                <span class="sym">${esc(c.symbol)}</span>
                <div class="co">${esc(c.name || '')}</div>
                <div class="when">
                  ${esc(TIMING_SHORT[c.timing] || '')}${isNum(c.consensusEps) ? ` · BPA attendu <b>${num(c.consensusEps)}</b>` : ''}
                </div>
              </button>`).join('')}
          </div>
          ${jour.companies.length > 12 ? `<div class="cal-more">+ ${jour.companies.length - 12} autres ce jour-là</div>` : ''}
        </div>`)
      .join('');

    for (const item of calendarBody.querySelectorAll('.cal-item')) {
      item.addEventListener('click', () => {
        input.value = item.dataset.ticker;
        analyze(item.dataset.ticker);
        document.getElementById('status').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  } catch (error) {
    calendarStatus.textContent = `Calendrier indisponible : ${error.message}`;
  }
}

/* ---------------- événements ---------------- */

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const ticker = input.value.trim().toUpperCase();
  if (ticker) analyze(ticker);
});

const initial = new URLSearchParams(location.search).get('ticker');
if (initial) {
  input.value = initial.toUpperCase();
  analyze(initial.toUpperCase());
}

loadCalendar();
