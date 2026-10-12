// Leads — componente compartido entre leads.html (panel de agencia),
// leads-cliente.html (panel de un cliente) y leads-clientes.html (subcuentas).
// Script clásico (no módulo), cargado en el <head> justo después de
// supabase-js: inyecta los estilos (mismo sistema que Campañas) y define los
// helpers globales (sesión, api, fechas Madrid, selector de periodo, gráficas).

// ── Estilos ──────────────────────────────────────────────────────────────
(function injectLeadsStyles() {
  const style = document.createElement('style');
  style.textContent = `
    :root {
      --negro: #0F0E0C;
      --arena: #C4A882;
      --blanco: #F5F0E8;
      --negro-soft: #1a1916;
      --arena-dim: rgba(196,168,130,0.18);
      --rojo: #d9684f;
      --ambar: #d9a441;
      --verde: #7fa86b;
      --azul: #5b8fd9;
      --border: rgba(196,168,130,0.22);
      --text-muted: rgba(245,240,232,0.5);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-size: 14px; }
    body { font-family: 'Inter', sans-serif; background: var(--negro); color: var(--blanco); min-height: 100vh; }
    a { color: inherit; }

    header {
      position: sticky; top: 0; z-index: 100;
      background: var(--negro-soft); border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 16px; padding: 0 24px; height: 56px;
    }
    .logo { font-weight: 700; font-size: 15px; color: var(--arena); letter-spacing: .04em; }
    .logo span { color: var(--blanco); }
    header .spacer { flex: 1; }
    .user-email { font-size: 12px; color: var(--text-muted); }
    header button {
      background: var(--arena-dim); border: 1px solid var(--border); color: var(--blanco);
      padding: 6px 14px; border-radius: 6px; font-size: 12px; cursor: pointer; font-family: inherit;
    }
    header button:hover { background: rgba(196,168,130,0.3); }

    .controls {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 16px 24px; border-bottom: 1px solid var(--border); background: var(--negro-soft);
    }
    .controls label { font-size: 12px; color: var(--text-muted); }
    .controls select, .controls input[type=date], .input {
      background: var(--negro); border: 1px solid var(--border); color: var(--blanco);
      padding: 6px 10px; border-radius: 6px; font-family: inherit; font-size: 13px; cursor: pointer; color-scheme: dark;
    }
    .controls .spacer { flex: 1; }
    .btn {
      background: var(--arena-dim); border: 1px solid var(--border); color: var(--blanco);
      padding: 7px 16px; border-radius: 6px; font-size: 13px; font-family: inherit; cursor: pointer;
      display: inline-flex; align-items: center; gap: 6px; text-decoration: none;
    }
    .btn:hover { background: rgba(196,168,130,0.3); }
    .btn.accent { background: var(--arena); color: var(--negro); border-color: transparent; font-weight: 600; }
    .btn.accent:hover { background: #d4b898; }
    .btn:disabled { opacity: .4; cursor: not-allowed; }
    .btn.sm { font-size: 11px; padding: 4px 10px; }

    .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .seg button {
      background: transparent; border: none; border-right: 1px solid var(--border);
      color: var(--text-muted); padding: 6px 12px; font-family: inherit; font-size: 12px; cursor: pointer;
    }
    .seg button:last-child { border-right: none; }
    .seg button:hover { color: var(--blanco); }
    .seg button.on { background: var(--arena-dim); color: var(--arena); font-weight: 600; }

    main { padding: 24px; max-width: 1200px; }

    .page-title { margin-bottom: 20px; }
    .page-title h1 { font-size: 20px; font-weight: 700; color: var(--arena); }
    .page-title .sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .kpi-card { background: var(--negro-soft); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
    .kpi-card .kpi-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
    .kpi-card .kpi-value { font-size: 24px; font-weight: 700; color: var(--arena); }
    .kpi-card .kpi-sub { font-size: 11px; color: var(--text-muted); margin-top: 4px; line-height: 1.5; }
    .up { color: var(--verde); }
    .down { color: var(--rojo); }

    .chart-box { background: var(--negro-soft); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 24px; }
    .chart-box h3 { font-size: 13px; font-weight: 600; margin-bottom: 12px; color: var(--blanco); }
    .chart-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    .chart-head h3 { margin-bottom: 0; }
    .chart-box svg { width: 100%; display: block; }
    .chart-legend { display: flex; gap: 16px; margin-top: 8px; font-size: 11px; flex-wrap: wrap; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 4px; }
    .nota { font-size: 11px; color: var(--text-muted); margin-top: 10px; line-height: 1.5; }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
    .grid-2 > * { margin-bottom: 0; }
    @media (max-width: 800px) { .grid-2 { grid-template-columns: 1fr; } }

    .donut-wrap { display: flex; align-items: center; gap: 20px; }
    .donut-wrap svg { width: 160px; height: 160px; flex: none; }
    .donut-list { font-size: 12px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
    .donut-list div { display: flex; justify-content: space-between; gap: 8px; }

    .table-box { background: var(--negro-soft); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 24px; }
    .table-box h3 { font-size: 13px; font-weight: 600; padding: 14px 16px; border-bottom: 1px solid var(--border); }
    .table-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 16px; border-bottom: 1px solid var(--border); }
    .table-head h3 { padding: 0; border: none; margin-right: auto; }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { padding: 10px 12px; text-align: right; font-weight: 500; color: var(--text-muted); white-space: nowrap; border-bottom: 1px solid var(--border); }
    th:first-child { text-align: left; }
    td { padding: 9px 12px; text-align: right; border-bottom: 1px solid rgba(196,168,130,0.08); white-space: nowrap; }
    td:first-child { text-align: left; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--arena-dim); }
    td.left, th.left { text-align: left; }
    tr.totales td { font-weight: 700; color: var(--arena); border-top: 1px solid var(--border); }
    tr.link { cursor: pointer; }
    tr.link td:first-child { color: var(--arena); }
    .trend { font-size: 10px; margin-left: 3px; }
    .chip { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; background: var(--arena-dim); }
    .pager { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 10px 16px; font-size: 12px; color: var(--text-muted); border-top: 1px solid var(--border); }
    .bar-inline { display: inline-block; height: 6px; border-radius: 3px; background: var(--arena); vertical-align: middle; margin-right: 8px; }

    .heat { display: grid; grid-template-columns: 44px repeat(24, 1fr) 52px; gap: 2px; font-size: 10px; }
    .heat .h-lbl { color: var(--text-muted); display: flex; align-items: center; }
    .heat .h-col { color: var(--text-muted); text-align: center; }
    .heat .h-cell { aspect-ratio: 1; border-radius: 3px; display: flex; align-items: center; justify-content: center; color: var(--negro); font-weight: 600; min-height: 18px; }
    .heat .h-tot { color: var(--arena); font-weight: 600; display: flex; align-items: center; justify-content: flex-end; }
    .franjas { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
    .franja { flex: 1; min-width: 110px; background: var(--negro); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
    .franja .f-lbl { font-size: 11px; color: var(--text-muted); }
    .franja .f-val { font-size: 18px; font-weight: 700; color: var(--arena); }

    .sync-box { background: var(--negro-soft); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 24px; font-size: 13px; line-height: 1.6; }
    .sync-box.error { border-color: rgba(217,104,79,0.5); }

    details { margin-bottom: 24px; }
    details summary {
      cursor: pointer; font-size: 13px; font-weight: 600; padding: 12px 16px; background: var(--negro-soft);
      border: 1px solid var(--border); border-radius: 10px; list-style: none; display: flex; align-items: center; gap: 8px;
    }
    details summary::before { content: '▸'; color: var(--arena); }
    details[open] summary::before { content: '▾'; }
    details .details-body { padding: 16px 0 0; }

    .empty { color: var(--text-muted); font-size: 13px; padding: 32px; text-align: center; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--arena); border-radius: 50%; animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .hidden { display: none !important; }
  `;
  document.head.appendChild(style);
})();

// ── Sesión y API ─────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://eqruoeoiqvlnlzidqxqr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVxcnVvZW9pcXZsbmx6aWRxeHFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NTY4MDcsImV4cCI6MjA5NzQzMjgwN30.QYMAUUrARJ9i_F8tb4gyGBkJAL66m7izlqgE2gZyz5k';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let accessToken = null;
let currentUser = null;
let role = 'gestor';

// Sesión + rol (misma fuente que la home). Muestra los .admin-only si es admin.
async function iniciarSesion() {
  const { data } = await sb.auth.getSession();
  if (!data.session) { window.location.href = '/'; return null; }
  currentUser = data.session.user;
  accessToken = data.session.access_token;
  const el = document.getElementById('userEmail');
  if (el) el.textContent = currentUser.email;
  const { data: prof } = await sb.from('profiles').select('role').eq('id', currentUser.id).maybeSingle();
  role = (prof?.role || currentUser.app_metadata?.role || currentUser.user_metadata?.role || 'gestor').toLowerCase();
  document.querySelectorAll('.admin-only').forEach(e => e.classList.toggle('hidden', role !== 'admin'));
  return currentUser;
}

async function signOut() {
  await sb.auth.signOut();
  window.location.href = '/';
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

const qs = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== '' && v != null)).toString();

// ── Formato ──────────────────────────────────────────────────────────────
const CANALES = ['meta', 'google', 'organico', 'directo', 'manual', 'otro'];
const CANAL_LABEL = { meta: 'Meta', google: 'Google', organico: 'Orgánico', directo: 'Directo / sin origen', manual: 'Manual', otro: 'Otro' };
const CANAL_COLOR = { meta: '#5b8fd9', google: '#d9a441', organico: '#7fa86b', directo: '#8a8175', manual: '#C4A882', otro: 'rgba(245,240,232,0.3)' };
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIAS_SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function fmtInt(n) { return new Intl.NumberFormat('es-ES').format(Math.round(n || 0)); }
function eur(n) { return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n || 0); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function varHtml(pct, sufijo = '', invertir = false) {
  if (pct == null) return `<span>—</span> ${sufijo}`;
  const bueno = invertir ? pct < 0 : pct > 0;
  const cls = pct === 0 ? '' : bueno ? 'up' : 'down';
  const flecha = pct > 0 ? '▲' : pct < 0 ? '▼' : '';
  return `<span class="${cls}">${flecha} ${pct > 0 ? '+' : ''}${pct.toLocaleString('es-ES')}%</span> ${sufijo}`;
}

// ── Fechas (siempre Europe/Madrid, como YYYY-MM-DD) ─────────────────────
const hoyISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function addMonths(iso, n) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
}
const inicioMes = iso => iso.slice(0, 8) + '01';
const finMes = iso => addDays(addMonths(inicioMes(iso), 1), -1);
function fmtDia(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
function fmtMes(ym) { const [y, m] = ym.split('-'); return `${MESES_CORTOS[Number(m) - 1]} ${y.slice(2)}`; }
function fmtFechaHora(ts) {
  return ts ? new Date(ts).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Nunca';
}

// ── Selector de periodo (atajos + desde/hasta) y granularidad ────────────
// Espera en la página: #atajos (botones data-atajo), #desde, #hasta y,
// opcional, #granularidad (botones data-g).
const periodo = { granularidad: 'dia' };

function montarPeriodo({ onPeriodo, onGranularidad, inicial = 'mes' }) {
  const marcar = atajo => document.querySelectorAll('#atajos button').forEach(b => b.classList.toggle('on', b.dataset.atajo === atajo));
  const aplicar = atajo => {
    const hoy = hoyISO();
    const rangos = {
      hoy: [hoy, hoy],
      '7d': [addDays(hoy, -6), hoy],
      mes: [inicioMes(hoy), hoy],
      mesant: [addMonths(inicioMes(hoy), -1), finMes(addMonths(inicioMes(hoy), -1))],
      '12m': [addMonths(inicioMes(hoy), -11), hoy],
    };
    const [d, h] = rangos[atajo];
    document.getElementById('desde').value = d;
    document.getElementById('hasta').value = h;
    marcar(atajo);
    setGranularidad(atajo === '12m' ? 'mes' : 'dia', false);
  };
  const setGranularidad = (g, avisar = true) => {
    periodo.granularidad = g;
    document.querySelectorAll('#granularidad button').forEach(b => b.classList.toggle('on', b.dataset.g === g));
    if (avisar && onGranularidad) onGranularidad(g);
  };
  document.querySelectorAll('#atajos button').forEach(b => b.addEventListener('click', () => { aplicar(b.dataset.atajo); onPeriodo(); }));
  ['desde', 'hasta'].forEach(id => document.getElementById(id).addEventListener('change', () => { marcar(null); onPeriodo(); }));
  document.querySelectorAll('#granularidad button').forEach(b => b.addEventListener('click', () => setGranularidad(b.dataset.g)));
  aplicar(inicial);
}

const rangoActual = () => ({ desde: document.getElementById('desde').value, hasta: document.getElementById('hasta').value });

// ── KPIs (respuesta de /api/leads/resumen) ───────────────────────────────
function renderKpis(r) {
  document.getElementById('kpiHoy').textContent = fmtInt(r.hoy);
  document.getElementById('kpiHoySub').textContent = fmtDia(r.fecha);
  document.getElementById('kpiSemana').textContent = fmtInt(r.semana);
  document.getElementById('kpiMes').textContent = fmtInt(r.mes);
  document.getElementById('kpiMesSub').innerHTML =
    `${varHtml(r.variacion_pct, 'vs mes anterior')}<br>${varHtml(r.variacion_mismo_dia_pct, 'vs mismo día del mes anterior')}`;
  document.getElementById('kpiMesAnt').textContent = fmtInt(r.mes_anterior);
  document.getElementById('kpiMesAntSub').innerHTML =
    `Mismo mes año anterior: ${fmtInt(r.mismo_mes_anio_anterior)}<br>${varHtml(r.variacion_anual_pct, 'este mes vs año anterior')}`;
}

const KPIS_HTML = `
  <div class="kpi-card"><div class="kpi-label">Hoy</div><div class="kpi-value" id="kpiHoy">—</div><div class="kpi-sub" id="kpiHoySub"></div></div>
  <div class="kpi-card"><div class="kpi-label">Esta semana</div><div class="kpi-value" id="kpiSemana">—</div><div class="kpi-sub">Desde el lunes</div></div>
  <div class="kpi-card"><div class="kpi-label">Este mes</div><div class="kpi-value" id="kpiMes">—</div><div class="kpi-sub" id="kpiMesSub"></div></div>
  <div class="kpi-card"><div class="kpi-label">Mes anterior</div><div class="kpi-value" id="kpiMesAnt">—</div><div class="kpi-sub" id="kpiMesAntSub"></div></div>`;

// ── Gráficas (SVG a mano, como en Campañas) ──────────────────────────────
function etiquetaPeriodo(p, granularidad) {
  if (granularidad === 'mes') return fmtMes(p);
  const [, m, d] = p.split('-');
  return `${d}/${m}`;
}

function svgVacio(svg, texto) {
  const [, , w, h] = svg.getAttribute('viewBox').split(' ').map(Number);
  svg.innerHTML = `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="rgba(245,240,232,0.3)" font-size="13">${esc(texto)}</text>`;
}

// Barras apiladas por canal (respuesta de /api/leads/serie).
function renderBarrasCanal(svgId, serie, granularidad) {
  const svg = document.getElementById(svgId);
  if (!serie || !serie.length || serie.every(s => s.total === 0)) return svgVacio(svg, 'Sin leads en el periodo');
  const W = 800, H = 220, PAD = { top: 16, right: 16, bottom: 32, left: 44 };
  const iW = W - PAD.left - PAD.right, iH = H - PAD.top - PAD.bottom;
  const n = serie.length;
  const max = Math.max(...serie.map(s => s.total), 1);
  const slot = iW / n;
  const barW = Math.max(Math.min(slot * 0.7, 40), 1);
  const y = v => PAD.top + iH - (v / max) * iH;

  const yLabels = [0, 0.5, 1].map(fr => {
    const yy = PAD.top + iH - fr * iH;
    return `<text x="${PAD.left - 6}" y="${yy + 4}" text-anchor="end" fill="rgba(245,240,232,0.35)" font-size="10">${fmtInt(max * fr)}</text>
            <line x1="${PAD.left}" y1="${yy}" x2="${W - PAD.right}" y2="${yy}" stroke="rgba(196,168,130,0.1)" stroke-width="1"/>`;
  }).join('');

  const bars = serie.map((s, i) => {
    const x = PAD.left + i * slot + (slot - barW) / 2;
    let acc = 0;
    const tooltip = `${etiquetaPeriodo(s.periodo, granularidad)} — ${fmtInt(s.total)} leads\n` +
      CANALES.filter(c => s[c]).map(c => `${CANAL_LABEL[c]}: ${fmtInt(s[c])}`).join('\n');
    const rects = CANALES.map(c => {
      const v = s[c] || 0;
      if (!v) return '';
      const y1 = y(acc + v), y0 = y(acc);
      acc += v;
      return `<rect x="${x}" y="${y1}" width="${barW}" height="${Math.max(y0 - y1, 0.5)}" fill="${CANAL_COLOR[c]}"/>`;
    }).join('');
    return `<g><title>${esc(tooltip)}</title>${rects}<rect x="${PAD.left + i * slot}" y="${PAD.top}" width="${slot}" height="${iH}" fill="transparent"/></g>`;
  }).join('');

  const step = Math.ceil(n / 8);
  const xLabels = serie.map((s, i) => (i % step === 0 || i === n - 1)
    ? `<text x="${PAD.left + i * slot + slot / 2}" y="${H - 10}" text-anchor="middle" fill="rgba(245,240,232,0.35)" font-size="10">${etiquetaPeriodo(s.periodo, granularidad)}</text>`
    : '').join('');
  svg.innerHTML = `${yLabels}${bars}${xLabels}`;
}

function leyendaCanales(id) {
  document.getElementById(id).innerHTML = CANALES.map(c =>
    `<span><span class="legend-dot" style="background:${CANAL_COLOR[c]};"></span>${CANAL_LABEL[c]}</span>`).join('');
}

// Donut por canal (por_canal de /api/leads/desglose).
function renderDonut(svgId, listId, porCanal, total) {
  const svg = document.getElementById(svgId);
  const list = document.getElementById(listId);
  const R = 62, C = 80, SW = 22, circ = 2 * Math.PI * R;
  if (!total) {
    svg.innerHTML = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="rgba(196,168,130,0.12)" stroke-width="${SW}"/>
      <text x="${C}" y="${C + 5}" text-anchor="middle" fill="rgba(245,240,232,0.3)" font-size="13">0</text>`;
    list.innerHTML = '<div style="color:var(--text-muted);">Sin leads en el periodo</div>';
    return;
  }
  let offset = 0;
  const arcs = porCanal.filter(c => c.total).map(c => {
    const len = (c.total / total) * circ;
    const arc = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${CANAL_COLOR[c.canal]}" stroke-width="${SW}"
      stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${C} ${C})"><title>${CANAL_LABEL[c.canal]}: ${fmtInt(c.total)}</title></circle>`;
    offset += len;
    return arc;
  }).join('');
  svg.innerHTML = `${arcs}
    <text x="${C}" y="${C + 2}" text-anchor="middle" fill="var(--arena)" font-size="22" font-weight="700">${fmtInt(total)}</text>
    <text x="${C}" y="${C + 18}" text-anchor="middle" fill="rgba(245,240,232,0.45)" font-size="10">leads</text>`;
  list.innerHTML = porCanal.filter(c => c.total).map(c => `<div>
      <span><span class="legend-dot" style="background:${CANAL_COLOR[c.canal]};"></span>${CANAL_LABEL[c.canal]}</span>
      <span>${fmtInt(c.total)} <span style="color:var(--text-muted);">· ${Math.round((c.total / total) * 100)}%</span></span>
    </div>`).join('');
}

// ── Resultado de una sync (respuesta de POST /api/leads/sync) ─────────────
function htmlResultadoSync(r) {
  const errores = r.clientes.filter(c => c.error);
  return {
    error: errores.length > 0 || !!r.error_subcuentas,
    html: `
      <strong>Sincronización terminada</strong> en ${r.segundos}s ·
      ${r.subcuentas_ghl != null ? `${r.subcuentas_ghl} subcuentas en GHL` : 'una subcuenta'}
      ${r.subcuentas_nuevas.length ? ` (${r.subcuentas_nuevas.length} nuevas)` : ''} ·
      <span class="up">${fmtInt(r.leads_nuevos)} nuevos</span> · ${fmtInt(r.leads_actualizados)} actualizados ·
      <span class="${errores.length ? 'down' : ''}">${errores.length} con error</span>
      ${r.sin_token.length ? ` · <span style="color:var(--text-muted);">${r.sin_token.length} sin token (saltadas)</span>` : ''}
      ${r.error_subcuentas ? `<div class="down" style="margin-top:6px;">Listado de subcuentas: ${esc(r.error_subcuentas)}</div>` : ''}
      ${errores.map(c => `<div><span class="down">✕</span> ${esc(c.nombre)}: ${esc(c.error)}</div>`).join('')}`,
  };
}

async function lanzarSync({ boxId = 'syncResult', btnId = 'btnSync', labelId = 'syncLabel', locationId, alTerminar } = {}) {
  const btn = document.getElementById(btnId);
  const box = document.getElementById(boxId);
  btn.disabled = true;
  document.getElementById(labelId).innerHTML = '<span class="spinner"></span> Sincronizando…';
  box.className = 'sync-box';
  box.innerHTML = 'Sincronizando con GoHighLevel. Un backfill de 12 meses puede tardar varios minutos.';
  try {
    const r = await api(`/api/leads/sync${locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''}`, { method: 'POST' });
    const { html, error } = htmlResultadoSync(r);
    box.className = 'sync-box' + (error ? ' error' : '');
    box.innerHTML = html;
    if (alTerminar) alTerminar(r);
  } catch (e) {
    box.className = 'sync-box error';
    box.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
    document.getElementById(labelId).textContent = 'Sincronizar ahora';
  }
}
