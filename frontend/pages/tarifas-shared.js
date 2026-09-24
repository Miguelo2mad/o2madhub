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
    .tarifa-productos-table td.chk { width: 22px; }
    .tarifa-resumen-compras { font-size: 12px; color: var(--accent); margin: 2px 0 10px; }
    .tarifa-no-comprados { margin-top: 10px; border-top: 1px dashed var(--border); padding-top: 8px; }
    .tarifa-no-comprados summary { cursor: pointer; font-size: 12px; color: var(--muted); display: flex; align-items: center; justify-content: space-between; gap: 8px; list-style: none; }
    .tarifa-no-comprados summary::-webkit-details-marker { display: none; }
    .btn-marcar-todos { background: transparent; border: 1px solid var(--border); color: var(--accent); border-radius: 8px; padding: 4px 8px; font-size: 11px; cursor: pointer; }
    .tarifa-proveedor-elegido, .tarifa-proveedor-nuevo { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; align-items: start; margin-bottom: 8px; }
    .tarifa-proveedor-elegido .field, .tarifa-proveedor-nuevo .field { margin-bottom: 0; }
    .tarifa-proveedor-elegido select { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 13px; padding: 7px 9px; }
    .tarifa-proveedor-elegido input[readonly] { opacity: .7; }
    .tarifa-proveedor-toggle { grid-column: 1 / -1; font-size: 11px; color: var(--accent); text-decoration: none; }
    .tarifa-sugerencia { font-size: 10.5px; color: var(--accent); margin-top: 3px; }
    .tarifa-unir-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: rgba(217,164,65,.08); border: 1px solid rgba(217,164,65,.3); border-radius: 12px; padding: 10px 12px; margin-bottom: 14px; font-size: 12px; color: var(--ambar); }
    .tarifa-unir-bar button { flex-shrink: 0; }

    .tarifa-listado-item { padding: 12px 0; border-bottom: 1px solid var(--border); }
    .tarifa-listado-item:last-child { border-bottom: none; }
    .tli-nombre { font-weight: 600; font-size: 14px; }
    .tli-nif { font-weight: 400; font-size: 11px; color: var(--muted); margin-left: 6px; }
    .tli-detalle { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .tli-detalle.empty-inline { color: var(--alert); }
    .tli-tolerancia { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .tli-cabecera { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; cursor: pointer; }
    .tli-chevron { color: var(--muted); font-size: 12px; flex-shrink: 0; margin-top: 2px; }
    .tli-origen { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .tli-origen a { color: var(--accent); }
    .tli-origen-vacio { font-style: italic; }
    .tarifa-detalle-proveedor { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border); }
    .tarifa-detalle-tabla { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 10px; }
    .tarifa-detalle-tabla th { text-align: left; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .5px; font-size: 10px; padding: 4px 6px; border-bottom: 1px solid var(--border); }
    .tarifa-detalle-tabla td { padding: 4px 6px; border-bottom: 1px solid var(--border); }
    .tarifa-detalle-acciones { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .tarifa-detalle-acciones select { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 12px; padding: 6px 8px; }
    .tarifa-btn-peligro { border-color: var(--alert); color: var(--alert); }

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

function leerArchivoComoBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
    reader.readAsDataURL(file);
  });
}

// La respuesta de /tarifas/importar es NDJSON (una línea JSON por evento),
// no un único JSON — un PDF largo se trocea en varias llamadas a Claude
// (backend/lib/tarifas.js extraerProductosDePdf) y hay que ir mostrando
// "Leyendo páginas X-Y de Z" mientras llegan, no solo al final. Los
// errores también van como línea NDJSON: la cabecera 200 ya se mandó con
// la primera línea, antes de saber si algo falla a mitad.
async function leerImportacionTarifasNdjson(r, onProgreso) {
  if (!r.body || !r.body.getReader) {
    // Navegador sin streams body (rarísimo hoy): se lee todo de golpe.
    const d = await r.json();
    if (d.tipo === 'error') throw new Error(d.error || 'No se pudo procesar el archivo');
    return d;
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let resultado = null;
  let errorMsg = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let salto;
    while ((salto = buffer.indexOf('\n')) >= 0) {
      const linea = buffer.slice(0, salto).trim();
      buffer = buffer.slice(salto + 1);
      if (!linea) continue;
      const evento = JSON.parse(linea);
      if (evento.tipo === 'progreso') onProgreso(evento.mensaje);
      else if (evento.tipo === 'resultado') resultado = evento;
      else if (evento.tipo === 'error') errorMsg = evento.error;
    }
  }
  if (errorMsg) throw new Error(errorMsg);
  if (!resultado) throw new Error('No se pudo procesar el archivo');
  return resultado;
}

async function subirArchivoTarifa(file) {
  if (!file) return;
  const status = document.getElementById('tarifas-upload-status');
  status.classList.remove('hidden');
  status.textContent = 'Analizando archivo…';
  try {
    const fd = new FormData();
    fd.append('archivo', file);
    const r = await apiFetch('/tarifas/importar', { method: 'POST', body: fd });
    const d = await leerImportacionTarifasNdjson(r, (mensaje) => { status.textContent = mensaje; });
    status.classList.add('hidden');
    // El propio File ya está en memoria desde que el usuario lo eligió —
    // se guarda tal cual para reenviarlo en base64 al confirmar (trazabilidad
    // del origen: sube a Drive ahí, no hace falta que el backend lo devuelva).
    d.archivoOriginal = file;
    renderPreview(d);
  } catch (e) {
    status.classList.add('hidden');
    alert(e.message);
  }
}

// Prioridad visual: dudas primero, luego los grupos sin proveedor elegido,
// por último el resto — el usuario tiene que ver de un vistazo qué necesita
// su atención antes de confirmar, si no confirma sin mirar.
function renderPreview(preview) {
  previewState = preview;
  previewState.proveedores_facturados = preview.proveedores_facturados || [];
  const hayProveedoresFacturados = previewState.proveedores_facturados.length > 0;

  for (const g of previewState.grupos) {
    // Sin comprobar aún contra las facturas del proveedor elegido (eso
    // llega al fijar uno, ver verificarComprasProveedor): todo marcado por
    // defecto, igual que el comportamiento de siempre.
    for (const p of (g.productos || [])) if (p.importar === undefined) p.importar = true;

    g.nif = '';
    g.nombre = g.proveedor_detectado || '';
    g.proveedor_nif_norm = '';
    g.sugerencia_label = null;
    // Sin ningún proveedor facturado todavía en este cliente, el
    // desplegable no serviría de nada — se entra directo en modo "proveedor
    // nuevo" con NIF/nombre editables, como el comportamiento de siempre.
    g.modo_nuevo = !hayProveedoresFacturados;

    if (g.sugerencia) {
      const elegido = previewState.proveedores_facturados.find(p => p.nif_norm === g.sugerencia.nif_norm);
      if (elegido) {
        g.nif = elegido.nif;
        g.nombre = elegido.nombre;
        g.proveedor_nif_norm = elegido.nif_norm;
        if (g.sugerencia.tipo === 'productos') {
          g.sugerencia_label = `Sugerido: coincide con ${g.sugerencia.coincidencias} producto${g.sugerencia.coincidencias !== 1 ? 's' : ''} de sus facturas`;
        }
      }
    }
  }

  const ordenGrupos = preview.grupos
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (a.g.nif ? 1 : 0) - (b.g.nif ? 1 : 0));

  document.getElementById('tarifas-preview').innerHTML = `
    ${renderDudasBlock(preview.dudas)}
    ${renderUnirProveedoresBar()}
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

// Un archivo debería dar un proveedor por defecto (ver TARIFA_IMPORT_PROMPT
// en backend/lib/tarifas.js); si aun así la IA detectó varios bloques —
// normalmente porque confundió una marca dentro del nombre de un producto
// con el proveedor — este botón los fusiona en uno y deja elegir cuál es.
function renderUnirProveedoresBar() {
  if (!previewState.grupos || previewState.grupos.length <= 1) return '';
  return `<div class="tarifa-unir-bar">
    <span>Se han detectado ${previewState.grupos.length} proveedores distintos en este archivo.</span>
    <button type="button" class="tarifa-btn-secondary" onclick="unirTodosLosProveedores()">Unir todo en un proveedor</button>
  </div>`;
}

function unirTodosLosProveedores() {
  if (!previewState.grupos || previewState.grupos.length <= 1) return;
  previewState.grupos = [{
    hoja: null,
    proveedor_detectado: null,
    productos: previewState.grupos.flatMap(g => g.productos),
    sugerencia: null,
  }];
  renderPreview(previewState);
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
  const sinProveedor = !g.nif;
  const productos = g.productos || [];
  const conIndice = productos.map((p, j) => ({ p, j }));
  const comprados = conIndice.filter(({ p }) => p.importar !== false);
  const noComprados = conIndice.filter(({ p }) => p.importar === false);

  return `<div class="tarifa-grupo-card ${sinProveedor ? 'sin-proveedor' : ''}" id="grupo-card-${i}">
    <div class="tarifa-grupo-header">
      ${sinProveedor ? '<span class="badge badge-alert">❓ Elige un proveedor</span>' : ''}
      ${g.hoja ? `<span class="tarifa-hoja-tag">Hoja: ${esc(g.hoja)}</span>` : ''}
      ${renderCampoProveedor(g, i)}
      <div class="tarifa-grupo-fields">
        <div class="field"><label>Nombre tarifa (opcional)</label><input type="text" placeholder="Temporada 2027" value="${esc(g.nombre_tarifa || '')}" oninput="actualizarGrupoCampo(${i}, 'nombre_tarifa', this.value)"></div>
        <div class="field"><label>Vigente desde</label><input type="date" value="${g.vigente_desde || new Date().toISOString().slice(0,10)}" oninput="actualizarGrupoCampo(${i}, 'vigente_desde', this.value)"></div>
      </div>
    </div>
    ${g.tiene_historial ? `<div class="tarifa-resumen-compras">${comprados.length} producto${comprados.length !== 1 ? 's' : ''} de ${productos.length} coinciden con tus facturas</div>` : ''}
    <table class="tarifa-productos-table">
      <thead><tr><th></th><th>Producto</th><th>Unidad</th><th class="num">Precio</th><th>Notas</th><th></th></tr></thead>
      <tbody>${comprados.map(({ p, j }) => renderProductoRow(i, j, p)).join('')}</tbody>
    </table>
    <button class="btn-add-producto" onclick="agregarProducto(${i})">+ Añadir producto</button>
    ${noComprados.length ? renderNoCompradosBlock(i, noComprados) : ''}
  </div>`;
}

// Desplegable con los proveedores ya facturados por el cliente (nombre +
// NIF, sacados de cif_proveedor/proveedor en ${cliente}_facturas — ver
// backend/lib/tarifas.js datosProveedoresFacturados), o el par NIF/nombre
// editable de siempre para un proveedor nuevo sin facturas todavía.
function renderCampoProveedor(g, i) {
  if (g.modo_nuevo) {
    return `<div class="tarifa-proveedor-nuevo">
      <div class="field"><label>NIF *</label><input type="text" placeholder="B12345678" value="${esc(g.nif || '')}" oninput="actualizarGrupoCampo(${i}, 'nif', this.value)" onchange="verificarComprasProveedor(${i})"></div>
      <div class="field"><label>Nombre proveedor</label><input type="text" value="${esc(g.nombre || '')}" oninput="actualizarGrupoCampo(${i}, 'nombre', this.value)"></div>
      ${(previewState.proveedores_facturados || []).length
        ? `<a href="#" class="tarifa-proveedor-toggle" onclick="event.preventDefault(); volverAListaProveedores(${i})">← Elegir de la lista de proveedores facturados</a>`
        : ''}
    </div>`;
  }

  const opciones = previewState.proveedores_facturados || [];
  return `<div class="tarifa-proveedor-elegido">
    <div class="field">
      <label>Proveedor *</label>
      <select onchange="elegirProveedor(${i}, this.value)">
        <option value="" ${!g.proveedor_nif_norm ? 'selected' : ''}>Elegir proveedor…</option>
        ${opciones.map(p => `<option value="${esc(p.nif_norm)}" ${p.nif_norm === g.proveedor_nif_norm ? 'selected' : ''}>${esc(p.nombre)} (${esc(p.nif)})</option>`).join('')}
      </select>
      ${g.sugerencia_label ? `<div class="tarifa-sugerencia">${esc(g.sugerencia_label)}</div>` : ''}
    </div>
    <div class="field"><label>NIF</label><input type="text" value="${esc(g.nif || '')}" readonly></div>
    <a href="#" class="tarifa-proveedor-toggle" onclick="event.preventDefault(); activarProveedorNuevo(${i})">Es un proveedor nuevo</a>
  </div>`;
}

function renderProductoRow(i, j, p) {
  return `<tr>
    <td class="chk"><input type="checkbox" ${p.importar !== false ? 'checked' : ''} onchange="toggleImportarProducto(${i},${j},this.checked)" title="Importar este producto"></td>
    <td><input type="text" value="${esc(p.producto || '')}" oninput="actualizarProducto(${i},${j},'producto',this.value)"></td>
    <td><input type="text" value="${esc(p.unidad || '')}" oninput="actualizarProducto(${i},${j},'unidad',this.value)"></td>
    <td class="num"><input type="number" step="0.0001" value="${p.precio ?? ''}" oninput="actualizarProducto(${i},${j},'precio',this.value)"></td>
    <td><input type="text" value="${esc(p.notas || '')}" oninput="actualizarProducto(${i},${j},'notas',this.value)"></td>
    <td><button class="fi-delete" onclick="eliminarProducto(${i},${j})" title="Quitar producto">🗑</button></td>
  </tr>`;
}

function renderNoCompradosBlock(i, noComprados) {
  return `<details class="tarifa-no-comprados">
    <summary>No comprados hasta ahora (${noComprados.length})
      <button type="button" class="btn-marcar-todos" onclick="event.preventDefault(); event.stopPropagation(); marcarTodosComprados(${i})">Marcar todos</button>
    </summary>
    <table class="tarifa-productos-table">
      <thead><tr><th></th><th>Producto</th><th>Unidad</th><th class="num">Precio</th><th>Notas</th><th></th></tr></thead>
      <tbody>${noComprados.map(({ p, j }) => renderProductoRow(i, j, p)).join('')}</tbody>
    </table>
  </details>`;
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
  previewState.grupos[i].productos.push({ producto: '', unidad: '', precio: null, notas: '', importar: true });
  document.getElementById(`grupo-card-${i}`).outerHTML = renderGrupoCard(previewState.grupos[i], i);
}
function toggleImportarProducto(i, j, checked) {
  previewState.grupos[i].productos[j].importar = checked;
  document.getElementById(`grupo-card-${i}`).outerHTML = renderGrupoCard(previewState.grupos[i], i);
}
function marcarTodosComprados(i) {
  for (const p of previewState.grupos[i].productos) p.importar = true;
  document.getElementById(`grupo-card-${i}`).outerHTML = renderGrupoCard(previewState.grupos[i], i);
}

// Elegir un proveedor del desplegable: rellena NIF (de solo lectura) y
// nombre, y relanza la comprobación de qué productos ya se le han comprado
// a ESE proveedor exacto (no al sugerido, si eran distintos).
function elegirProveedor(i, nifNorm) {
  const grupo = previewState.grupos[i];
  const elegido = (previewState.proveedores_facturados || []).find(p => p.nif_norm === nifNorm);
  grupo.proveedor_nif_norm = elegido ? elegido.nif_norm : '';
  grupo.nif = elegido ? elegido.nif : '';
  grupo.nombre = elegido ? elegido.nombre : (grupo.proveedor_detectado || '');
  grupo.sugerencia_label = null;
  document.getElementById(`grupo-card-${i}`).outerHTML = renderGrupoCard(grupo, i);
  if (elegido) verificarComprasProveedor(i);
}

// "Es un proveedor nuevo": vuelve a NIF/nombre editables para un proveedor
// sin facturas todavía. Conserva lo que hubiera como punto de partida.
function activarProveedorNuevo(i) {
  const grupo = previewState.grupos[i];
  grupo.modo_nuevo = true;
  grupo.proveedor_nif_norm = '';
  grupo.sugerencia_label = null;
  document.getElementById(`grupo-card-${i}`).outerHTML = renderGrupoCard(grupo, i);
}

function volverAListaProveedores(i) {
  const grupo = previewState.grupos[i];
  grupo.modo_nuevo = false;
  document.getElementById(`grupo-card-${i}`).outerHTML = renderGrupoCard(grupo, i);
}

// Al fijar (blur/commit) el NIF de un grupo: cruza sus productos contra las
// facturas ya subidas de ese proveedor (backend/lib/tarifas.js
// verificarProductosComprados — normalizarTextoProducto + coincidencia
// parcial de palabras) y marca por defecto qué importar. Fallo silencioso:
// es una ayuda para no partir de cero, nunca debe bloquear la importación.
async function verificarComprasProveedor(i) {
  const grupo = previewState.grupos[i];
  if (!grupo) return;
  const nif = (grupo.nif || '').trim();
  if (!normalizarNifClient(nif)) return;
  const nombres = grupo.productos.map(p => p.producto).filter(Boolean);
  if (!nombres.length) return;
  try {
    const r = await apiFetch('/tarifas/comprados', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nif, productos: nombres }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo comprobar las compras de este proveedor');
    grupo.tiene_historial = d.tiene_historial;
    let k = 0;
    for (const p of grupo.productos) {
      if (!p.producto) continue;
      p.importar = d.tiene_historial ? !!d.resultado[k]?.comprado : true;
      k++;
    }
    document.getElementById(`grupo-card-${i}`).outerHTML = renderGrupoCard(grupo, i);
  } catch (e) {
    console.error('[tarifas] verificarComprasProveedor:', e.message);
  }
}

async function confirmarTarifasUI() {
  // Confirmar importa solo los productos marcados (checkbox por fila; "No
  // comprados hasta ahora" empieza desmarcado salvo que el proveedor no
  // tenga historial todavía, ver verificarComprasProveedor).
  const grupos = previewState.grupos
    .map(g => ({ ...g, productos: g.productos.filter(p => p.importar !== false) }))
    .filter(g => g.productos.length > 0);
  // Un bloque solo se confirma con un proveedor elegido (desplegable o
  // modo "proveedor nuevo" con NIF puesto) — se avisa de TODOS los que
  // faltan de una vez, no solo del primero.
  const faltantes = grupos.filter(g => !g.nif || !g.nif.trim());
  if (faltantes.length) {
    const nombres = faltantes.map(g => g.nombre || g.proveedor_detectado || g.hoja || '(sin nombre)').join(', ');
    alert(`Elige un proveedor para: ${nombres}`);
    return;
  }
  const btn = document.getElementById('btn-confirmar-tarifas');
  btn.disabled = true;
  try {
    // Trazabilidad del origen: el archivo se queda en memoria desde
    // /importar (previewState.archivoOriginal) y se lee a base64 solo aquí,
    // al confirmar — el backend lo sube a Drive y enlaza su id a la tarifa.
    let archivo_base64 = null, archivo_mime = null;
    if (previewState.archivoOriginal) {
      archivo_base64 = await leerArchivoComoBase64(previewState.archivoOriginal);
      archivo_mime = previewState.archivoOriginal.type;
    }
    const r = await apiFetch('/tarifas/confirmar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origen_archivo: previewState.origen_archivo, grupos, archivo_base64, archivo_mime }),
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

const TARIFA_ORIGEN_TIPO_LABEL = { xlsx: 'Excel', csv: 'CSV', pdf: 'PDF', imagen: 'Foto' };

// Debajo de cada proveedor: nombre del archivo de origen con enlace a
// Drive y su tipo, o "Origen no registrado" para tarifas importadas antes
// de que existiera esta trazabilidad (origen_drive_id null).
function renderOrigenTarifa(t) {
  if (!t.origen_drive_id) return '<div class="tli-origen tli-origen-vacio">Origen no registrado</div>';
  const tipoLabel = TARIFA_ORIGEN_TIPO_LABEL[t.origen_tipo] || '';
  const nombre = esc(t.origen_archivo || '(archivo sin nombre)');
  return `<div class="tli-origen">
    <a href="https://drive.google.com/file/d/${esc(t.origen_drive_id)}/view" target="_blank" rel="noopener">${nombre}</a>${tipoLabel ? ` · ${tipoLabel}` : ''}
  </div>`;
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
        <div class="tli-cabecera" onclick="toggleDetalleProveedor(${p.id})">
          <div>
            <div class="tli-nombre">${esc(p.nombre)}<span class="tli-nif">${esc(p.nif)}</span></div>
            ${p.tarifa_vigente
              ? `<div class="tli-detalle">${p.tarifa_vigente.nombre ? esc(p.tarifa_vigente.nombre) + ' · ' : ''}${p.tarifa_vigente.num_productos} producto(s) · desde ${p.tarifa_vigente.vigente_desde}</div>`
              : `<div class="tli-detalle empty-inline">Sin tarifa vigente</div>`}
            ${p.tarifa_vigente ? renderOrigenTarifa(p.tarifa_vigente) : ''}
            <div class="tli-tolerancia">Tolerancia: ${p.tolerancia_pct}%</div>
          </div>
          ${p.tarifa_vigente ? '<span class="tli-chevron">▾</span>' : ''}
        </div>
        ${p.tarifa_vigente ? `<div class="tarifa-detalle-proveedor hidden" id="tarifa-detalle-${p.id}"></div>` : ''}
      </div>`).join('');
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ── Detalle de un proveedor: productos + cambiar de proveedor + eliminar ──
async function toggleDetalleProveedor(id) {
  const cont = document.getElementById(`tarifa-detalle-${id}`);
  if (!cont) return; // proveedor sin tarifa vigente, no hay detalle que abrir
  if (!cont.classList.contains('hidden')) { cont.classList.add('hidden'); return; }
  document.querySelectorAll('.tarifa-detalle-proveedor').forEach(el => el.classList.add('hidden'));
  cont.classList.remove('hidden');
  if (cont.dataset.cargado) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const r = await apiFetch(`/tarifas/${id}`);
    const detalle = await r.json();
    if (!r.ok) throw new Error(detalle.error || 'No se pudo cargar el detalle');
    const otros = (await getProveedores()).filter(p => p.id !== id);
    cont.innerHTML = renderDetalleProveedor(id, detalle, otros);
    cont.dataset.cargado = '1';
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderDetalleProveedor(id, detalle, otrosProveedores) {
  const productos = detalle.tarifa_productos || [];
  return `
    <table class="tarifa-detalle-tabla">
      <thead><tr><th>Producto</th><th>Unidad</th><th class="num">Precio</th></tr></thead>
      <tbody>${productos.map(p => `<tr><td>${esc(p.producto)}</td><td>${esc(p.unidad)}</td><td class="num">${eur(p.precio)}</td></tr>`).join('')}</tbody>
    </table>
    <div class="tarifa-detalle-acciones">
      <select id="reasignar-select-${id}">
        <option value="">Reasignar a…</option>
        ${otrosProveedores.map(p => `<option value="${p.id}">${esc(p.nombre)} (${esc(p.nif)})</option>`).join('')}
      </select>
      <button type="button" class="tarifa-btn-secondary" onclick="cambiarProveedorTarifa(${id})">Cambiar de proveedor</button>
      <button type="button" class="tarifa-btn-secondary tarifa-btn-peligro" onclick="eliminarTarifaProveedorUI(${id})">Eliminar tarifa</button>
    </div>
  `;
}

async function cambiarProveedorTarifa(id) {
  const select = document.getElementById(`reasignar-select-${id}`);
  const nuevoId = select?.value;
  if (!nuevoId) { alert('Elige a qué proveedor reasignar la tarifa'); return; }
  if (!confirm('¿Reasignar esta tarifa al proveedor elegido? Se borrarán sus alias de emparejamiento y se recalcularán las facturas afectadas de ambos proveedores.')) return;
  try {
    const r = await apiFetch(`/tarifas/${id}/reasignar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nuevo_proveedor_id: Number(nuevoId) }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo reasignar la tarifa');
    alert(`Tarifa reasignada a ${d.proveedor_nuevo_nif}. ${d.facturas_recalculadas} factura(s) recalculada(s).`);
    proveedoresCache = null;
    cargarListadoTarifas();
  } catch (e) {
    alert(e.message);
  }
}

async function eliminarTarifaProveedorUI(id) {
  if (!confirm('¿Eliminar esta tarifa? Se borran sus productos y sus alias de emparejamiento, y sus facturas quedarán sin tarifa.')) return;
  try {
    const r = await apiFetch(`/tarifas/${id}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo eliminar la tarifa');
    alert(`Tarifa eliminada. ${d.facturas_actualizadas} factura(s) actualizada(s).`);
    proveedoresCache = null;
    cargarListadoTarifas();
  } catch (e) {
    alert(e.message);
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
