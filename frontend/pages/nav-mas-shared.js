// Bottom sheet "Más" — componente compartido entre timbol.html y
// comarea.html, mismo patrón que banco-shared.js: apoyado en los globals de
// cada página (apiFetch, switchTab). Solo reorganiza navegación: no toca
// ninguna pantalla ni endpoint de negocio existente.
let masSheetTouchStartY = null;

function abrirMasSheet() {
  const overlay = document.getElementById('mas-overlay');
  if (!overlay) return;
  overlay.classList.add('open');
  refreshResumenPendientesBadge();
}

function cerrarMasSheet() {
  const overlay = document.getElementById('mas-overlay');
  if (overlay) overlay.classList.remove('open');
}

function onMasSheetTouchStart(e) {
  masSheetTouchStartY = e.touches[0].clientY;
}
function onMasSheetTouchMove(e) {
  if (masSheetTouchStartY == null) return;
  if (e.touches[0].clientY - masSheetTouchStartY > 80) {
    cerrarMasSheet();
    masSheetTouchStartY = null;
  }
}
function onMasSheetTouchEnd() {
  masSheetTouchStartY = null;
}

// Badge rojo sobre "Más": GET /resumen-pendientes agrega en una sola
// llamada lo que ya calcula cada pestaña por separado (facturas por
// revisar/incompletas, banco sin conciliar, checklists de hoy por
// revisar) — ver backend/lib/resumen-pendientes.js.
async function refreshResumenPendientesBadge() {
  const badge = document.getElementById('nav-mas-badge');
  if (!badge) return;
  try {
    const r = await apiFetch('/resumen-pendientes');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo consultar pendientes');
    badge.classList.toggle('hidden', !d.hay_pendientes);
  } catch (e) {
    console.error('[nav-mas] resumen-pendientes:', e.message);
  }
}

function initNavMasSheet() {
  const overlay = document.getElementById('mas-overlay');
  const modal = document.getElementById('mas-sheet');
  if (!overlay || !modal) return; // esta página no tiene sheet "Más"

  overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrarMasSheet(); });
  modal.addEventListener('touchstart', onMasSheetTouchStart, { passive: true });
  modal.addEventListener('touchmove', onMasSheetTouchMove, { passive: true });
  modal.addEventListener('touchend', onMasSheetTouchEnd);

  document.querySelectorAll('.sheet-item[data-tab]').forEach(b => {
    b.addEventListener('click', () => {
      cerrarMasSheet();
      switchTab(b.dataset.tab);
    });
  });
}
document.addEventListener('DOMContentLoaded', initNavMasSheet);
