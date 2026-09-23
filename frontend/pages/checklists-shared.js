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
    .cl-btn-secundario:disabled, .btn-drive:disabled { opacity: .4; cursor: not-allowed; }
    .cl-dia-chips { display: flex; gap: 5px; margin-top: 8px; flex-wrap: wrap; }
    .cl-dia-chip { background: var(--surface2); border: 1px solid var(--border); border-radius: 14px; padding: 5px 10px; font-size: 11.5px; color: var(--muted); cursor: pointer; }
    .cl-dia-chip.activo { background: rgba(196,168,130,.15); border-color: var(--accent); color: var(--accent); font-weight: 600; }
    .cl-config-actions { display: flex; gap: 6px; flex: none; }
    .cl-config-actions button { background: transparent; border: none; color: var(--muted); font-size: 12px; cursor: pointer; padding: 2px 4px; }
    .cl-config-actions button:hover { color: var(--text); }
    .cl-checklist-card { margin-bottom: 8px; cursor: pointer; }
    .cl-panel-card { margin-top: 10px; }
    .cl-tarea-row { border-top: 1px solid var(--border); padding: 10px 0; }
    .cl-tarea-row:first-child { border-top: none; }
    .cl-form-row select, .cl-form-row input[type="time"] { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; color: var(--text); font-size: 12.5px; }
    .cl-panel-empleados { max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; margin-top: 6px; }
  `;
  document.head.appendChild(style);
})();

const CL_DIA_LABEL = { lun: 'Lun', mar: 'Mar', mie: 'Mié', jue: 'Jue', vie: 'Vie', sab: 'Sáb', dom: 'Dom' };
const CL_DIAS_ORDEN = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'];
const CL_TURNO_LABEL = { apertura: 'Apertura', tarde: 'Tarde', cierre: 'Cierre', libre: 'Libre' };

let clLocales = [];
let clEjecucionActual = null;
let clMesCalendario = new Date();
let clLocalEditando = null;

// Chips de días lun–dom reutilizados en el local y (opciones avanzadas
// aparte) en checklists. Delegado en document porque el contenido que los
// contiene se re-renderiza entero en cada refresh.
function renderDiaChips(idCont, diasActivos) {
  return `<div class="cl-dia-chips" id="${idCont}">
    ${CL_DIAS_ORDEN.map(d => `<button type="button" class="cl-dia-chip${(diasActivos || []).includes(d) ? ' activo' : ''}" data-dia="${d}">${CL_DIA_LABEL[d]}</button>`).join('')}
  </div>`;
}
function leerDiasChips(idCont) {
  return [...document.querySelectorAll(`#${idCont} .cl-dia-chip.activo`)].map(b => b.dataset.dia);
}
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.cl-dia-chip');
  if (chip) chip.classList.toggle('activo');
});

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
        <p class="section-title">Informe (Sanidad)</p>
        <div class="card">
          <div class="cl-form-row" style="margin-top:0">
            <input type="date" id="cl-informe-desde">
            <input type="date" id="cl-informe-hasta">
            <button class="btn-drive" onclick="descargarInformeChecklists()">Descargar PDF</button>
          </div>
        </div>
      </div>
      <div class="cl-config-section">
        <p class="section-title">Locales</p>
        <div class="card">${locales.map(renderConfigLocal).join('') || '<div class="empty">Sin locales</div>'}</div>
        <div class="cl-form-row">
          <input type="text" id="cl-nuevo-local-nombre" placeholder="Nombre del nuevo local" autocomplete="off"
            oninput="document.getElementById('cl-btn-nuevo-local').disabled = !this.value.trim()">
          <button class="btn-drive" id="cl-btn-nuevo-local" onclick="crearLocalChecklist()" disabled>+ Local</button>
        </div>
      </div>
      <div class="cl-config-section">
        <p class="section-title">Checklists</p>
        <div class="cl-form-row" style="margin-top:0">
          <button class="cl-btn-secundario" onclick="crearDesdeePlantillaUI('Apertura cocina')">Apertura cocina</button>
          <button class="cl-btn-secundario" onclick="crearDesdeePlantillaUI('Cierre cocina')">Cierre cocina</button>
          <button class="cl-btn-secundario" onclick="crearDesdeePlantillaUI('Apertura sala')">Apertura sala</button>
          <button class="cl-btn-secundario" onclick="crearDesdeePlantillaUI('Cierre sala')">Cierre sala</button>
        </div>
        <div id="cl-panel"></div>
        ${checklists.map(renderChecklistCard).join('') || '<div class="empty">Sin checklists</div>'}
        <div class="cl-form-row">
          <button class="btn-drive" onclick="abrirPanelChecklist(null)">+ Nuevo checklist</button>
        </div>
      </div>
    `;
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderConfigLocal(l) {
  if (clLocalEditando === l.id) return renderConfigLocalForm(l);
  return `<div class="cl-config-item" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
    <div>
      <b>${esc(l.nombre)}</b>${l.activo === false ? ' <span class="badge badge-off">Inactivo</span>' : ''} — ${(l.dias_apertura || []).map(d => CL_DIA_LABEL[d] || d).join(', ')}
      ${l.numero_whatsapp_avisos ? ` · WhatsApp avisos: ${esc(l.numero_whatsapp_avisos)}` : ' · <span style="color:var(--muted)">sin WhatsApp de avisos</span>'}
    </div>
    <div class="cl-config-actions">
      <button onclick="toggleEditarLocal(${l.id})" title="Editar">✎</button>
      <button onclick="eliminarLocalChecklist(${l.id})" title="Eliminar">🗑</button>
    </div>
  </div>`;
}

function renderConfigLocalForm(l) {
  return `<div class="cl-config-item">
    <div class="cl-form-row" style="margin-top:0">
      <input type="text" id="cl-editar-local-nombre" value="${esc(l.nombre)}" placeholder="Nombre">
      <input type="text" id="cl-editar-local-whatsapp" value="${esc(l.numero_whatsapp_avisos || '')}" placeholder="WhatsApp de avisos">
    </div>
    ${renderDiaChips('cl-editar-local-dias', l.dias_apertura)}
    <div class="cl-form-row">
      <button class="btn-drive" onclick="guardarLocalChecklist(${l.id})">Guardar</button>
      <button class="cl-btn-secundario" onclick="toggleEditarLocal(null)">Cancelar</button>
    </div>
  </div>`;
}

function toggleEditarLocal(id) {
  clLocalEditando = clLocalEditando === id ? null : id;
  refreshConfigChecklists();
}

async function guardarLocalChecklist(id) {
  const nombre = document.getElementById('cl-editar-local-nombre').value.trim();
  const numero_whatsapp_avisos = document.getElementById('cl-editar-local-whatsapp').value.trim();
  const dias_apertura = leerDiasChips('cl-editar-local-dias');
  if (!nombre) { alert('Falta el nombre'); return; }
  if (!dias_apertura.length) { alert('Elige al menos un día de apertura'); return; }
  try {
    const r = await apiFetch(`/locales/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, dias_apertura, numero_whatsapp_avisos: numero_whatsapp_avisos || null }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo guardar');
    clLocalEditando = null;
    await refreshConfigChecklists();
    await cargarLocalesChecklist();
  } catch (e) {
    alert(e.message);
  }
}

async function eliminarLocalChecklist(id) {
  if (!confirm('¿Eliminar este local?')) return;
  try {
    const r = await apiFetch(`/locales/${id}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo eliminar');
    if (!d.borrado) alert(d.motivo);
    await refreshConfigChecklists();
    await cargarLocalesChecklist();
  } catch (e) {
    alert(e.message);
  }
}

// ── Tarjetas de checklist ────────────────────────────────────────────────
function renderChecklistCard(c) {
  return `<div class="card cl-checklist-card" onclick="abrirPanelChecklist(${c.id})">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <b>${esc(c.nombre)}</b>
      <span class="badge ${c.activo === false ? 'badge-off' : 'badge-ok'}">${c.activo === false ? 'Inactivo' : 'Activo'}</span>
    </div>
    <div class="cl-ejec-meta">${esc(c.local_nombre || '')} · ${CL_TURNO_LABEL[c.turno] || c.turno} · ${c.num_tareas} tarea(s) · ${c.num_empleados} empleado(s)</div>
    <div class="cl-config-actions" onclick="event.stopPropagation()">
      <button onclick="duplicarChecklistUI(${c.id})">Duplicar</button>
      <button onclick="desactivarChecklistUI(${c.id}, ${c.activo !== false})">${c.activo === false ? 'Activar' : 'Desactivar'}</button>
    </div>
  </div>`;
}

async function crearDesdeePlantillaUI(nombrePlantilla) {
  let localId = document.getElementById('cl-filtro-local')?.value;
  if (!localId) {
    if (clLocales.length === 1) localId = clLocales[0].id;
    else { alert('Elige primero un local en el selector de arriba del tablero'); return; }
  }
  try {
    const r = await apiFetch('/checklists/plantilla', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local_id: localId, nombre_plantilla: nombrePlantilla }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo crear la plantilla');
    await refreshConfigChecklists();
    await abrirPanelChecklist(d.id);
  } catch (e) {
    alert(e.message);
  }
}

async function duplicarChecklistUI(id) {
  try {
    const r = await apiFetch(`/checklists/${id}/duplicar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo duplicar');
    await refreshConfigChecklists();
    await abrirPanelChecklist(d.id);
  } catch (e) {
    alert(e.message);
  }
}

async function desactivarChecklistUI(id, estaActivo) {
  try {
    const r = await apiFetch(`/checklists/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activo: !estaActivo }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo actualizar');
    await refreshConfigChecklists();
  } catch (e) {
    alert(e.message);
  }
}

// ── Panel único: crear/editar un checklist completo ─────────────────────
let clPanel = null; // { id, nombre, local_id, turno, tareas: [...], empleado_ids: [...] }
let clPanelEmpleados = []; // empleados activos del local elegido en el panel

async function abrirPanelChecklist(id) {
  if (id) {
    try {
      const r = await apiFetch(`/checklists/${id}/completo`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo cargar el checklist');
      clPanel = {
        id: d.checklist.id, nombre: d.checklist.nombre, local_id: d.checklist.local_id, turno: d.checklist.turno,
        tareas: d.tareas.map(t => ({
          id: t.id, titulo: t.titulo, requiere_foto: t.requiere_foto, hora_limite: t.hora_limite,
          requiere_valor: t.requiere_valor, valor_etiqueta: t.valor_etiqueta, valor_min: t.valor_min, valor_max: t.valor_max,
        })),
        empleado_ids: d.empleado_ids,
      };
      await cargarEmpleadosPanel(false);
    } catch (e) {
      alert(e.message);
      return;
    }
  } else {
    const localPreseleccionado = clLocales.length === 1 ? clLocales[0].id : (document.getElementById('cl-filtro-local')?.value || '');
    clPanel = { id: null, nombre: '', local_id: localPreseleccionado, turno: 'apertura', tareas: [], empleado_ids: [] };
    await cargarEmpleadosPanel(true);
  }
  renderPanelChecklist();
  document.getElementById('cl-panel').scrollIntoView({ behavior: 'smooth' });
}

// marcarPorDefecto: true para un checklist nuevo (todos los empleados del
// local marcados de entrada); false al editar, donde empleado_ids ya viene
// de las asignaciones reales.
async function cargarEmpleadosPanel(marcarPorDefecto) {
  if (!clPanel.local_id) { clPanelEmpleados = []; return; }
  try {
    const r = await apiFetch(`/empleados?local_id=${clPanel.local_id}`);
    clPanelEmpleados = await r.json();
  } catch (e) {
    clPanelEmpleados = [];
  }
  if (marcarPorDefecto) clPanel.empleado_ids = clPanelEmpleados.map(e => e.id);
}

// Cambiar de local reemplaza la lista de empleados (son de otro local) —
// se vuelve a marcar todos por defecto, tanto al crear como al editar, para
// no dejar ids de empleados que ya no pertenecen al local elegido.
async function cambiarLocalPanel(nuevoLocalId) {
  clPanel.local_id = nuevoLocalId;
  await cargarEmpleadosPanel(true);
  renderPanelChecklist();
}

function renderPanelChecklist() {
  const cont = document.getElementById('cl-panel');
  if (!clPanel) { cont.innerHTML = ''; return; }
  cont.innerHTML = `
    <div class="card cl-panel-card">
      <p class="section-title" style="margin-top:0">${clPanel.id ? 'Editar checklist' : 'Nuevo checklist'}</p>
      <div class="cl-form-row" style="margin-top:0">
        <input type="text" id="cl-panel-nombre" placeholder="Nombre" value="${esc(clPanel.nombre)}" oninput="clPanel.nombre = this.value">
        <select onchange="cambiarLocalPanel(this.value)">
          <option value="">Elige un local</option>
          ${clLocales.map(l => `<option value="${l.id}" ${String(l.id) === String(clPanel.local_id) ? 'selected' : ''}>${esc(l.nombre)}</option>`).join('')}
        </select>
        <select onchange="clPanel.turno = this.value">
          ${Object.entries(CL_TURNO_LABEL).map(([v, l]) => `<option value="${v}" ${v === clPanel.turno ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>

      <p class="section-title">Tareas</p>
      <div id="cl-panel-tareas">${clPanel.tareas.map((t, i) => renderTareaRow(t, i)).join('') || '<div class="empty">Sin tareas todavía</div>'}</div>
      <div class="cl-form-row">
        <button class="cl-btn-secundario" onclick="agregarTareaPanel()">+ Tarea</button>
      </div>

      <p class="section-title">Empleados de este local</p>
      <div class="cl-panel-empleados">${clPanelEmpleados.map(renderEmpleadoCheckbox).join('') || '<div class="empty">Sin empleados activos en este local</div>'}</div>

      <div class="cl-form-row">
        <button class="btn-drive" onclick="guardarPanelChecklist()">Guardar</button>
        <button class="cl-btn-secundario" onclick="cerrarPanelChecklist()">Cancelar</button>
      </div>
    </div>
  `;
}

function cerrarPanelChecklist() {
  clPanel = null;
  document.getElementById('cl-panel').innerHTML = '';
}

// Cada input de una tarea escribe directamente en clPanel.tareas[i] sin
// re-renderizar (mismo patrón que tarifas-shared.js: si re-pintáramos en
// cada pulsación se perdería el foco/cursor). Solo las operaciones
// estructurales (añadir, quitar, mover, activar "¿pide un valor?") vuelven
// a pintar la lista de tareas.
function renderTareaRow(t, i) {
  return `<div class="cl-tarea-row" id="cl-tarea-row-${i}">
    <div class="cl-form-row" style="margin-top:0">
      <input type="text" placeholder="Título" value="${esc(t.titulo || '')}" oninput="clPanel.tareas[${i}].titulo = this.value">
      <label style="font-size:12px;display:flex;align-items:center;gap:4px">
        <input type="checkbox" ${t.requiere_foto ? 'checked' : ''} onchange="clPanel.tareas[${i}].requiere_foto = this.checked"> Foto obligatoria
      </label>
      <input type="time" value="${esc(t.hora_limite || '')}" oninput="clPanel.tareas[${i}].hora_limite = this.value || null">
      <select onchange="cambiarRequiereValorTarea(${i}, this.value === 'si')">
        <option value="no" ${!t.requiere_valor ? 'selected' : ''}>¿Pide un valor? No</option>
        <option value="si" ${t.requiere_valor ? 'selected' : ''}>¿Pide un valor? Sí</option>
      </select>
    </div>
    ${t.requiere_valor ? `<div class="cl-form-row">
      <input type="text" placeholder="Etiqueta (ej. °C)" value="${esc(t.valor_etiqueta || '')}" oninput="clPanel.tareas[${i}].valor_etiqueta = this.value">
      <input type="number" step="0.1" placeholder="Mínimo" value="${t.valor_min ?? ''}" oninput="clPanel.tareas[${i}].valor_min = this.value">
      <input type="number" step="0.1" placeholder="Máximo" value="${t.valor_max ?? ''}" oninput="clPanel.tareas[${i}].valor_max = this.value">
    </div>` : ''}
    <div class="cl-form-row">
      <button class="cl-btn-secundario" onclick="moverTareaPanel(${i}, -1)" ${i === 0 ? 'disabled' : ''}>↑ Subir</button>
      <button class="cl-btn-secundario" onclick="moverTareaPanel(${i}, 1)" ${i === clPanel.tareas.length - 1 ? 'disabled' : ''}>↓ Bajar</button>
      <button class="cl-btn-secundario" onclick="eliminarTareaPanel(${i})">Eliminar</button>
    </div>
  </div>`;
}

function renderTareasPanel() {
  document.getElementById('cl-panel-tareas').innerHTML = clPanel.tareas.map((t, i) => renderTareaRow(t, i)).join('') || '<div class="empty">Sin tareas todavía</div>';
}

function cambiarRequiereValorTarea(i, valor) {
  clPanel.tareas[i].requiere_valor = valor;
  renderTareasPanel();
}
function agregarTareaPanel() {
  clPanel.tareas.push({ titulo: '', requiere_foto: false, hora_limite: null, requiere_valor: false, valor_etiqueta: null, valor_min: null, valor_max: null });
  renderTareasPanel();
}
function eliminarTareaPanel(i) {
  clPanel.tareas.splice(i, 1);
  renderTareasPanel();
}
function moverTareaPanel(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= clPanel.tareas.length) return;
  [clPanel.tareas[i], clPanel.tareas[j]] = [clPanel.tareas[j], clPanel.tareas[i]];
  renderTareasPanel();
}

function renderEmpleadoCheckbox(e) {
  const marcado = clPanel.empleado_ids.includes(e.id);
  return `<label style="display:flex;align-items:center;gap:6px;font-size:13px;padding:4px 0">
    <input type="checkbox" ${marcado ? 'checked' : ''} onchange="toggleEmpleadoPanel(${e.id}, this.checked)"> ${esc(e.nombre)}
  </label>`;
}
function toggleEmpleadoPanel(id, marcado) {
  if (marcado) { if (!clPanel.empleado_ids.includes(id)) clPanel.empleado_ids.push(id); }
  else { clPanel.empleado_ids = clPanel.empleado_ids.filter(x => x !== id); }
}

async function guardarPanelChecklist() {
  if (!clPanel.nombre.trim()) { alert('Falta el nombre'); return; }
  if (!clPanel.local_id) { alert('Falta el local'); return; }
  const payload = { nombre: clPanel.nombre.trim(), local_id: clPanel.local_id, turno: clPanel.turno, tareas: clPanel.tareas, empleado_ids: clPanel.empleado_ids };
  try {
    const url = clPanel.id ? `/checklists/${clPanel.id}/completo` : '/checklists/completo';
    const r = await apiFetch(url, { method: clPanel.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo guardar');
    cerrarPanelChecklist();
    await refreshConfigChecklists();
  } catch (e) {
    alert(e.message);
  }
}

async function crearLocalChecklist() {
  const nombre = document.getElementById('cl-nuevo-local-nombre').value.trim();
  if (!nombre) return; // el botón está deshabilitado sin texto, esto es solo defensivo
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

async function descargarInformeChecklists() {
  const desde = document.getElementById('cl-informe-desde').value;
  const hasta = document.getElementById('cl-informe-hasta').value;
  if (!desde || !hasta) { alert('Elige desde y hasta'); return; }
  const local = document.getElementById('cl-filtro-local')?.value;
  const qs = new URLSearchParams({ desde, hasta });
  if (local) qs.set('local', local);
  try {
    const r = await apiFetch(`/checklists/informe?${qs}`);
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'No se pudo generar el informe'); }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `checklists-${desde}-a-${hasta}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
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
