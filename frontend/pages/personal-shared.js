// Nóminas y SS — componente compartido entre timbol.html y comarea.html,
// mismo patrón que banco-shared.js: script clásico apoyado en los globals
// de cada página (apiFetch, esc, eur, pad, MESES) y en los estilos que ya
// inyectó banco-shared.js (.banco-preview-table, .banco-btn-secundario,
// .banco-confirmar-bar) — solo se añade lo que falta para las columnas
// propias de esta tabla (tipo/periodo/empleado).
(function injectPersonalStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .banco-preview-table select { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 5px 7px; color: var(--text); font-size: 12px; box-sizing: border-box; }
    .personal-revision { background: rgba(217,164,65,.12); }
    .personal-fila-error { font-size: 10.5px; color: var(--alert); margin-top: 2px; }
    .personal-mov-row { padding: 10px 0; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .personal-mov-row:first-child { border-top: none; }
    .personal-mov-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .personal-mov-meta a { color: var(--accent); margin-left: 6px; }
  `;
  document.head.appendChild(style);
})();

let personalEmpleados = [];
let personalPreviewState = null;

// ── Empleados (para el desplegable de asignación) ─────────────────────────
async function cargarEmpleadosPersonal() {
  try {
    const r = await apiFetch('/fichaje/empleados');
    const d = await r.json();
    if (r.ok) personalEmpleados = d;
  } catch (e) {
    console.error('[personal] no se pudo cargar empleados:', e.message);
  }
}

function opcionesEmpleadoPersonal(seleccionadoId) {
  const sinAsignar = `<option value="" ${!seleccionadoId ? 'selected' : ''}>(sin asignar)</option>`;
  return sinAsignar + personalEmpleados.map(e =>
    `<option value="${e.id}" ${Number(seleccionadoId) === e.id ? 'selected' : ''}>${esc(e.nombre)}</option>`
  ).join('');
}

// ── Mes seleccionado (listado + resumen) ──────────────────────────────────
function buildPersonalMesSelect() {
  const sel = document.getElementById('personal-mes-select');
  if (sel.options.length) return;
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const opt = document.createElement('option');
    opt.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    opt.textContent = `${MESES[d.getMonth()]} ${d.getFullYear()}`;
    sel.appendChild(opt);
  }
}

function personalMesSeleccionado() {
  return document.getElementById('personal-mes-select').value || mesActualStr();
}

// ── Resumen del mes ────────────────────────────────────────────────────────
async function refreshResumenPersonal() {
  const cont = document.getElementById('personal-resumen-block');
  if (!cont) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const r = await apiFetch(`/analytics/personal-mes?mes=${personalMesSeleccionado()}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo cargar el resumen');
    cont.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-label">Nóminas</div><div class="kpi-value">${eur(d.nominas.total)}</div></div>
        <div class="kpi-card"><div class="kpi-label">Seguridad Social</div><div class="kpi-value">${eur(d.seguridad_social.total)}</div></div>
        <div class="kpi-card"><div class="kpi-label">Horas extra</div><div class="kpi-value">${eur(d.horas_extra.total)}</div></div>
        <div class="kpi-card"><div class="kpi-label">Total personal</div><div class="kpi-value kpi-accent">${eur(d.total_coste_personal)}</div></div>
      </div>
    `;
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ── Listado ──────────────────────────────────────────────────────────────
async function refreshListadoPersonal() {
  const cont = document.getElementById('personal-listado');
  if (!cont) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const r = await apiFetch(`/personal/gastos?mes=${personalMesSeleccionado()}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo cargar el listado');
    const total = d.reduce((s, g) => s + Number(g.importe), 0);
    document.getElementById('personal-total-mes').textContent = `Total: ${eur(total)}`;
    cont.innerHTML = d.length
      ? `<div class="card">${d.map(renderGastoPersonalRow).join('')}</div>`
      : '<div class="empty">Sin gastos de personal este mes</div>';
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderGastoPersonalRow(g) {
  const tipoLabel = g.tipo === 'nomina' ? 'Nómina' : 'Seguridad Social';
  const quien = g.empleado_nombre || (g.tipo === 'nomina' ? '(sin asignar)' : 'Agregado');
  return `
    <div class="personal-mov-row">
      <div>
        <div class="banco-mov-concepto">${esc(quien)} — ${tipoLabel}</div>
        <div class="personal-mov-meta">${esc(g.periodo.slice(0, 7))} · ${g.origen}${g.drive_file_id ? '' : ' · sin documento'}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div class="banco-mov-importe">${eur(g.importe)}</div>
        <button class="fi-delete" onclick="borrarPersonalUI(${g.id})" title="Eliminar">🗑</button>
      </div>
    </div>
  `;
}

async function borrarPersonalUI(id) {
  if (!confirm('¿Eliminar este gasto de personal? También se borra su documento de Drive si lo tiene.')) return;
  try {
    const r = await apiFetch(`/personal/gastos/${id}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo eliminar');
    await refreshListadoPersonal();
    refreshResumenPersonal();
  } catch (e) {
    alert(e.message);
  }
}

// ── Subida: importar → vista previa editable → confirmar ──────────────────
async function subirArchivosPersonal(files) {
  if (!files || !files.length) return;
  const status = document.getElementById('personal-upload-status');
  status.classList.remove('hidden');
  status.textContent = `Analizando ${files.length} documento(s)…`;
  try {
    const fd = new FormData();
    for (const f of files) fd.append('archivos', f);
    const r = await apiFetch('/personal/gastos/importar', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo procesar la subida');
    status.classList.add('hidden');
    renderPreviewPersonal(d.items);
  } catch (e) {
    status.classList.add('hidden');
    alert(e.message);
  }
}

function renderPreviewPersonal(items) {
  personalPreviewState = items;
  document.getElementById('personal-preview').innerHTML = `
    <table class="banco-preview-table">
      <thead><tr><th>Archivo</th><th>Tipo</th><th>Periodo</th><th>Empleado</th><th class="num">Importe</th><th></th></tr></thead>
      <tbody id="personal-preview-body">${items.map((it, j) => renderFilaPreviewPersonal(j, it)).join('')}</tbody>
    </table>
    <div class="banco-confirmar-bar">
      <button class="btn-drive" id="btn-confirmar-personal">Guardar</button>
      <button class="banco-btn-secundario" id="btn-cancelar-personal">Cancelar</button>
    </div>
  `;
  document.getElementById('personal-preview').classList.remove('hidden');
  document.getElementById('personal-upload-box').classList.add('hidden');
  document.getElementById('btn-confirmar-personal').addEventListener('click', confirmarPersonalUI);
  document.getElementById('btn-cancelar-personal').addEventListener('click', cancelarPreviewPersonal);
}

function renderFilaPreviewPersonal(j, it) {
  const claseFila = it.requiere_revision ? 'personal-revision' : '';
  const mesInput = it.periodo ? it.periodo.slice(0, 7) : '';
  return `<tr class="${claseFila}">
    <td>${esc(it.archivo_nombre || '')}${it.error ? `<div class="personal-fila-error">${esc(it.error)}</div>` : ''}</td>
    <td>
      <select onchange="actualizarPreviewPersonal(${j},'tipo',this.value)">
        <option value="nomina" ${it.tipo === 'nomina' ? 'selected' : ''}>Nómina</option>
        <option value="seguridad_social" ${it.tipo === 'seguridad_social' ? 'selected' : ''}>Seguridad Social</option>
      </select>
    </td>
    <td><input type="month" value="${mesInput}" oninput="actualizarPreviewPersonal(${j},'periodo',this.value)"></td>
    <td><select onchange="actualizarPreviewPersonal(${j},'empleado_id',this.value)">${opcionesEmpleadoPersonal(it.empleado_id)}</select></td>
    <td class="num"><input type="number" step="0.01" value="${it.importe ?? ''}" oninput="actualizarPreviewPersonal(${j},'importe',this.value)"></td>
    <td><button class="fi-delete" onclick="eliminarFilaPreviewPersonal(${j})" title="Quitar">🗑</button></td>
  </tr>`;
}

function actualizarPreviewPersonal(j, campo, valor) {
  const it = personalPreviewState[j];
  if (campo === 'periodo') it.periodo = valor ? `${valor}-01` : null;
  else if (campo === 'empleado_id') it.empleado_id = valor ? Number(valor) : null;
  else if (campo === 'importe') it.importe = valor === '' ? null : Number(valor);
  else it[campo] = valor;
}

function eliminarFilaPreviewPersonal(j) {
  personalPreviewState.splice(j, 1);
  document.getElementById('personal-preview-body').innerHTML = personalPreviewState.map((it, k) => renderFilaPreviewPersonal(k, it)).join('');
}

async function confirmarPersonalUI() {
  const items = personalPreviewState;
  if (!items.length) { alert('No queda ningún documento por guardar'); return; }
  for (const it of items) {
    if (!['nomina', 'seguridad_social'].includes(it.tipo) || !it.periodo || it.importe == null) {
      alert('Cada fila necesita tipo, periodo e importe');
      return;
    }
  }
  const sinAsignar = items.filter(it => it.tipo === 'nomina' && !it.empleado_id).length;
  if (sinAsignar && !confirm(`${sinAsignar} nómina(s) sin empleado asignado — ¿guardar igualmente?`)) return;

  const btn = document.getElementById('btn-confirmar-personal');
  btn.disabled = true;
  try {
    const r = await apiFetch('/personal/gastos/confirmar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo guardar');
    alert(`Guardado: ${d.guardados} gasto(s)${d.errores.length ? `, ${d.errores.length} con error (revisa e inténtalo de nuevo)` : ''}.`);
    cancelarPreviewPersonal();
    refreshResumenPersonal();
    refreshListadoPersonal();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

function cancelarPreviewPersonal() {
  personalPreviewState = null;
  document.getElementById('personal-preview').classList.add('hidden');
  document.getElementById('personal-preview').innerHTML = '';
  document.getElementById('personal-upload-box').classList.remove('hidden');
  document.getElementById('personal-archivo-input').value = '';
}

// ── Alta manual (sin documento) ────────────────────────────────────────────
function toggleAltaManualPersonal() {
  const cont = document.getElementById('personal-manual-form');
  if (!cont.classList.contains('hidden')) { cont.classList.add('hidden'); cont.innerHTML = ''; return; }
  cont.innerHTML = `
    <p class="section-title" style="margin-top:0">Alta manual</p>
    <div class="field"><label>Tipo</label>
      <select id="pm-tipo"><option value="nomina">Nómina</option><option value="seguridad_social">Seguridad Social</option></select>
    </div>
    <div class="field"><label>Periodo</label><input type="month" id="pm-periodo" value="${mesActualStr()}"></div>
    <div class="field"><label>Empleado</label><select id="pm-empleado">${opcionesEmpleadoPersonal(null)}</select></div>
    <div class="field"><label>Importe</label><input type="number" step="0.01" id="pm-importe"></div>
    <div class="form-actions">
      <button class="btn-drive" id="btn-guardar-manual-personal">Guardar</button>
      <button class="banco-btn-secundario" onclick="toggleAltaManualPersonal()">Cancelar</button>
    </div>
  `;
  cont.classList.remove('hidden');
  document.getElementById('btn-guardar-manual-personal').addEventListener('click', guardarAltaManualPersonal);
}

async function guardarAltaManualPersonal() {
  const tipo = document.getElementById('pm-tipo').value;
  const periodo = document.getElementById('pm-periodo').value;
  const empleado_id = document.getElementById('pm-empleado').value || null;
  const importe = document.getElementById('pm-importe').value;
  if (!periodo || !importe) { alert('Periodo e importe son obligatorios'); return; }
  try {
    const r = await apiFetch('/personal/gastos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo, periodo, empleado_id: empleado_id ? Number(empleado_id) : null, importe: Number(importe) }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo guardar');
    toggleAltaManualPersonal();
    refreshResumenPersonal();
    refreshListadoPersonal();
  } catch (e) {
    alert(e.message);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────
async function refreshPersonalTab() {
  cancelarPreviewPersonal();
  buildPersonalMesSelect();
  document.getElementById('personal-mes-select').value = mesActualStr();
  await cargarEmpleadosPersonal();
  refreshResumenPersonal();
  refreshListadoPersonal();
}

function initPersonalTab() {
  const input = document.getElementById('personal-archivo-input');
  if (!input) return; // esta página no tiene pestaña de personal
  document.getElementById('btn-subir-personal').addEventListener('click', () => input.click());
  input.addEventListener('change', () => subirArchivosPersonal(input.files));
  document.getElementById('btn-alta-manual-personal').addEventListener('click', toggleAltaManualPersonal);
  document.getElementById('personal-mes-select').addEventListener('change', () => { refreshResumenPersonal(); refreshListadoPersonal(); });
}
document.addEventListener('DOMContentLoaded', initPersonalTab);
