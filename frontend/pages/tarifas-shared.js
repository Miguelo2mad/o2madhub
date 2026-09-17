// Tarifas pactadas por proveedor — componente compartido entre timbol.html
// y comarea.html. Script clásico (no módulo): se apoya a propósito en los
// globals ya definidos por el <script> propio de cada página (apiFetch,
// esc, eur, token, userRole, facturas, switchTab, MESES) en vez de
// duplicarlos — igual que el resto del hub no tiene build step, este
// archivo solo se sirve como <script src="tarifas-shared.js">.

// ── Estilos ──────────────────────────────────────────────────────────────
(function injectTarifasStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .duda-card { background: rgba(217,107,82,.08); border: 1px solid rgba(217,107,82,.3); border-radius: 14px; padding: 14px; margin-bottom: 16px; }
    .duda-titulo { font-weight: 600; font-size: 13px; color: var(--alert); margin-bottom: 8px; }
    .duda-row { font-size: 12px; padding: 6px 0; border-top: 1px solid rgba(217,107,82,.2); }
    .duda-row:first-of-type { border-top: none; }
    .duda-hoja { color: var(--muted); }
    .duda-fila { font-family: monospace; }
    .duda-motivo { color: var(--muted); margin-top: 2px; }

    .tarifa-grupo-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px; margin-bottom: 14px; }
    .tarifa-grupo-card.sin-proveedor { border-color: var(--alert); }
    .tarifa-grupo-header { margin-bottom: 12px; }
    .tarifa-hoja-tag { font-size: 11px; color: var(--muted); margin-left: 8px; }
    .tarifa-grupo-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin-top: 8px; }
    .tarifa-grupo-fields .field { margin-bottom: 0; }
    .tarifa-grupo-fields label { font-size: 11px; color: var(--muted); display: block; margin-bottom: 3px; }
    .tarifa-grupo-fields input { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 13px; padding: 7px 9px; }
    .tarifa-productos-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
    .tarifa-productos-table th { text-align: left; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .5px; font-size: 10px; padding: 6px 6px; border-bottom: 1px solid var(--border); }
    .tarifa-productos-table td { padding: 4px 6px; border-bottom: 1px solid var(--border); }
    .tarifa-productos-table input { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 12px; padding: 5px 7px; }
    .btn-add-producto { margin-top: 8px; background: transparent; border: 1px dashed var(--border); color: var(--accent); border-radius: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
    .tarifa-confirmar-bar { display: flex; gap: 10px; margin: 16px 0; }
    .tarifa-confirmar-bar button { flex: 1; }
    .tarifa-btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--text); padding: 10px 16px; border-radius: 10px; font-size: 14px; cursor: pointer; }

    .tarifa-listado-item { padding: 12px 0; border-bottom: 1px solid var(--border); }
    .tarifa-listado-item:last-child { border-bottom: none; }
    .tli-nombre { font-weight: 600; font-size: 14px; }
    .tli-nif { font-weight: 400; font-size: 11px; color: var(--muted); margin-left: 6px; }
    .tli-detalle { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .tli-detalle.empty-inline { color: var(--alert); }
    .tli-tolerancia { font-size: 11px; color: var(--muted); margin-top: 2px; }

    .fi-lineas-toggle { background: transparent; border: none; color: var(--accent); font-size: 12px; cursor: pointer; padding: 6px 0 0; }
    .fi-lineas { margin-top: 8px; }
    .linea-destacada { background: rgba(217,107,82,.08); }
    .fi-tipo-select-btn { background: transparent; border: none; color: var(--accent); font-size: 13px; cursor: pointer; padding: 2px 4px; }
    .sobreprecio-link { cursor: pointer; }
    .flash-highlight { animation: flashHighlight 2s ease; }
    @keyframes flashHighlight { 0%, 100% { background: transparent; } 20% { background: rgba(217,164,65,.25); } }
  `;
  document.head.appendChild(style);
})();

// ── Normalización de NIF (debe coincidir con normalizarNif en backend/lib/tarifas.js) ──
function normalizarNifClient(raw) {
  if (!raw) return '';
  let s = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('ES') && s.length > 2) s = s.slice(2);
  return s;
}

// ── Caché de proveedores (para casar cif_proveedor de una factura con su tarifa) ──
let proveedoresCache = null;
async function getProveedores() {
  if (!proveedoresCache) proveedoresCache = await (await apiFetch('/tarifas')).json();
  return proveedoresCache;
}
async function buscarProveedorPorNif(nif) {
  const norm = normalizarNifClient(nif);
  if (!norm) return null;
  const list = await getProveedores();
  return list.find(p => normalizarNifClient(p.nif) === norm) || null;
}

// ── Pestaña Tarifas: subir, vista previa, confirmar ─────────────────────
let previewState = null;

async function subirArchivoTarifa(file) {
  if (!file) return;
  const status = document.getElementById('tarifas-upload-status');
  status.classList.remove('hidden');
  status.textContent = 'Analizando archivo…';
  try {
    const fd = new FormData();
    fd.append('archivo', file);
    const r = await apiFetch('/tarifas/importar', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo procesar el archivo');
    status.classList.add('hidden');
    renderPreview(d);
  } catch (e) {
    status.classList.add('hidden');
    alert(e.message);
  }
}

// Prioridad visual: dudas primero, luego los grupos sin proveedor detectado,
// por último el resto — el usuario tiene que ver de un vistazo qué necesita
// su atención antes de confirmar, si no confirma sin mirar.
function renderPreview(preview) {
  previewState = preview;

  const ordenGrupos = preview.grupos
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (a.g.proveedor_detectado ? 1 : 0) - (b.g.proveedor_detectado ? 1 : 0));

  document.getElementById('tarifas-preview').innerHTML = `
    ${renderDudasBlock(preview.dudas)}
    <div id="tarifa-grupos">${ordenGrupos.map(({ g, i }) => renderGrupoCard(g, i)).join('')}</div>
    <div class="tarifa-confirmar-bar">
      <button class="btn-drive" id="btn-confirmar-tarifas">Confirmar e importar</button>
      <button class="tarifa-btn-secondary" id="btn-cancelar-tarifas">Cancelar</button>
    </div>`;
  document.getElementById('tarifas-preview').classList.remove('hidden');
  document.getElementById('tarifas-upload-box').classList.add('hidden');
  document.getElementById('btn-confirmar-tarifas').addEventListener('click', confirmarTarifasUI);
  document.getElementById('btn-cancelar-tarifas').addEventListener('click', cancelarPreviewTarifas);
}

function renderDudasBlock(dudas) {
  if (!dudas || !dudas.length) return '';
  return `<div class="duda-card">
    <div class="duda-titulo">⚠ ${dudas.length} fila(s) sin interpretar — revísalas antes de confirmar</div>
    ${dudas.map(d => `<div class="duda-row">
      ${d.hoja ? `<span class="duda-hoja">${esc(d.hoja)}</span> — ` : ''}<span class="duda-fila">${esc(d.fila)}</span>
      <div class="duda-motivo">${esc(d.motivo)}</div>
    </div>`).join('')}
  </div>`;
}

function renderGrupoCard(g, i) {
  const sinProveedor = !g.proveedor_detectado;
  return `<div class="tarifa-grupo-card ${sinProveedor ? 'sin-proveedor' : ''}" id="grupo-card-${i}">
    <div class="tarifa-grupo-header">
      ${sinProveedor ? '<span class="badge badge-alert">❓ Proveedor no detectado</span>' : ''}
      ${g.hoja ? `<span class="tarifa-hoja-tag">Hoja: ${esc(g.hoja)}</span>` : ''}
      <div class="tarifa-grupo-fields">
        <div class="field"><label>NIF *</label><input type="text" placeholder="B12345678" value="${esc(g.nif || '')}" oninput="actualizarGrupoCampo(${i}, 'nif', this.value)"></div>
        <div class="field"><label>Nombre proveedor</label><input type="text" value="${esc(g.nombre ?? g.proveedor_detectado ?? '')}" oninput="actualizarGrupoCampo(${i}, 'nombre', this.value)"></div>
        <div class="field"><label>Nombre tarifa (opcional)</label><input type="text" placeholder="Temporada 2027" value="${esc(g.nombre_tarifa || '')}" oninput="actualizarGrupoCampo(${i}, 'nombre_tarifa', this.value)"></div>
        <div class="field"><label>Vigente desde</label><input type="date" value="${g.vigente_desde || new Date().toISOString().slice(0,10)}" oninput="actualizarGrupoCampo(${i}, 'vigente_desde', this.value)"></div>
      </div>
    </div>
    <table class="tarifa-productos-table">
      <thead><tr><th>Producto</th><th>Unidad</th><th class="num">Precio</th><th>Notas</th><th></th></tr></thead>
      <tbody>${g.productos.map((p, j) => renderProductoRow(i, j, p)).join('')}</tbody>
    </table>
    <button class="btn-add-producto" onclick="agregarProducto(${i})">+ Añadir producto</button>
  </div>`;
}

function renderProductoRow(i, j, p) {
  return `<tr>
    <td><input type="text" value="${esc(p.producto || '')}" oninput="actualizarProducto(${i},${j},'producto',this.value)"></td>
    <td><input type="text" value="${esc(p.unidad || '')}" oninput="actualizarProducto(${i},${j},'unidad',this.value)"></td>
    <td class="num"><input type="number" step="0.0001" value="${p.precio ?? ''}" oninput="actualizarProducto(${i},${j},'precio',this.value)"></td>
    <td><input type="text" value="${esc(p.notas || '')}" oninput="actualizarProducto(${i},${j},'notas',this.value)"></td>
    <td><button class="fi-delete" onclick="eliminarProducto(${i},${j})" title="Quitar producto">🗑</button></td>
  </tr>`;
}

function actualizarGrupoCampo(i, campo, valor) { previewState.grupos[i][campo] = valor; }
function actualizarProducto(i, j, campo, valor) {
  previewState.grupos[i].productos[j][campo] = campo === 'precio' ? Number(valor) : valor;
}
function eliminarProducto(i, j) {
  previewState.grupos[i].productos.splice(j, 1);
  document.getElementById(`grupo-card-${i}`).outerHTML = renderGrupoCard(previewState.grupos[i], i);
}
function agregarProducto(i) {
  previewState.grupos[i].productos.push({ producto: '', unidad: '', precio: null, notas: '' });
  document.getElementById(`grupo-card-${i}`).outerHTML = renderGrupoCard(previewState.grupos[i], i);
}

async function confirmarTarifasUI() {
  const grupos = previewState.grupos.filter(g => g.productos.length > 0);
  for (const g of grupos) {
    if (!g.nif || !g.nif.trim()) {
      alert(`Falta el NIF del proveedor para el grupo "${g.nombre || g.proveedor_detectado || g.hoja || '(sin nombre)'}"`);
      return;
    }
  }
  const btn = document.getElementById('btn-confirmar-tarifas');
  btn.disabled = true;
  try {
    const r = await apiFetch('/tarifas/confirmar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origen_archivo: previewState.origen_archivo, grupos }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo confirmar la tarifa');
    alert(`Importado: ${d.proveedores_creados} proveedor(es) nuevo(s), ${d.proveedores_existentes} ya existente(s), ${d.tarifas_creadas} tarifa(s), ${d.productos_guardados} producto(s).`);
    cancelarPreviewTarifas();
    proveedoresCache = null; // invalida la caché tras un cambio real
    cargarListadoTarifas();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

function cancelarPreviewTarifas() {
  previewState = null;
  document.getElementById('tarifas-preview').classList.add('hidden');
  document.getElementById('tarifas-preview').innerHTML = '';
  document.getElementById('tarifas-upload-box').classList.remove('hidden');
  document.getElementById('tarifa-archivo-input').value = '';
}

async function cargarListadoTarifas() {
  const cont = document.getElementById('tarifas-listado');
  if (!cont) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    proveedoresCache = null;
    const list = await getProveedores();
    if (!list.length) { cont.innerHTML = '<div class="empty">Sin proveedores con tarifa aún</div>'; return; }
    cont.innerHTML = list.map(p => `
      <div class="tarifa-listado-item">
        <div class="tli-nombre">${esc(p.nombre)}<span class="tli-nif">${esc(p.nif)}</span></div>
        ${p.tarifa_vigente
          ? `<div class="tli-detalle">${p.tarifa_vigente.nombre ? esc(p.tarifa_vigente.nombre) + ' · ' : ''}${p.tarifa_vigente.num_productos} producto(s) · desde ${p.tarifa_vigente.vigente_desde}</div>`
          : `<div class="tli-detalle empty-inline">Sin tarifa vigente</div>`}
        <div class="tli-tolerancia">Tolerancia: ${p.tolerancia_pct}%</div>
      </div>`).join('');
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function refreshTarifasTab() {
  cancelarPreviewTarifas();
  cargarListadoTarifas();
}

function initTarifasTab() {
  const input = document.getElementById('tarifa-archivo-input');
  if (!input) return; // esta página no tiene pestaña de tarifas
  document.getElementById('btn-subir-tarifa').addEventListener('click', () => input.click());
  input.addEventListener('change', () => subirArchivoTarifa(input.files[0]));
}
document.addEventListener('DOMContentLoaded', initTarifasTab);

// ── Comparación de líneas dentro de una factura (pestaña Facturas) ──────
const ESTADO_PRECIO_LABEL = { ok: 'OK', sobreprecio: 'Sobreprecio', bajo_precio: 'Bajo precio', unidad_distinta: 'Unidad distinta', revisar: 'Revisar', sin_tarifa: 'Sin tarifa' };
const ESTADO_PRECIO_BADGE = { ok: 'badge-ok', sobreprecio: 'badge-alert', bajo_precio: 'badge-pend', unidad_distinta: 'badge-pend', revisar: 'badge-alert' };

function renderLineasComparacionHTML(f) {
  const lineas = Array.isArray(f.lineas) ? f.lineas : [];
  if (!lineas.length) return '<div class="empty">Sin desglose de líneas</div>';
  const hayComparacion = lineas.some(l => l.estado_precio && l.estado_precio !== 'sin_tarifa');
  const canCorregir = userRole === 'gestor' || userRole === 'admin';

  const filas = lineas.map(l => {
    const estado = l.estado_precio || 'sin_tarifa';
    const badge = estado === 'sin_tarifa'
      ? '<span class="badge">Sin tarifa</span>'
      : `<span class="badge ${ESTADO_PRECIO_BADGE[estado] || 'badge-pend'}">${ESTADO_PRECIO_LABEL[estado] || estado}</span>`;
    const desviacion = l.desviacion_eur != null
      ? `${l.desviacion_eur > 0 ? '+' : ''}${eur(l.desviacion_eur)} (${l.desviacion_pct > 0 ? '+' : ''}${l.desviacion_pct}%)` : '—';
    const corregir = canCorregir
      ? `<button class="fi-tipo-select-btn" onclick="iniciarCorreccionLinea('${f.id}','${l.id}', this)" title="Corregir emparejamiento">✎</button>` : '';
    const destacada = (estado === 'sobreprecio' || estado === 'revisar') ? 'linea-destacada' : '';
    return `<tr class="${destacada}">
      <td>${esc(l.producto || '—')}</td>
      <td class="num">${l.cantidad != null ? l.cantidad : '—'}</td>
      <td>${esc(l.unidad || '—')}</td>
      <td class="num">${l.precio_unitario != null ? eur(l.precio_unitario) : '—'}</td>
      ${hayComparacion ? `
      <td>${esc(l.producto_tarifa || '—')}</td>
      <td class="num">${l.precio_pactado != null ? eur(l.precio_pactado) : '—'}</td>
      <td class="num">${desviacion}</td>
      <td>${badge}</td>
      <td id="corregir-cell-${l.id}">${corregir}</td>` : ''}
    </tr>`;
  }).join('');

  return `<table class="lineas-table">
    <thead><tr>
      <th>Producto</th><th class="num">Cant.</th><th>Ud.</th><th class="num">Precio ud.</th>
      ${hayComparacion ? '<th>Producto tarifa</th><th class="num">Pactado</th><th class="num">Desviación</th><th>Estado</th><th></th>' : ''}
    </tr></thead>
    <tbody>${filas}</tbody>
  </table>`;
}

function toggleLineasFactura(id) {
  const cont = document.getElementById(`fi-lineas-${id}`);
  if (!cont) return;
  if (cont.classList.contains('hidden')) {
    if (!cont.dataset.rendered) {
      const f = facturas.find(x => String(x.id) === String(id));
      if (f) { cont.innerHTML = renderLineasComparacionHTML(f); cont.dataset.rendered = '1'; }
    }
    cont.classList.remove('hidden');
  } else {
    cont.classList.add('hidden');
  }
}

async function iniciarCorreccionLinea(facturaId, lineaId, btnEl) {
  const f = facturas.find(x => String(x.id) === String(facturaId));
  if (!f) return;
  btnEl.disabled = true;
  try {
    const proveedor = await buscarProveedorPorNif(f.cif_proveedor);
    if (!proveedor || !proveedor.tarifa_vigente) { alert('Este proveedor no tiene tarifa vigente'); return; }
    const detalle = await (await apiFetch(`/tarifas/${proveedor.id}`)).json();
    const productos = detalle.tarifa_productos || [];
    document.getElementById(`corregir-cell-${lineaId}`).innerHTML = `
      <select class="fi-tipo-select" onchange="confirmarCorreccionLinea('${facturaId}','${lineaId}', this)">
        <option value="">Elegir producto…</option>
        ${productos.map(p => `<option value="${esc(p.producto)}">${esc(p.producto)} (${esc(p.unidad)} · ${eur(p.precio)})</option>`).join('')}
      </select>`;
  } catch (e) {
    alert(e.message);
  } finally {
    btnEl.disabled = false;
  }
}

async function confirmarCorreccionLinea(facturaId, lineaId, selectEl) {
  const productoTarifa = selectEl.value;
  if (!productoTarifa) return;
  selectEl.disabled = true;
  try {
    const r = await apiFetch(`/facturas/${facturaId}/lineas/${lineaId}/emparejar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ producto_tarifa: productoTarifa }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo corregir el emparejamiento');
    const f = facturas.find(x => String(x.id) === String(facturaId));
    if (f) {
      const idx = f.lineas.findIndex(l => String(l.id) === String(lineaId));
      if (idx >= 0) f.lineas[idx] = { ...f.lineas[idx], ...d.linea };
      const cont = document.getElementById(`fi-lineas-${facturaId}`);
      if (cont) cont.innerHTML = renderLineasComparacionHTML(f);
    }
  } catch (e) {
    alert(e.message);
  }
}

// ── Bloque "Sobreprecio del mes" (pestaña Análisis) ─────────────────────
async function refreshSobreprecios() {
  const cont = document.getElementById('sobreprecios-block');
  if (!cont) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const data = await (await apiFetch('/analytics/sobreprecios')).json();
    if (!data.total_sobreprecio_eur) { cont.innerHTML = '<div class="empty">Sin sobreprecios detectados</div>'; return; }
    cont.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="card-row"><span>Sobreprecio total</span><strong>${eur(data.total_sobreprecio_eur)}</strong></div>
      </div>
      <p class="section-title" style="margin-top:0">Por proveedor</p>
      <div class="card">${data.por_proveedor.map(p => `
        <div class="mes-item"><div class="mes-info"><div class="mes-label">${esc(p.proveedor)}</div></div><div class="rank-total">${eur(p.total)}</div></div>`).join('')}</div>
      <p class="section-title">Por producto</p>
      <div class="card">${data.por_producto.map(p => `
        <div class="mes-item"><div class="mes-info"><div class="mes-label">${esc(p.producto)}</div></div><div class="rank-total">${eur(p.total)}</div></div>`).join('')}</div>
      <p class="section-title">Facturas afectadas</p>
      <div class="card">${data.facturas_afectadas.map(f => `
        <div class="mes-item sobreprecio-link" onclick="irAFactura('${f.id}')">
          <div class="mes-info"><div class="mes-label">${esc(f.proveedor)}</div><div class="mes-count">${f.fecha_factura ? f.fecha_factura.slice(0,10) : ''}</div></div>
          <div class="rank-total">${eur(f.total_sobreprecio_eur)}</div>
        </div>`).join('')}</div>`;
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function irAFactura(facturaId) {
  switchTab('facturas');
  setTimeout(() => {
    const el = document.querySelector(`[data-factura-id="${facturaId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash-highlight');
    setTimeout(() => el.classList.remove('flash-highlight'), 2000);
  }, 150); // deja tiempo a que switchTab()->refreshFacturas() pinte la lista
}
