// Banco — componente compartido entre timbol.html y comarea.html, mismo
// patrón que ventas-shared.js/inventario-shared.js: script clásico apoyado
// en los globals de cada página (apiFetch, esc, eur). Los IDs que se pasan
// por los onclick son siempre numéricos (movimiento/factura/venta.id), así
// que a diferencia de inventario-shared.js no hace falta delegación de
// eventos para evitar romper el atributo.

// ── Estilos ──────────────────────────────────────────────────────────────
(function injectBancoStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .banco-duda-card { background: rgba(217,164,65,.08); border: 1px solid rgba(217,164,65,.3); border-radius: 12px; padding: 10px 12px; margin-bottom: 12px; font-size: 12px; }
    .banco-duda-titulo { font-weight: 600; color: var(--ambar); margin-bottom: 6px; }
    .banco-duda-row { padding: 4px 0; border-top: 1px solid rgba(217,164,65,.2); }
    .banco-duda-row:first-child { border-top: none; }
    .banco-duda-motivo { color: var(--muted); }

    .banco-preview-table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-bottom: 10px; }
    .banco-preview-table th { text-align: left; font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; padding-bottom: 6px; }
    .banco-preview-table td { padding: 4px 4px 4px 0; border-top: 1px solid var(--border); }
    .banco-preview-table input { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 5px 7px; color: var(--text); font-size: 12px; box-sizing: border-box; }
    .banco-preview-table td.num input { text-align: right; }

    .banco-confirmar-bar { display: flex; gap: 8px; margin: 12px 0 20px; }
    .banco-btn-secundario { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 8px 14px; color: var(--text); font-size: 13px; cursor: pointer; }

    .banco-mov-row { padding: 10px 0; border-top: 1px solid var(--border); }
    .banco-mov-row:first-child { border-top: none; }
    .banco-mov-linea1 { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .banco-mov-concepto { font-size: 13px; font-weight: 600; }
    .banco-mov-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .banco-mov-meta a { color: var(--accent); margin-left: 6px; }
    .banco-mov-importe { font-size: 14px; font-weight: 700; white-space: nowrap; }
    .banco-mov-importe.negativo { color: var(--alert); }
    .banco-mov-importe.positivo { color: var(--ok); }
    .banco-conciliar-form { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
    .banco-conciliar-form select { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; color: var(--text); font-size: 12px; }
  `;
  document.head.appendChild(style);
})();

let bancoPreviewState = null;
let bancoConciliandoId = null;
let bancoMovimientos = [];

// ── Resumen ──────────────────────────────────────────────────────────────
async function refreshResumenBanco() {
  const cont = document.getElementById('banco-resumen-block');
  if (!cont) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const mes = new Date().toISOString().slice(0, 7);
    const r = await apiFetch(`/analytics/banco-resumen?mes=${mes}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo cargar el resumen');
    cont.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-label">Ingresos (mes)</div><div class="kpi-value" style="color:var(--ok)">${eur(d.total_ingresos)}</div></div>
        <div class="kpi-card"><div class="kpi-label">Gastos (mes)</div><div class="kpi-value" style="color:var(--alert)">${eur(d.total_gastos)}</div></div>
        <div class="kpi-card"><div class="kpi-label">Saldo</div><div class="kpi-value">${d.saldo_final != null ? eur(d.saldo_final) : '—'}</div></div>
        <div class="kpi-card"><div class="kpi-label">Conciliado</div><div class="kpi-value kpi-accent">${d.pct_conciliado != null ? d.pct_conciliado + '%' : '—'}</div></div>
      </div>
    `;
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ── Listado ──────────────────────────────────────────────────────────────
async function refreshListadoBanco() {
  const cont = document.getElementById('banco-listado');
  if (!cont) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const estado = document.getElementById('banco-filtro-estado')?.value || 'todos';
    const qs = estado !== 'todos' ? `?estado=${estado}` : '';
    const r = await apiFetch(`/banco${qs}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo cargar el listado');
    bancoMovimientos = d;
    if (!d.length) { cont.innerHTML = '<div class="empty">Sin movimientos</div>'; return; }
    cont.innerHTML = `<div class="card">${d.map(renderMovimientoRow).join('')}</div>`;
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderMovimientoRow(m) {
  const negativo = Number(m.importe) < 0;
  const badge = m.conciliado
    ? `<span class="badge badge-ok">Conciliado${m.tipo_conciliacion ? ' · ' + esc(m.tipo_conciliacion) : ''}</span>`
    : '<span class="badge badge-alert">Sin conciliar</span>';
  return `
    <div class="banco-mov-row">
      <div class="banco-mov-linea1">
        <div>
          <div class="banco-mov-concepto">${esc(m.concepto)}</div>
          <div class="banco-mov-meta">${esc(m.fecha)}${m.saldo != null ? ' · saldo ' + eur(m.saldo) : ''} ${badge}
            ${m.conciliado ? `<a href="#" onclick="desconciliarUI(${m.id});return false">Desconciliar</a>` : `<a href="#" onclick="toggleConciliarForm(${m.id});return false">Conciliar</a>`}
          </div>
        </div>
        <div class="banco-mov-importe ${negativo ? 'negativo' : 'positivo'}">${eur(m.importe)}</div>
      </div>
      ${bancoConciliandoId === m.id ? renderConciliarForm(m) : ''}
    </div>
  `;
}

// ── Conciliación manual ──────────────────────────────────────────────────
function renderConciliarForm(m) {
  const tipoDefault = Number(m.importe) < 0 ? 'factura' : 'venta';
  return `
    <div class="banco-conciliar-form" id="banco-conciliar-form-${m.id}">
      <select id="banco-tipo-${m.id}" onchange="onTipoConciliacionChange(${m.id})">
        <option value="factura" ${tipoDefault === 'factura' ? 'selected' : ''}>Factura</option>
        <option value="venta" ${tipoDefault === 'venta' ? 'selected' : ''}>Venta</option>
        <option value="nomina">Nómina</option>
        <option value="otro">Otro</option>
      </select>
      <select id="banco-candidata-${m.id}"><option>Buscando…</option></select>
      <button type="button" class="btn-drive" onclick="guardarConciliacion(${m.id})">Guardar</button>
      <button type="button" class="banco-btn-secundario" onclick="toggleConciliarForm(${m.id})">Cancelar</button>
    </div>
  `;
}

function toggleConciliarForm(id) {
  bancoConciliandoId = bancoConciliandoId === id ? null : id;
  refreshListadoBanco().then(() => { if (bancoConciliandoId === id) onTipoConciliacionChange(id); });
}

// Candidatas "por fecha/importe similar": trae facturas o ventas ya
// existentes (mismos endpoints que usan las pestañas Facturas/Ventas) y las
// ordena por cercanía de importe al movimiento — buscador simple, no un
// endpoint nuevo.
async function buscarCandidatasBanco(tipo, movimiento) {
  if (tipo === 'factura') {
    const r = await apiFetch('/facturas');
    const facturas = await r.json();
    const objetivo = Math.abs(Number(movimiento.importe));
    return facturas
      .filter(f => f.fecha_factura)
      .map(f => ({ id: f.id, dist: Math.abs((Number(f.importe_total) || 0) - objetivo), etiqueta: `${f.fecha_factura} · ${eur(f.importe_total)} · ${f.proveedor || '(sin proveedor)'}` }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 15);
  }
  if (tipo === 'venta') {
    const hasta = movimiento.fecha;
    const desde = new Date(`${movimiento.fecha}T00:00:00Z`);
    desde.setUTCDate(desde.getUTCDate() - 60);
    const r = await apiFetch(`/ventas?desde=${desde.toISOString().slice(0, 10)}&hasta=${hasta}`);
    const ventas = await r.json();
    const objetivo = Number(movimiento.importe);
    return ventas
      .map(v => ({ id: v.id, dist: Math.abs((Number(v.total_neto) || 0) - objetivo), etiqueta: `${v.fecha} · ${eur(v.total_neto)}` }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 15);
  }
  return [];
}

async function onTipoConciliacionChange(id) {
  const tipo = document.getElementById(`banco-tipo-${id}`).value;
  const candidataEl = document.getElementById(`banco-candidata-${id}`);
  if (tipo !== 'factura' && tipo !== 'venta') {
    candidataEl.innerHTML = '<option value="">(sin registro concreto)</option>';
    candidataEl.disabled = true;
    return;
  }
  candidataEl.disabled = false;
  candidataEl.innerHTML = '<option>Buscando…</option>';
  const movimiento = bancoMovimientos.find(m => m.id === id);
  try {
    const candidatas = await buscarCandidatasBanco(tipo, movimiento);
    candidataEl.innerHTML = candidatas.length
      ? candidatas.map(c => `<option value="${c.id}">${esc(c.etiqueta)}</option>`).join('')
      : '<option value="">Sin candidatas cercanas</option>';
  } catch (e) {
    candidataEl.innerHTML = `<option value="">${esc(e.message)}</option>`;
  }
}

async function guardarConciliacion(id) {
  const tipo_conciliacion = document.getElementById(`banco-tipo-${id}`).value;
  const candidataEl = document.getElementById(`banco-candidata-${id}`);
  const referencia_id = (tipo_conciliacion === 'factura' || tipo_conciliacion === 'venta') ? candidataEl.value : undefined;
  if ((tipo_conciliacion === 'factura' || tipo_conciliacion === 'venta') && !referencia_id) {
    alert('Elige una candidata de la lista');
    return;
  }
  try {
    const r = await apiFetch(`/banco/${id}/conciliar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo_conciliacion, referencia_id }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo conciliar');
    bancoConciliandoId = null;
    await refreshListadoBanco();
    refreshResumenBanco();
  } catch (e) {
    alert(e.message);
  }
}

async function desconciliarUI(id) {
  try {
    const r = await apiFetch(`/banco/${id}/desconciliar`, { method: 'PATCH' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo desconciliar');
    await refreshListadoBanco();
    refreshResumenBanco();
  } catch (e) {
    alert(e.message);
  }
}

// ── Ingesta: subir → vista previa editable → confirmar ───────────────────
async function subirArchivoBanco(file) {
  if (!file) return;
  const status = document.getElementById('banco-upload-status');
  status.classList.remove('hidden');
  status.textContent = 'Analizando extracto…';
  try {
    const fd = new FormData();
    fd.append('archivo', file);
    const r = await apiFetch('/banco/importar', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo procesar el archivo');
    status.classList.add('hidden');
    renderPreviewBanco(d);
  } catch (e) {
    status.classList.add('hidden');
    alert(e.message);
  }
}

function renderPreviewBanco(preview) {
  bancoPreviewState = preview;
  document.getElementById('banco-preview').innerHTML = `
    ${renderDudasBancoBlock(preview.dudas)}
    <table class="banco-preview-table">
      <thead><tr><th>Fecha</th><th>Concepto</th><th class="num">Importe</th><th class="num">Saldo</th><th></th></tr></thead>
      <tbody id="banco-preview-body">${preview.movimientos.map((m, j) => renderMovimientoPreviewRow(j, m)).join('')}</tbody>
    </table>
    <div class="banco-confirmar-bar">
      <button class="btn-drive" id="btn-confirmar-banco">Confirmar e importar</button>
      <button class="banco-btn-secundario" id="btn-cancelar-banco">Cancelar</button>
    </div>
  `;
  document.getElementById('banco-preview').classList.remove('hidden');
  document.getElementById('banco-upload-box').classList.add('hidden');
  document.getElementById('btn-confirmar-banco').addEventListener('click', confirmarBancoUI);
  document.getElementById('btn-cancelar-banco').addEventListener('click', cancelarPreviewBanco);
}

function renderDudasBancoBlock(dudas) {
  if (!dudas || !dudas.length) return '';
  return `<div class="banco-duda-card">
    <div class="banco-duda-titulo">⚠ ${dudas.length} fila(s) sin interpretar — no se importan</div>
    ${dudas.map(d => `<div class="banco-duda-row">
      <span>${esc(d.fila)}</span>
      <div class="banco-duda-motivo">${esc(d.motivo)}</div>
    </div>`).join('')}
  </div>`;
}

function renderMovimientoPreviewRow(j, m) {
  return `<tr>
    <td><input type="date" value="${esc(m.fecha || '')}" oninput="actualizarMovimientoPreview(${j},'fecha',this.value)"></td>
    <td><input type="text" value="${esc(m.concepto || '')}" oninput="actualizarMovimientoPreview(${j},'concepto',this.value)"></td>
    <td class="num"><input type="number" step="0.01" value="${m.importe ?? ''}" oninput="actualizarMovimientoPreview(${j},'importe',this.value)"></td>
    <td class="num"><input type="number" step="0.01" value="${m.saldo ?? ''}" oninput="actualizarMovimientoPreview(${j},'saldo',this.value)"></td>
    <td><button class="fi-delete" onclick="eliminarMovimientoPreview(${j})" title="Quitar movimiento">🗑</button></td>
  </tr>`;
}

function actualizarMovimientoPreview(j, campo, valor) {
  bancoPreviewState.movimientos[j][campo] = (campo === 'importe' || campo === 'saldo') ? (valor === '' ? null : Number(valor)) : valor;
}

function eliminarMovimientoPreview(j) {
  bancoPreviewState.movimientos.splice(j, 1);
  document.getElementById('banco-preview-body').innerHTML = bancoPreviewState.movimientos.map((m, k) => renderMovimientoPreviewRow(k, m)).join('');
}

async function confirmarBancoUI() {
  const movimientos = bancoPreviewState.movimientos;
  if (!movimientos.length) { alert('No queda ningún movimiento por importar'); return; }
  for (const m of movimientos) {
    if (!m.fecha || !m.concepto || m.importe == null) {
      alert('Cada movimiento necesita fecha, concepto e importe');
      return;
    }
  }
  const btn = document.getElementById('btn-confirmar-banco');
  btn.disabled = true;
  try {
    const r = await apiFetch('/banco/confirmar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origen_archivo: bancoPreviewState.origen_archivo, movimientos }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo confirmar la importación');
    alert(`Importado: ${d.guardados} movimiento(s) nuevo(s), ${d.duplicados} duplicado(s) omitido(s), ${d.conciliados} conciliado(s) automáticamente.`);
    cancelarPreviewBanco();
    refreshResumenBanco();
    refreshListadoBanco();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

function cancelarPreviewBanco() {
  bancoPreviewState = null;
  document.getElementById('banco-preview').classList.add('hidden');
  document.getElementById('banco-preview').innerHTML = '';
  document.getElementById('banco-upload-box').classList.remove('hidden');
  document.getElementById('banco-archivo-input').value = '';
}

// ── Init ─────────────────────────────────────────────────────────────────
function refreshBancoTab() {
  cancelarPreviewBanco();
  bancoConciliandoId = null;
  refreshResumenBanco();
  refreshListadoBanco();
}

function initBancoTab() {
  const input = document.getElementById('banco-archivo-input');
  if (!input) return; // esta página no tiene pestaña de banco
  document.getElementById('btn-subir-banco').addEventListener('click', () => input.click());
  input.addEventListener('change', () => subirArchivoBanco(input.files[0]));
  document.getElementById('banco-filtro-estado').addEventListener('change', refreshListadoBanco);
}
document.addEventListener('DOMContentLoaded', initBancoTab);
