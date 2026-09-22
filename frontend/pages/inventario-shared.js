// Inventario estimado (pestaña Inventario) — componente compartido entre
// timbol.html y comarea.html, mismo patrón que ventas-shared.js/
// tarifas-shared.js: script clásico apoyado en los globals de cada página
// (apiFetch, esc). Usa delegación de eventos (un único listener en
// document) en vez de onclick inline con el nombre del ingrediente
// interpolado en el string — ingrediente_norm no quita apóstrofes
// (normalizarTextoProducto solo quita acentos y colapsa espacios), así que
// interpolarlo dentro de un onclick="...('...')" podría romper el atributo.

// ── Estilos ──────────────────────────────────────────────────────────────
(function injectInventarioStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .inventario-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; padding: 10px 0; border-top: 1px solid var(--border); }
    .inventario-row:first-child { border-top: none; padding-top: 0; }
    .inventario-nombre { font-size: 13.5px; font-weight: 600; }
    .inventario-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .inventario-meta a { color: var(--accent); margin-left: 6px; }
    .inventario-stock { font-size: 15px; font-weight: 700; text-align: right; white-space: nowrap; }
    .inventario-stock.negativo { color: var(--alert); }
    .inventario-badge { display: inline-block; margin-left: 6px; font-size: 10px; border-radius: 6px; padding: 2px 6px; vertical-align: middle; }
    .inventario-badge-alert { background: rgba(217,107,82,.15); color: var(--alert); }
    .inventario-badge-muted { background: var(--surface2); color: var(--muted); }
    .inventario-ajustar-form { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    .inventario-ajustar-form input { flex: 1 1 100px; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; color: var(--text); font-size: 12.5px; }
  `;
  document.head.appendChild(style);
})();

let inventarioData = null;
let inventarioAjustandoNorm = null; // ingrediente_norm con el formulario de ajuste abierto, o null

const numFmtInv = (n) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(Number(n) || 0);

async function refreshInventarioTab() {
  const cont = document.getElementById('inventario-list');
  if (!cont) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const r = await apiFetch('/inventario');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo cargar el inventario');
    inventarioData = d;
    renderInventario();
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderInventario() {
  const cont = document.getElementById('inventario-list');
  if (!cont) return;
  const ingredientes = inventarioData?.ingredientes || [];
  if (!ingredientes.length) {
    cont.innerHTML = '<div class="empty">Sin ingredientes con escandallo o compras registradas todavía.</div>';
    return;
  }
  cont.innerHTML = `<div class="card">${ingredientes.map(renderInventarioRow).join('')}</div>`;
}

function renderInventarioRow(ing) {
  const negativo = ing.stock_estimado < 0;
  const norm = esc(ing.ingrediente_norm);
  const badges = [
    negativo ? '<span class="inventario-badge inventario-badge-alert">Stock negativo</span>' : '',
    ing.unidad_conflicto ? '<span class="inventario-badge inventario-badge-alert">Unidad no coincide</span>' : '',
    !ing.tiene_escandallo ? '<span class="inventario-badge inventario-badge-muted">Sin receta</span>' : '',
  ].join('');

  return `
    <div class="inventario-row">
      <div style="flex:1">
        <div class="inventario-nombre">${esc(ing.ingrediente)}${badges}</div>
        <div class="inventario-meta">
          Compras ${numFmtInv(ing.compras)} ${esc(ing.unidad)} · Consumo 7d ${numFmtInv(ing.consumo_7d)} · 30d ${numFmtInv(ing.consumo_30d)} · desde ${esc(ing.fecha_inicial)}
          <a href="#" class="inventario-toggle-ajuste" data-norm="${norm}">Ajustar</a>
        </div>
        ${inventarioAjustandoNorm === ing.ingrediente_norm ? renderFormAjuste(ing) : ''}
      </div>
      <div class="inventario-stock ${negativo ? 'negativo' : ''}">${numFmtInv(ing.stock_estimado)} ${esc(ing.unidad)}</div>
    </div>
  `;
}

function renderFormAjuste(ing) {
  const norm = esc(ing.ingrediente_norm);
  return `
    <div class="inventario-ajustar-form">
      <input type="number" step="0.01" class="inventario-input-cantidad" data-norm="${norm}" placeholder="Cantidad contada" value="${ing.stock_estimado}">
      <input type="date" class="inventario-input-fecha" data-norm="${norm}" value="${new Date().toISOString().slice(0, 10)}">
      <button type="button" class="btn-drive inventario-guardar-ajuste" data-norm="${norm}">Guardar</button>
    </div>
  `;
}

function toggleAjusteInventario(ingredienteNorm) {
  inventarioAjustandoNorm = inventarioAjustandoNorm === ingredienteNorm ? null : ingredienteNorm;
  renderInventario();
}

async function confirmarAjusteInventario(ingredienteNorm) {
  const ing = inventarioData?.ingredientes.find(i => i.ingrediente_norm === ingredienteNorm);
  if (!ing) return;
  const cantidadEl = document.querySelector(`.inventario-input-cantidad[data-norm="${CSS.escape(ingredienteNorm)}"]`);
  const fechaEl = document.querySelector(`.inventario-input-fecha[data-norm="${CSS.escape(ingredienteNorm)}"]`);
  const cantidad = cantidadEl.value;
  if (cantidad === '') { alert('Falta la cantidad contada'); return; }
  try {
    const r = await apiFetch('/inventario/ajustar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ingrediente: ing.ingrediente,
        unidad: ing.unidad,
        cantidad_inicial: Number(cantidad),
        fecha_inicial: fechaEl.value || undefined,
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo ajustar el stock');
    inventarioAjustandoNorm = null;
    await refreshInventarioTab();
  } catch (e) {
    alert(e.message);
  }
}

// Delegación: las filas se re-renderizan por completo en cada refresh/toggle,
// así que un listener por elemento se perdería — uno solo en document, que
// vive mientras dure la página.
document.addEventListener('click', (e) => {
  const toggleBtn = e.target.closest('.inventario-toggle-ajuste');
  if (toggleBtn) { e.preventDefault(); toggleAjusteInventario(toggleBtn.dataset.norm); return; }
  const guardarBtn = e.target.closest('.inventario-guardar-ajuste');
  if (guardarBtn) { confirmarAjusteInventario(guardarBtn.dataset.norm); }
});
