// Ventas diarias — componente compartido entre timbol.html y comarea.html.
// Script clásico (no módulo), igual que tarifas-shared.js: se apoya en los
// globals ya definidos por cada página (apiFetch, esc, eur, userRole,
// switchTab, MESES).

// ── Estilos ──────────────────────────────────────────────────────────────
(function injectVentasStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .venta-calendario-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; font-size: 14px; font-weight: 600; }
    .venta-calendario-header button { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); width: 32px; height: 32px; cursor: pointer; font-size: 14px; }
    .venta-calendario-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; margin-bottom: 12px; }
    .venta-dia { aspect-ratio: 1; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font-size: 12px; cursor: pointer; }
    .venta-dia-ok { background: rgba(107,175,122,.15); border-color: var(--ok); color: var(--ok); font-weight: 600; }
    .venta-dia-hueco { background: rgba(217,107,82,.1); border-color: var(--alert); color: var(--alert); }
    .venta-dia-futuro { opacity: .35; cursor: default; }
    .venta-calendario-leyenda { display: flex; gap: 16px; font-size: 12px; color: var(--muted); margin-bottom: 8px; }
    .venta-dia-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 4px; vertical-align: middle; }
    .venta-dia-swatch.venta-dia-ok { background: var(--ok); border: none; }
    .venta-dia-swatch.venta-dia-hueco { background: var(--alert); border: none; }
  `;
  document.head.appendChild(style);
})();

function numOrNull(v) { return v === '' || v == null ? null : Number(v); }

// ── Cierre de caja por foto (pestaña Escanear) ──────────────────────────
let ventaPreviewState = null;
let ventaArchivosOriginales = [];

function initVentasScan() {
  const btn = document.getElementById('btn-cierre-caja');
  const input = document.getElementById('input-cierre-caja');
  if (!btn || !input) return;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length) subirCierreCaja(files);
  });
}
document.addEventListener('DOMContentLoaded', initVentasScan);

async function subirCierreCaja(files) {
  document.getElementById('scan-home').classList.add('hidden');
  document.getElementById('venta-loading').classList.remove('hidden');
  try {
    const fd = new FormData();
    files.forEach(f => fd.append('fotos', f));
    const r = await apiFetch('/ventas/foto', { method: 'POST', body: fd });
    const d = await r.json();
    document.getElementById('venta-loading').classList.add('hidden');
    if (!r.ok) throw new Error(d.error || 'No se pudo procesar el cierre de caja');
    ventaArchivosOriginales = files.map(f => f.name);
    renderVentaPreview(d.venta);
  } catch (e) {
    document.getElementById('venta-loading').classList.add('hidden');
    document.getElementById('scan-home').classList.remove('hidden');
    alert(e.message);
  }
}

function renderVentaPreview(venta) {
  ventaPreviewState = { ...venta, lineas: Array.isArray(venta.lineas) ? venta.lineas : [] };
  const dudas = venta.dudas && venta.dudas.length
    ? `<div class="duda-card"><div class="duda-titulo">⚠ ${venta.dudas.length} dato(s) sin confirmar</div>
        ${venta.dudas.map(d => `<div class="duda-row">${esc(d)}</div>`).join('')}</div>`
    : '';

  document.getElementById('venta-preview').innerHTML = `
    ${dudas}
    <div class="card">
      <div class="field"><label>Fecha del cierre</label><input type="date" id="venta-fecha" value="${venta.fecha || new Date().toISOString().slice(0, 10)}"></div>
      <div class="tarifa-grupo-fields" style="margin-top:10px">
        <div class="field"><label>Total bruto</label><input type="number" step="0.01" id="venta-total-bruto" value="${venta.total_bruto ?? ''}"></div>
        <div class="field"><label>Total neto</label><input type="number" step="0.01" id="venta-total-neto" value="${venta.total_neto ?? ''}"></div>
        <div class="field"><label>Nº tickets</label><input type="number" id="venta-num-tickets" value="${venta.num_tickets ?? ''}"></div>
        <div class="field"><label>Detalle por artículo</label>
          <select id="venta-detalle-articulo">
            <option value="true" ${venta.detalle_por_articulo !== false ? 'selected' : ''}>Sí</option>
            <option value="false" ${venta.detalle_por_articulo === false ? 'selected' : ''}>No (solo familias)</option>
          </select>
        </div>
      </div>
      <div class="tarifa-grupo-fields" style="margin-top:10px">
        <div class="field"><label>Efectivo</label><input type="number" step="0.01" id="venta-pago-efectivo" value="${venta.desglose_pago?.efectivo ?? ''}"></div>
        <div class="field"><label>Tarjeta</label><input type="number" step="0.01" id="venta-pago-tarjeta" value="${venta.desglose_pago?.tarjeta ?? ''}"></div>
        <div class="field"><label>Otros</label><input type="number" step="0.01" id="venta-pago-otros" value="${venta.desglose_pago?.otros ?? ''}"></div>
      </div>
    </div>
    <p class="section-title">Líneas (${ventaPreviewState.lineas.length})</p>
    <table class="tarifa-productos-table">
      <thead><tr><th>Producto</th><th class="num">Cant.</th><th class="num">Importe</th><th>Familia</th><th></th></tr></thead>
      <tbody id="venta-lineas-body">${ventaPreviewState.lineas.map((l, j) => renderVentaLineaRow(j, l)).join('')}</tbody>
    </table>
    <button class="btn-add-producto" onclick="agregarVentaLinea()">+ Añadir línea</button>
    <div class="tarifa-confirmar-bar">
      <button class="btn-drive" id="btn-confirmar-venta">Confirmar cierre</button>
      <button class="tarifa-btn-secondary" id="btn-cancelar-venta">Cancelar</button>
    </div>
  `;
  document.getElementById('venta-preview').classList.remove('hidden');
  document.getElementById('btn-confirmar-venta').addEventListener('click', confirmarCierreCaja);
  document.getElementById('btn-cancelar-venta').addEventListener('click', cancelarVentaPreview);
}

function renderVentaLineaRow(j, l) {
  return `<tr>
    <td><input type="text" value="${esc(l.producto || '')}" oninput="actualizarVentaLinea(${j},'producto',this.value)"></td>
    <td class="num"><input type="number" step="0.001" value="${l.cantidad ?? ''}" oninput="actualizarVentaLinea(${j},'cantidad',this.value)"></td>
    <td class="num"><input type="number" step="0.01" value="${l.importe ?? ''}" oninput="actualizarVentaLinea(${j},'importe',this.value)"></td>
    <td><input type="text" value="${esc(l.familia || '')}" oninput="actualizarVentaLinea(${j},'familia',this.value)"></td>
    <td><button class="fi-delete" onclick="eliminarVentaLinea(${j})" title="Quitar línea">🗑</button></td>
  </tr>`;
}

function actualizarVentaLinea(j, campo, valor) {
  ventaPreviewState.lineas[j][campo] = (campo === 'cantidad' || campo === 'importe') ? numOrNull(valor) : valor;
}
function eliminarVentaLinea(j) {
  ventaPreviewState.lineas.splice(j, 1);
  document.getElementById('venta-lineas-body').innerHTML = ventaPreviewState.lineas.map((l, k) => renderVentaLineaRow(k, l)).join('');
}
function agregarVentaLinea() {
  ventaPreviewState.lineas.push({ producto: '', cantidad: null, importe: null, familia: null });
  document.getElementById('venta-lineas-body').innerHTML = ventaPreviewState.lineas.map((l, k) => renderVentaLineaRow(k, l)).join('');
}

async function confirmarCierreCaja() {
  const venta = {
    fecha:                document.getElementById('venta-fecha').value,
    total_bruto:          numOrNull(document.getElementById('venta-total-bruto').value),
    total_neto:           numOrNull(document.getElementById('venta-total-neto').value),
    num_tickets:          numOrNull(document.getElementById('venta-num-tickets').value),
    detalle_por_articulo: document.getElementById('venta-detalle-articulo').value === 'true',
    desglose_pago: {
      efectivo: numOrNull(document.getElementById('venta-pago-efectivo').value),
      tarjeta:  numOrNull(document.getElementById('venta-pago-tarjeta').value),
      otros:    numOrNull(document.getElementById('venta-pago-otros').value),
    },
    lineas: ventaPreviewState.lineas,
    origen_ref: ventaArchivosOriginales.join(', '),
  };
  if (!venta.fecha) { alert('Falta la fecha del cierre'); return; }
  const btn = document.getElementById('btn-confirmar-venta');
  btn.disabled = true;
  try {
    const r = await apiFetch('/ventas/confirmar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ venta }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo guardar el cierre');
    alert(`Cierre del ${venta.fecha} guardado.`);
    cancelarVentaPreview();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

function cancelarVentaPreview() {
  ventaPreviewState = null;
  document.getElementById('venta-preview').classList.add('hidden');
  document.getElementById('venta-preview').innerHTML = '';
  document.getElementById('scan-home').classList.remove('hidden');
}

// ── Pestaña Ventas (admin/gestor): calendario + detalle por día ─────────
let calendarioMes = new Date();

function primerDiaMes(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function ultimoDiaMes(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function isoLocal(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

function refreshVentasTab() {
  renderCalendarioVentas();
}

async function renderCalendarioVentas() {
  const cont = document.getElementById('ventas-calendario');
  if (!cont) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  const desde = isoLocal(primerDiaMes(calendarioMes));
  const hasta = isoLocal(ultimoDiaMes(calendarioMes));
  try {
    const dias = await (await apiFetch(`/ventas?desde=${desde}&hasta=${hasta}`)).json();
    const cargados = new Map(dias.map(d => [d.fecha, d]));
    const hoy = isoLocal(new Date());
    const numDias = ultimoDiaMes(calendarioMes).getDate();
    const nombreMes = calendarioMes.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

    let celdas = '';
    for (let dia = 1; dia <= numDias; dia++) {
      const fecha = `${desde.slice(0, 7)}-${String(dia).padStart(2, '0')}`;
      const esFuturo = fecha > hoy;
      const clase = cargados.has(fecha) ? 'venta-dia-ok' : (esFuturo ? 'venta-dia-futuro' : 'venta-dia-hueco');
      celdas += `<button class="venta-dia ${clase}" ${esFuturo ? 'disabled' : `onclick="verDetalleVenta('${fecha}')"`}>${dia}</button>`;
    }

    cont.innerHTML = `
      <div class="venta-calendario-header">
        <button onclick="cambiarMesVentas(-1)">←</button>
        <span style="text-transform:capitalize">${esc(nombreMes)}</span>
        <button onclick="cambiarMesVentas(1)">→</button>
      </div>
      <div class="venta-calendario-grid">${celdas}</div>
      <div class="venta-calendario-leyenda">
        <span><span class="venta-dia-swatch venta-dia-ok"></span>Cargado</span>
        <span><span class="venta-dia-swatch venta-dia-hueco"></span>Sin cierre</span>
      </div>
      <div id="venta-detalle-dia"></div>
    `;
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function cambiarMesVentas(delta) {
  calendarioMes = new Date(calendarioMes.getFullYear(), calendarioMes.getMonth() + delta, 1);
  renderCalendarioVentas();
}

async function verDetalleVenta(fecha) {
  const cont = document.getElementById('venta-detalle-dia');
  if (!cont) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const r = await apiFetch(`/ventas/${fecha}`);
    if (r.status === 404) {
      cont.innerHTML = `<div class="empty">Sin cierre para ${fecha}</div>`;
      return;
    }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Error al cargar el detalle');
    const lineas = Array.isArray(d.lineas) ? d.lineas : [];
    cont.innerHTML = `
      <div class="card" style="margin-top:12px">
        <div class="card-row"><span>Fecha</span><strong>${esc(d.fecha)}</strong></div>
        <div class="card-row"><span>Total bruto</span><strong>${eur(d.total_bruto)}</strong></div>
        <div class="card-row"><span>Total neto</span><strong>${eur(d.total_neto)}</strong></div>
        <div class="card-row"><span>Tickets</span><strong>${d.num_tickets ?? '—'}</strong></div>
        <div class="card-row"><span>Efectivo / Tarjeta / Otros</span><strong>${eur(d.desglose_pago?.efectivo || 0)} / ${eur(d.desglose_pago?.tarjeta || 0)} / ${eur(d.desglose_pago?.otros || 0)}</strong></div>
        <div class="card-row"><span>Origen</span><strong>${esc(d.origen)}${d.detalle_por_articulo === false ? ' (solo familias)' : ''}</strong></div>
      </div>
      ${lineas.length ? `<table class="lineas-table">
        <thead><tr><th>Producto</th><th class="num">Cant.</th><th class="num">Importe</th><th>Familia</th></tr></thead>
        <tbody>${lineas.map(l => `<tr>
          <td>${esc(l.producto || '—')}</td>
          <td class="num">${l.cantidad ?? '—'}</td>
          <td class="num">${l.importe != null ? eur(l.importe) : '—'}</td>
          <td>${esc(l.familia || '—')}</td>
        </tr>`).join('')}</tbody>
      </table>` : ''}
    `;
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ── Bloque "Food cost" (pestaña Análisis) ───────────────────────────────
async function refreshFoodcost() {
  const cont = document.getElementById('foodcost-block');
  if (!cont) return;
  cont.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const hasta = new Date();
    const desde = new Date();
    desde.setDate(desde.getDate() - 29); // últimos 30 días
    const isoH = isoLocal(hasta);
    const isoD = isoLocal(desde);
    const data = await (await apiFetch(`/analytics/foodcost?desde=${isoD}&hasta=${isoH}`)).json();

    const dias = data.dias || [];
    const conDatos = dias.filter(d => d.media_movil_7d != null);
    const max = Math.max(...conDatos.map(d => d.media_movil_7d), 1);
    const bars = dias.slice(-14).map(d => {
      const pct = d.media_movil_7d != null ? Math.round((d.media_movil_7d / max) * 100) : 0;
      return `<div class="bar-col">
        <div class="bar-fill" style="height:${pct}%" title="${d.fecha}: ${d.media_movil_7d ?? '—'}%"></div>
        <div class="bar-label">${d.fecha.slice(8, 10)}</div>
      </div>`;
    }).join('');

    cont.innerHTML = `
      <div class="kpi-grid" style="margin-bottom:12px">
        <div class="kpi-card"><div class="kpi-label">Food cost acumulado</div><div class="kpi-value kpi-accent">${data.acumulado.foodcost_pct != null ? data.acumulado.foodcost_pct + '%' : '—'}</div></div>
        <div class="kpi-card"><div class="kpi-label">Compras (30d)</div><div class="kpi-value">${eur(data.acumulado.compras)}</div></div>
        <div class="kpi-card"><div class="kpi-label">Ventas netas (30d)</div><div class="kpi-value">${eur(data.acumulado.ventas_neto)}</div></div>
      </div>
      <div class="chart-wrap">
        <div class="chart-title">Media móvil 7 días — últimos 14 días</div>
        <div class="bar-chart">${bars || '<div style="color:var(--muted);font-size:13px;width:100%;text-align:center">Sin datos</div>'}</div>
      </div>
    `;
  } catch (e) {
    cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
