// Escandallo asistido — componente compartido (aunque hoy solo Timbol tiene
// la pestaña), mismo patrón que banco-shared.js: apoyado en los globals de
// cada página (apiFetch, esc, eur, crearCapturaSecuencial). El editor de
// ingredientes (crearEditorEscandallo) es una única función reutilizada en
// tres sitios: "Nuevo plato con foto", cada grupo de una importación, y la
// edición de un plato ya confirmado.
(function injectEscandalloStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .esc-sin-revisar { opacity: .5; }
    .esc-fila-confianza-baja { background: rgba(217,107,82,.08); }
    .esc-tag { font-size: 10px; color: var(--ambar); margin-top: 2px; }
    .esc-confianza-pill { font-size: 10px; margin-top: 2px; }
    .esc-confianza-pill-baja { color: var(--alert); }
    .esc-confianza-pill-media { color: var(--ambar); }
    .esc-confianza-pill-alta { color: var(--muted); }
    .esc-nota { font-size: 10.5px; color: var(--muted); margin-top: 2px; font-style: italic; }
    .esc-cantidad-wrap { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
    .esc-cantidad-wrap input { width: 56px; text-align: center; }
    .esc-step { width: 24px; height: 24px; border-radius: 6px; background: var(--surface2); border: 1px solid var(--border); color: var(--text); font-size: 14px; line-height: 1; padding: 0; }
    .esc-card { cursor: pointer; }
    .esc-card-titulo { font-size: 14px; font-weight: 700; margin-bottom: 2px; }
    .esc-card-meta { font-size: 11px; color: var(--muted); margin-bottom: 8px; }
    .esc-card-cifras { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; color: var(--text); }
    .esc-margen-positivo { color: var(--ok); font-weight: 700; }
    .esc-margen-negativo { color: var(--alert); font-weight: 700; }
  `;
  document.head.appendChild(style);
})();

// ── Editor de ingredientes (reutilizado en los tres flujos) ───────────────
function crearEditorEscandallo({ containerId, nombre = '', precioCarta = null, ingredientes = [], onConfirmar, onEliminar, tituloAyuda }) {
  const cont = document.getElementById(containerId);
  const items = ingredientes.map(i => ({
    ingrediente: i.ingrediente,
    cantidad: Number(i.cantidad),
    unidad: i.unidad,
    visible: i.visible !== false,
    confianza: i.confianza || null,
    nota: i.nota || null,
    // Sin confianza = dato ya confirmado antes (edición existente) o añadido
    // a mano: no necesita revisión. Con confianza = viene de /proponer,
    // arranca sin revisar y se queda en gris hasta que se toque o confirme.
    revisado: !i.confianza,
  }));

  function pasoParaUnidad(u) {
    if (u === 'g') return 10;
    if (u === 'ml') return 25;
    if (u === 'kg' || u === 'l') return 0.1;
    return 1;
  }

  function filaHtml(it, i) {
    const clases = ['esc-fila'];
    if (it.confianza === 'baja') clases.push('esc-fila-confianza-baja');
    if (!it.revisado) clases.push('esc-sin-revisar');
    const paso = pasoParaUnidad(it.unidad);
    return `<tr class="${clases.join(' ')}">
      <td>
        <input type="text" value="${esc(it.ingrediente)}" class="esc-input-ingrediente" data-idx="${i}">
        ${it.visible === false ? '<div class="esc-tag">no se ve en la foto</div>' : ''}
        ${it.confianza ? `<div class="esc-confianza-pill esc-confianza-pill-${it.confianza}">confianza ${it.confianza}</div>` : ''}
        ${it.nota ? `<div class="esc-nota">${esc(it.nota)}</div>` : ''}
      </td>
      <td class="num">
        <div class="esc-cantidad-wrap">
          <button type="button" class="esc-step" data-idx="${i}" data-delta="${-paso}">−</button>
          <input type="number" step="any" value="${it.cantidad}" class="esc-input-cantidad" data-idx="${i}">
          <button type="button" class="esc-step" data-idx="${i}" data-delta="${paso}">+</button>
        </div>
      </td>
      <td>
        <select class="esc-input-unidad" data-idx="${i}">
          ${['g', 'ml', 'ud', 'kg', 'l'].map(u => `<option value="${u}" ${it.unidad === u ? 'selected' : ''}>${u}</option>`).join('')}
        </select>
      </td>
      <td><button type="button" class="banco-btn-secundario esc-asi" data-idx="${i}" ${it.revisado ? 'disabled' : ''}>Así</button></td>
      <td><button type="button" class="fi-delete esc-quitar" data-idx="${i}" title="Quitar">🗑</button></td>
    </tr>`;
  }

  function renderBody() {
    document.getElementById(`${containerId}-body`).innerHTML = items.map(filaHtml).join('');
  }

  async function confirmar() {
    const nombreVal = document.getElementById(`${containerId}-nombre`).value.trim();
    const precioVal = document.getElementById(`${containerId}-precio`).value;
    if (!nombreVal) { alert('El plato necesita un nombre'); return; }
    if (!items.length) { alert('Añade al menos un ingrediente'); return; }
    for (const it of items) {
      if (!it.ingrediente || !it.ingrediente.trim()) { alert('Cada ingrediente necesita nombre'); return; }
      if (!Number.isFinite(it.cantidad) || it.cantidad <= 0) { alert(`Cantidad inválida para "${it.ingrediente}"`); return; }
    }
    const payload = {
      nombre: nombreVal,
      precio_carta: precioVal === '' ? null : Number(precioVal),
      ingredientes: items.map(it => ({ ingrediente: it.ingrediente.trim(), cantidad: it.cantidad, unidad: it.unidad })),
    };
    const btn = document.getElementById(`${containerId}-confirmar`);
    btn.disabled = true;
    try {
      await onConfirmar(payload);
    } catch (e) {
      alert(e.message);
    } finally {
      if (document.body.contains(btn)) btn.disabled = false;
    }
  }

  function wire() {
    const body = document.getElementById(`${containerId}-body`);

    // input (escribir): actualiza el dato y quita el gris de "sin revisar"
    // sin regenerar la tabla — regenerarla perdería el foco/cursor mientras
    // se escribe.
    body.addEventListener('input', (e) => {
      const idx = Number(e.target.dataset.idx);
      if (Number.isNaN(idx)) return;
      if (e.target.classList.contains('esc-input-ingrediente')) items[idx].ingrediente = e.target.value;
      else if (e.target.classList.contains('esc-input-cantidad')) items[idx].cantidad = Number(e.target.value);
      else return;
      if (!items[idx].revisado) {
        items[idx].revisado = true;
        const row = e.target.closest('tr');
        row.classList.remove('esc-sin-revisar');
        const asiBtn = row.querySelector('.esc-asi');
        if (asiBtn) asiBtn.disabled = true;
      }
    });

    body.addEventListener('change', (e) => {
      const idx = Number(e.target.dataset.idx);
      if (Number.isNaN(idx) || !e.target.classList.contains('esc-input-unidad')) return;
      items[idx].unidad = e.target.value;
      items[idx].revisado = true;
      renderBody();
    });

    body.addEventListener('click', (e) => {
      const stepBtn = e.target.closest('.esc-step');
      if (stepBtn) {
        const idx = Number(stepBtn.dataset.idx);
        items[idx].cantidad = Math.max(0, Number((items[idx].cantidad + Number(stepBtn.dataset.delta)).toFixed(2)));
        items[idx].revisado = true;
        renderBody();
        return;
      }
      const asiBtn = e.target.closest('.esc-asi');
      if (asiBtn) {
        items[Number(asiBtn.dataset.idx)].revisado = true;
        renderBody();
        return;
      }
      const quitarBtn = e.target.closest('.esc-quitar');
      if (quitarBtn) {
        items.splice(Number(quitarBtn.dataset.idx), 1);
        renderBody();
      }
    });

    document.getElementById(`${containerId}-add`).addEventListener('click', () => {
      items.push({ ingrediente: '', cantidad: 0, unidad: 'g', visible: true, confianza: null, nota: null, revisado: true });
      renderBody();
    });

    document.getElementById(`${containerId}-confirmar`).addEventListener('click', confirmar);
    if (onEliminar) document.getElementById(`${containerId}-eliminar`).addEventListener('click', onEliminar);
  }

  cont.innerHTML = `
    <p class="captura-ayuda-texto">${esc(tituloAyuda || 'Es una estimación para que no empieces de cero. Corrige lo que sepas y confirma.')}</p>
    <div class="field"><label>Nombre del plato</label><input type="text" id="${containerId}-nombre" value="${esc(nombre)}"></div>
    <div class="field"><label>Precio de carta</label><input type="number" step="0.01" id="${containerId}-precio" value="${precioCarta ?? ''}"></div>
    <table class="banco-preview-table">
      <thead><tr><th>Ingrediente</th><th class="num">Cantidad</th><th>Unidad</th><th></th><th></th></tr></thead>
      <tbody id="${containerId}-body">${items.map(filaHtml).join('')}</tbody>
    </table>
    <button type="button" class="banco-btn-secundario" id="${containerId}-add">+ Añadir ingrediente</button>
    <div class="banco-confirmar-bar">
      <button type="button" class="btn-drive" id="${containerId}-confirmar">Confirmar</button>
      ${onEliminar ? `<button type="button" class="banco-btn-secundario" id="${containerId}-eliminar">Eliminar plato</button>` : ''}
    </div>
  `;
  wire();
}

function cerrarEditorEscandallo() {
  const el = document.getElementById('escandallo-editor');
  el.classList.add('hidden');
  el.innerHTML = '';
  document.getElementById('escandallo-home').classList.remove('hidden');
}

// ── "Nuevo plato con foto" ─────────────────────────────────────────────
let escandalloCaptura = null;

function initEscandalloCaptura() {
  const input = document.getElementById('input-escandallo-camara');
  if (!input) return;
  escandalloCaptura = crearCapturaSecuencial({
    ids: {
      home: 'escandallo-home', captura: 'escandallo-captura',
      thumbs: 'escandallo-captura-thumbs', peso: 'escandallo-captura-peso',
      btnFoto: 'btn-escandallo-hacer-foto', btnGaleria: 'btn-escandallo-galeria', btnPdf: 'btn-escandallo-pdf',
      inputCamara: 'input-escandallo-camara', inputGaleria: 'input-escandallo-galeria', inputPdf: 'input-escandallo-pdf',
      btnProcesar: 'btn-escandallo-procesar', btnCancelar: 'btn-escandallo-cancelar-captura',
    },
    maxFotos: 1,
    onProcesar: onProcesarFotoEscandallo,
  });
  document.getElementById('btn-escandallo-nuevo-foto').addEventListener('click', () => {
    document.getElementById('esc-captura-nombre').value = '';
    document.getElementById('esc-captura-precio').value = '';
    document.getElementById('esc-captura-descripcion').value = '';
    escandalloCaptura.abrir();
  });
}

async function onProcesarFotoEscandallo(archivos) {
  const nombre = document.getElementById('esc-captura-nombre').value.trim();
  const precio = document.getElementById('esc-captura-precio').value;
  const descripcion = document.getElementById('esc-captura-descripcion').value.trim();
  if (!nombre) {
    alert('Escribe el nombre del plato antes de procesar la foto');
    document.getElementById('escandallo-home').classList.remove('hidden');
    return;
  }

  const status = document.getElementById('escandallo-proponer-status');
  status.classList.remove('hidden');
  status.textContent = 'Analizando plato…';
  try {
    const fd = new FormData();
    fd.append('foto', archivos[0]);
    fd.append('nombre_plato', nombre);
    if (precio !== '') fd.append('precio_carta', precio);
    if (descripcion) fd.append('descripcion', descripcion);
    const r = await apiFetch('/escandallo/proponer', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo proponer el escandallo');
    status.classList.add('hidden');
    abrirEditorNuevo(d);
  } catch (e) {
    status.classList.add('hidden');
    alert(e.message);
    document.getElementById('escandallo-home').classList.remove('hidden');
  }
}

function abrirEditorNuevo(borrador) {
  document.getElementById('escandallo-home').classList.add('hidden');
  document.getElementById('escandallo-editor').classList.remove('hidden');
  crearEditorEscandallo({
    containerId: 'escandallo-editor',
    nombre: borrador.nombre_plato,
    precioCarta: borrador.precio_carta,
    ingredientes: borrador.ingredientes,
    onConfirmar: guardarEscandallo,
  });
}

async function guardarEscandallo(payload) {
  const r = await apiFetch('/escandallo/confirmar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'No se pudo guardar el plato');
  cerrarEditorEscandallo();
  refreshEscandalloListado();
}

// ── Importación desde Excel ────────────────────────────────────────────
async function subirExcelEscandallo(file) {
  if (!file) return;
  const status = document.getElementById('escandallo-import-status');
  status.classList.remove('hidden');
  status.textContent = 'Analizando archivo…';
  try {
    const fd = new FormData();
    fd.append('archivo', file);
    const r = await apiFetch('/escandallo/importar', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo procesar el archivo');
    status.classList.add('hidden');
    renderImportPreviewEscandallo(d);
  } catch (e) {
    status.classList.add('hidden');
    alert(e.message);
  }
}

function renderDudasEscandalloBlock(dudas) {
  if (!dudas || !dudas.length) return '';
  return `<div class="banco-duda-card">
    <div class="banco-duda-titulo">⚠ ${dudas.length} fila(s) sin interpretar</div>
    ${dudas.map(d => `<div class="banco-duda-row"><span>${esc(d.fila)}</span><div class="banco-duda-motivo">${esc(d.motivo)}${d.hoja ? ' · ' + esc(d.hoja) : ''}</div></div>`).join('')}
  </div>`;
}

function renderImportPreviewEscandallo(data) {
  const cont = document.getElementById('escandallo-import-preview');
  if (!data.platos.length) {
    cont.innerHTML = renderDudasEscandalloBlock(data.dudas) + '<div class="empty">No se encontró ningún plato en el archivo.</div>';
    return;
  }
  cont.innerHTML = renderDudasEscandalloBlock(data.dudas)
    + data.platos.map((_, i) => `<div class="card" id="escandallo-import-grupo-${i}"></div>`).join('');

  data.platos.forEach((grupo, i) => {
    crearEditorEscandallo({
      containerId: `escandallo-import-grupo-${i}`,
      nombre: grupo.nombre,
      precioCarta: grupo.precio_carta,
      ingredientes: grupo.ingredientes,
      tituloAyuda: 'Revisa este plato antes de confirmarlo — se guarda solo, no afecta a los demás.',
      onConfirmar: async (payload) => {
        await guardarEscandallo(payload);
        const grupoEl = document.getElementById(`escandallo-import-grupo-${i}`);
        if (grupoEl) grupoEl.outerHTML = `<div class="empty">✓ ${esc(payload.nombre)} guardado</div>`;
      },
    });
  });
}

// ── Listado (tarjetas) + edición de un plato existente ─────────────────
let escandalloPlatosCache = [];

async function refreshEscandalloListado() {
  const cont = document.getElementById('escandallo-listado');
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const r = await apiFetch('/escandallo');
    const platos = await r.json();
    if (!r.ok) throw new Error(platos.error || 'No se pudo cargar el listado');
    escandalloPlatosCache = platos;
    cont.innerHTML = platos.length
      ? platos.map(renderPlatoCard).join('')
      : '<div class="empty">Sin platos todavía. Empieza con "Nuevo plato con foto" o importa un Excel.</div>';
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function estadoCosteSufijo(estado) {
  if (estado === 'parcial') return ' (parcial)';
  if (estado === 'sin_precio') return ' (sin precio)';
  return '';
}

function renderPlatoCard(p) {
  const margenClase = p.margen_eur == null ? '' : (p.margen_eur >= 0 ? 'esc-margen-positivo' : 'esc-margen-negativo');
  return `
    <div class="card esc-card" onclick="abrirEditorExistenteEscandallo(${p.id})">
      <div class="esc-card-titulo">${esc(p.nombre)}</div>
      <div class="esc-card-meta">${p.num_ingredientes} ingrediente${p.num_ingredientes !== 1 ? 's' : ''}</div>
      <div class="esc-card-cifras">
        <span>Coste: ${p.coste_estimado != null ? eur(p.coste_estimado) : '—'}${estadoCosteSufijo(p.estado_coste)}</span>
        <span>Carta: ${p.precio_carta != null ? eur(p.precio_carta) : '—'}</span>
        <span class="${margenClase}">Margen: ${p.margen_eur != null ? `${eur(p.margen_eur)} · ${p.margen_pct}%` : '—'}</span>
      </div>
    </div>
  `;
}

function abrirEditorExistenteEscandallo(id) {
  const plato = escandalloPlatosCache.find(p => p.id === id);
  if (!plato) return;
  document.getElementById('escandallo-home').classList.add('hidden');
  document.getElementById('escandallo-editor').classList.remove('hidden');
  crearEditorEscandallo({
    containerId: 'escandallo-editor',
    nombre: plato.nombre,
    precioCarta: plato.precio_carta,
    ingredientes: plato.ingredientes,
    onConfirmar: guardarEscandallo,
    onEliminar: async () => {
      if (!confirm(`¿Eliminar "${plato.nombre}"? Se borra su escandallo.`)) return;
      try {
        const r = await apiFetch(`/escandallo/${id}`, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'No se pudo eliminar');
        cerrarEditorEscandallo();
        refreshEscandalloListado();
      } catch (e) {
        alert(e.message);
      }
    },
  });
}

// ── Init ─────────────────────────────────────────────────────────────────
function refreshEscandalloTab() {
  document.getElementById('escandallo-import-preview').innerHTML = '';
  cerrarEditorEscandallo();
  refreshEscandalloListado();
}

function initEscandalloTab() {
  const importInput = document.getElementById('escandallo-importar-input');
  if (!importInput) return; // esta página no tiene pestaña de escandallo
  initEscandalloCaptura();
  document.getElementById('btn-escandallo-importar').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    subirExcelEscandallo(importInput.files[0]);
    importInput.value = '';
  });
}
document.addEventListener('DOMContentLoaded', initEscandalloTab);
