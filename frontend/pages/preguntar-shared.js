// "Pregúntale a tu restaurante" — componente compartido entre timbol.html y
// comarea.html, mismo patrón que tarifas-shared.js/ventas-shared.js: script
// clásico (no módulo) que se apoya en los globals ya definidos por cada
// página (apiFetch, esc).

// ── Estilos ──────────────────────────────────────────────────────────────
(function injectPreguntarStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .preguntar-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    .preguntar-chip { background: var(--surface2); border: 1px solid var(--border); border-radius: 20px; padding: 7px 14px; font-size: 12.5px; color: var(--text); cursor: pointer; }
    .preguntar-chip:hover { border-color: var(--accent); color: var(--accent); }
    .preguntar-input-row { display: flex; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
    .preguntar-input-row select { flex: 0 0 140px; }
    .preguntar-input-row input[type="text"] { flex: 1 1 200px; background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; color: var(--text); font-size: 13px; }
    .preguntar-input-row input[type="text"]:focus { outline: none; border-color: var(--accent); }
    .preguntar-respuesta-card { margin-top: 12px; }
    .preguntar-respuesta-texto { white-space: pre-wrap; font-size: 13.5px; line-height: 1.5; }
    .preguntar-respuesta-meta { font-size: 11px; color: var(--muted); margin-top: 8px; }
    .preguntar-historial { margin-top: 10px; }
    .preguntar-historial-item { font-size: 12px; color: var(--muted); padding: 6px 0; border-top: 1px solid var(--border); cursor: pointer; }
    .preguntar-historial-item:hover { color: var(--text); }
  `;
  document.head.appendChild(style);
})();

// Cada chip fija periodo + pregunta — al hacer click se envía directamente,
// sin que el usuario tenga que tocar el selector ni el campo de texto.
const PREGUNTAR_CHIPS = [
  { label: '¿Cómo voy esta semana?', periodo: 'semana', pregunta: '¿Cómo voy esta semana?' },
  { label: '¿Cómo va el mes?', periodo: 'mes', pregunta: '¿Cómo va el mes?' },
  { label: '¿Quién me ha subido precios?', periodo: '30d', pregunta: '¿Quién me ha subido precios?' },
  { label: '¿Dónde estoy pagando de más?', periodo: '30d', pregunta: '¿Dónde estoy pagando de más respecto a mi tarifa pactada?' },
  { label: '¿Qué se vende más?', periodo: 'semana', pregunta: '¿Qué se vende más?' },
  { label: '¿Y comparado con la semana pasada?', periodo: 'semana', pregunta: '¿Cómo voy esta semana comparado con la semana pasada?' },
];

// Últimas 5 preguntas de la sesión — a propósito solo en memoria (variable
// JS), no localStorage: se pierde al recargar, como pide la spec.
let preguntarHistorial = [];

function initPreguntar() {
  const chipsCont = document.getElementById('preguntar-chips');
  if (!chipsCont) return; // esta página no tiene el bloque de Análisis
  chipsCont.innerHTML = PREGUNTAR_CHIPS
    .map((c, i) => `<button type="button" class="preguntar-chip" onclick="usarChipPreguntar(${i})">${esc(c.label)}</button>`)
    .join('');
  document.getElementById('btn-preguntar').addEventListener('click', enviarPregunta);
  document.getElementById('preguntar-texto').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); enviarPregunta(); }
  });
}
document.addEventListener('DOMContentLoaded', initPreguntar);

function usarChipPreguntar(i) {
  const chip = PREGUNTAR_CHIPS[i];
  document.getElementById('preguntar-periodo').value = chip.periodo;
  document.getElementById('preguntar-texto').value = chip.pregunta;
  enviarPregunta();
}

async function enviarPregunta() {
  const textoEl = document.getElementById('preguntar-texto');
  const pregunta = textoEl.value.trim();
  if (!pregunta) return;
  const periodo = document.getElementById('preguntar-periodo').value;
  const respEl = document.getElementById('preguntar-respuesta');
  const btn = document.getElementById('btn-preguntar');
  btn.disabled = true;
  respEl.innerHTML = '<div class="empty">Pensando…</div>';
  try {
    const r = await apiFetch('/analytics/preguntar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pregunta, periodo }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo obtener respuesta');
    renderRespuestaPreguntar(d);
    agregarHistorialPreguntar(pregunta, d);
  } catch (e) {
    respEl.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderRespuestaPreguntar(d) {
  document.getElementById('preguntar-respuesta').innerHTML = `
    <div class="card preguntar-respuesta-card">
      <div class="preguntar-respuesta-texto">${esc(d.respuesta)}</div>
      <div class="preguntar-respuesta-meta">${esc(d.periodo_usado.desde)} a ${esc(d.periodo_usado.hasta)} · ${d.dias_con_datos} de ${d.dias_totales} días con caja</div>
    </div>
  `;
}

function agregarHistorialPreguntar(pregunta, d) {
  preguntarHistorial.unshift({ pregunta, respuesta: d.respuesta, periodo_usado: d.periodo_usado, dias_con_datos: d.dias_con_datos, dias_totales: d.dias_totales });
  preguntarHistorial = preguntarHistorial.slice(0, 5);
  renderHistorialPreguntar();
}

function renderHistorialPreguntar() {
  const cont = document.getElementById('preguntar-historial');
  if (!cont) return;
  if (!preguntarHistorial.length) { cont.innerHTML = ''; return; }
  cont.innerHTML = preguntarHistorial
    .map((h, i) => `<div class="preguntar-historial-item" onclick="verHistorialPreguntar(${i})">${esc(h.pregunta)}</div>`)
    .join('');
}

function verHistorialPreguntar(i) {
  const h = preguntarHistorial[i];
  document.getElementById('preguntar-texto').value = h.pregunta;
  renderRespuestaPreguntar(h);
}
