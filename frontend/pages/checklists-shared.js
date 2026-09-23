// Checklists (pestaña "Checklists", gestor/admin) — componente compartido
// entre timbol.html y comarea.html, mismo patrón que inventario-shared.js/
// banco-shared.js: script clásico, estilos inyectados, apoyado en los
// globals de cada página (apiFetch, esc, eur).

(function injectChecklistsStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .cl-toolbar { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; align-items: center; }
    .cl-toolbar select, .cl-toolbar input[type="date"] { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; color: var(--text); font-size: 13px; }
    .cl-ejec-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 12px 0; border-top: 1px solid var(--border); cursor: pointer; }
    .cl-ejec-row:first-child { border-top: none; }
    .cl-ejec-nombre { font-size: 13.5px; font-weight: 600; }
    .cl-ejec-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .cl-ejec-revisar { color: var(--alert); font-weight: 700; }
    .cl-detalle-tarea { padding: 10px 0; border-top: 1px solid var(--border); }
    .cl-detalle-tarea:first-child { border-top: none; }
    .cl-detalle-titulo { font-size: 13px; font-weight: 600; display: flex; justify-content: space-between; gap: 8px; }
    .cl-detalle-meta { font-size: 11.5px; color: var(--muted); margin-top: 3px; }
    .cl-foto-thumb { display: inline-block; margin-top: 8px; font-size: 12px; color: var(--accent); }
    .cl-ia-badge { display: inline-block; margin-left: 6px; font-size: 10px; border-radius: 6px; padding: 2px 6px; }
    .cl-ia-ok { background: rgba(107,175,122,.15); color: var(--ok); }
    .cl-ia-alerta { background: rgba(217,107,82,.15); color: var(--alert); }
    .cl-validar-btns { margin-top: 8px; display: flex; gap: 6px; }
    .cl-validar-btns button { font-size: 12px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface2); color: var(--text); cursor: pointer; }
    .cl-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; margin-bottom: 8px; }
    .cl-cal-dia { aspect-ratio: 1; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font-size: 12px; }
    .cl-cal-completo { background: rgba(107,175,122,.15); border-color: var(--ok); color: var(--ok); font-weight: 600; }
    .cl-cal-incompleto { background: rgba(217,107,82,.15); border-color: var(--alert); color: var(--alert); }
    .cl-config-section { margin-bottom: 20px; }
    .cl-config-item { padding: 8px 0; border-top: 1px solid var(--border); font-size: 13px; }
    .cl-config-item:first-child { border-top: none; }
    .cl-form-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    .cl-form-row input, .cl-form-row select { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; color: var(--text); font-size: 12.5px; }
    .cl-btn-secundario { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 8px 14px; color: var(--text); font-size: 13px; cursor: pointer; }
  `;
  document.head.appendChild(style);
})();

const CL_DIA_LABEL = { lun: 'Lun', mar: 'Mar', mie: 'Mié', jue: 'Jue', vie: 'Vie', sab: 'Sáb', dom: 'Dom' };
const CL_TURNO_LABEL = { apertura: 'Apertura', tarde: 'Tarde', cierre: 'Cierre', libre: 'Libre' };

let clLocales = [];
let clEjecucionActual = null;
let clMesCalendario = new Date();

// ── Tablero del día ──────────────────────────────────────────────────────
async function refreshChecklistsTab() {
  await cargarLocalesChecklist();
  await refreshTableroChecklists();
  await refreshCalendarioChecklists();
}

async function cargarLocalesChecklist() {
  try {
    const r = await apiFetch('/locales');
    clLocales = await r.json();
  } catch (e) {
    clLocales = [];
  }
  const sel = document.getElementById('cl-filtro-local');
  if (!sel) return;
  if (clLocales.length <= 1) {
    sel.classList.add('hidden');
  } else {
    sel.classList.remove('hidden');
    sel.innerHTML = '<option value="">Todos los locales</option>' + clLocales.map(l => `<option value="${l.id}">${esc(l.nombre)}</option>`).join('');
  }
}

async function refreshTableroChecklists() {
  const cont = document.getElementById('cl-tablero');
  if (!cont) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const fecha = document.getElementById('cl-fecha').value || new Date().toISOString().slice(0, 10);
    const local = document.getElementById('cl-filtro-local')?.value;
    const qs = new URLSearchParams({ fecha });
    if (local) qs.set('local', local);
    const r = await apiFetch(`/checklists/tablero?${qs}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo cargar el tablero');
    if (!d.ejecuciones.length) { cont.innerHTML = '<div class="empty">Sin checklists para ese día</div>'; return; }
    cont.innerHTML = `<div class="card">${d.ejecuciones.map(renderEjecucionRow).join('')}</div>`;
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

const CL_ESTADO_BADGE = { pendiente: 'badge-pend', en_curso: 'badge-pend', completado: 'badge-ok', incompleto: 'badge-alert' };
const CL_ESTADO_LABEL = { pendiente: 'Pendiente', en_curso: 'En curso', completado: 'Completado', incompleto: 'Incompleto' };

function renderEjecucionRow(e) {
  return `
    <div class="cl-ejec-row" onclick="abrirDetalleEjecucion(${e.id})">
      <div>
        <div class="cl-ejec-nombre">${esc(e.checklist_nombre || '')} <span class="badge ${CL_ESTADO_BADGE[e.estado] || ''}">${CL_ESTADO_LABEL[e.estado] || e.estado}</span></div>
        <div class="cl-ejec-meta">
          ${CL_TURNO_LABEL[e.turno] || ''} · ${e.empleado ? esc(e.empleado.nombre) : 'sin empezar'}
          ${e.tareas_revisar ? `· <span class="cl-ejec-revisar">${e.tareas_revisar} por revisar</span>` : ''}
          ${e.avisos_enviados ? `· ${e.avisos_enviados} aviso(s)` : ''}
        </div>
      </div>
    </div>
  `;
}

// ── Detalle de una ejecución ─────────────────────────────────────────────
async function abrirDetalleEjecucion(id) {
  const cont = document.getElementById('cl-detalle');
  cont.classList.remove('hidden');
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  cont.scrollIntoView({ behavior: 'smooth' });
  try {
    const r = await apiFetch(`/checklists/ejecuciones/${id}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo cargar el detalle');
    clEjecucionActual = d;
    renderDetalleEjecucion(d);
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderDetalleEjecucion(d) {
  document.getElementById('cl-detalle').innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <p class="section-title" style="margin:0">Detalle — ${esc(d.ejecucion.fecha)}</p>
        <button class="fi-delete" onclick="cerrarDetalleEjecucion()" title="Cerrar">✕</button>
      </div>
      ${d.tareas.map(renderDetalleTarea).join('')}
    </div>
  `;
}

function renderDetalleTarea(t) {
  const r = t.respuesta;
  const verif = r?.foto_verificacion;
  let iaBadge = '';
  if (verif) {
    const ok = verif.coincide !== false;
    iaBadge = `<span class="cl-ia-badge ${ok ? 'cl-ia-ok' : 'cl-ia-alerta'}">${ok ? 'IA: coincide' : 'IA: revisar'}${verif.confianza ? ' · ' + esc(verif.confianza) : ''}</span>`;
  }
  const fotoLink = r?.foto_drive_id ? `<a class="cl-foto-thumb" href="https://drive.google.com/file/d/${esc(r.foto_drive_id)}/view" target="_blank">Ver foto</a>` : '';
  const necesitaValidar = verif && (verif.coincide === false || verif.confianza === 'baja') && !verif.validado_manualmente;

  return `
    <div class="cl-detalle-tarea">
      <div class="cl-detalle-titulo">
        <span>${r?.hecho ? '✓' : '○'} ${esc(t.titulo)}</span>
        ${r?.valor != null ? `<span>${r.valor}${t.valor_etiqueta ? ' ' + esc(t.valor_etiqueta) : ''}${r.fuera_rango ? ' ⚠' : ''}</span>` : ''}
      </div>
      <div class="cl-detalle-meta">
        ${r?.respondido_at ? new Date(r.respondido_at).toLocaleString('es-ES') : 'Sin responder'}
        ${iaBadge}
      </div>
      ${fotoLink}
      ${verif?.motivo ? `<div class="cl-detalle-meta">${esc(verif.motivo)}</div>` : ''}
      ${necesitaValidar ? `<div class="cl-validar-btns">
        <button onclick="validarFotoManual(${r.id}, true)">Confirmar OK</button>
        <button onclick="validarFotoManual(${r.id}, false)">Rechazar</button>
      </div>` : ''}
    </div>
  `;
}

function cerrarDetalleEjecucion() {
  clEjecucionActual = null;
  const cont = document.getElementById('cl-detalle');
  cont.classList.add('hidden');
  cont.innerHTML = '';
}

async function validarFotoManual(respuestaId, coincide) {
  try {
    const r = await apiFetch(`/respuestas/${respuestaId}/validar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coincide, motivo: coincide ? 'Confirmado a mano' : 'Rechazado a mano' }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo validar');
    if (clEjecucionActual) await abrirDetalleEjecucion(clEjecucionActual.ejecucion.id);
  } catch (e) {
    alert(e.message);
  }
}

// ── Calendario mensual ───────────────────────────────────────────────────
async function refreshCalendarioChecklists() {
  const cont = document.getElementById('cl-calendario');
  if (!cont) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const mes = `${clMesCalendario.getFullYear()}-${String(clMesCalendario.getMonth() + 1).padStart(2, '0')}`;
    const local = document.getElementById('cl-filtro-local')?.value;
    const qs = new URLSearchParams({ mes });
    if (local) qs.set('local', local);
    const r = await apiFetch(`/checklists/calendario?${qs}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo cargar el calendario');
    const porDia = new Map(d.dias.map(x => [x.fecha, x]));
    const numDias = new Date(clMesCalendario.getFullYear(), clMesCalendario.getMonth() + 1, 0).getDate();
    const nombreMes = clMesCalendario.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

    let celdas = '';
    for (let dia = 1; dia <= numDias; dia++) {
      const fecha = `${mes}-${String(dia).padStart(2, '0')}`;
      const info = porDia.get(fecha);
      let clase = '';
      if (info) clase = info.completado === info.total ? 'cl-cal-completo' : (info.incompleto > 0 ? 'cl-cal-incompleto' : '');
      celdas += `<button class="cl-cal-dia ${clase}" onclick="document.getElementById('cl-fecha').value='${fecha}';refreshTableroChecklists()">${dia}</button>`;
    }
    cont.innerHTML = `
      <div class="cl-toolbar">
        <button class="cl-btn-secundario" onclick="cambiarMesChecklist(-1)">←</button>
        <span style="text-transform:capitalize">${esc(nombreMes)}</span>
        <button class="cl-btn-secundario" onclick="cambiarMesChecklist(1)">→</button>
      </div>
      <div class="cl-cal-grid">${celdas}</div>
    `;
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function cambiarMesChecklist(delta) {
  clMesCalendario = new Date(clMesCalendario.getFullYear(), clMesCalendario.getMonth() + delta, 1);
  refreshCalendarioChecklists();
}

// ── Configuración: locales, checklists, tareas, asignaciones ────────────
async function refreshConfigChecklists() {
  const cont = document.getElementById('cl-config');
  if (!cont) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const [rLoc, rChk] = await Promise.all([apiFetch('/locales'), apiFetch('/checklists')]);
    const locales = await rLoc.json();
    const checklists = await rChk.json();
    cont.innerHTML = `
      <div class="cl-config-section">
        <p class="section-title">Locales</p>
        <div class="card">${locales.map(renderConfigLocal).join('') || '<div class="empty">Sin locales</div>'}</div>
        <div class="cl-form-row">
          <input type="text" id="cl-nuevo-local-nombre" placeholder="Nombre del nuevo local">
          <button class="btn-drive" onclick="crearLocalChecklist()">+ Local</button>
        </div>
      </div>
      <div class="cl-config-section">
        <p class="section-title">Checklists</p>
        <div class="card">${checklists.map(c => renderConfigChecklist(c, locales)).join('') || '<div class="empty">Sin checklists</div>'}</div>
        <div class="cl-form-row">
          <input type="text" id="cl-nuevo-checklist-nombre" placeholder="Nombre (p.ej. Apertura cocina)">
          <select id="cl-nuevo-checklist-local">${locales.map(l => `<option value="${l.id}">${esc(l.nombre)}</option>`).join('')}</select>
          <select id="cl-nuevo-checklist-turno">
            <option value="apertura">Apertura</option><option value="tarde">Tarde</option><option value="cierre">Cierre</option><option value="libre">Libre</option>
          </select>
          <button class="btn-drive" onclick="crearChecklistConfig()">+ Checklist</button>
        </div>
      </div>
    `;
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderConfigLocal(l) {
  return `<div class="cl-config-item">
    <b>${esc(l.nombre)}</b> — ${(l.dias_apertura || []).map(d => CL_DIA_LABEL[d] || d).join(', ')}
    ${l.numero_whatsapp_avisos ? ` · WhatsApp avisos: ${esc(l.numero_whatsapp_avisos)}` : ' · <span style="color:var(--muted)">sin WhatsApp de avisos</span>'}
  </div>`;
}

function renderConfigChecklist(c, locales) {
  const local = locales.find(l => l.id === c.local_id);
  return `<div class="cl-config-item">
    <b>${esc(c.nombre)}</b> — ${CL_TURNO_LABEL[c.turno] || c.turno} · ${esc(local?.nombre || c.local_nombre || '')}
    ${c.dias_semana ? ` · ${c.dias_semana.map(d => CL_DIA_LABEL[d] || d).join(', ')}` : ' · todos los días de apertura'}
  </div>`;
}

async function crearLocalChecklist() {
  const nombre = document.getElementById('cl-nuevo-local-nombre').value.trim();
  if (!nombre) { alert('Falta el nombre del local'); return; }
  try {
    const r = await apiFetch('/locales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo crear el local');
    await refreshConfigChecklists();
    await cargarLocalesChecklist();
  } catch (e) {
    alert(e.message);
  }
}

async function crearChecklistConfig() {
  const nombre = document.getElementById('cl-nuevo-checklist-nombre').value.trim();
  const local_id = document.getElementById('cl-nuevo-checklist-local').value;
  const turno = document.getElementById('cl-nuevo-checklist-turno').value;
  if (!nombre || !local_id) { alert('Falta el nombre o el local'); return; }
  try {
    const r = await apiFetch('/checklists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre, local_id, turno }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo crear el checklist');
    await refreshConfigChecklists();
  } catch (e) {
    alert(e.message);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────
function initChecklistsTab() {
  const fechaEl = document.getElementById('cl-fecha');
  if (!fechaEl) return; // esta página no tiene pestaña de Checklists
  fechaEl.value = new Date().toISOString().slice(0, 10);
  fechaEl.addEventListener('change', refreshTableroChecklists);
  document.getElementById('cl-filtro-local')?.addEventListener('change', () => { refreshTableroChecklists(); refreshCalendarioChecklists(); });
}
document.addEventListener('DOMContentLoaded', initChecklistsTab);
