// Captura secuencial de varias fotos/PDF en orden, con redimensionado en
// el navegador antes de enviar — compartido entre el cierre de caja
// (ventas) y la subida de facturas multipágina: ambos necesitan
// literalmente el mismo flujo (foto → miniatura numerada → añadir otra →
// procesar, con miniaturas eliminables y tope de fotos), así que vive
// aquí una sola vez en vez de duplicarse.
//
// Uso: crearCapturaSecuencial({ ids: {...}, onProcesar, maxFotos }).
// El orden de captura se conserva tal cual al procesar — nunca se reordena.
(function injectCapturaStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .captura-ayuda-texto { font-size: 13px; color: var(--muted); line-height: 1.5; margin-bottom: 14px; }
    .captura-thumbs { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }
    .captura-thumb { position: relative; width: 84px; height: 84px; border-radius: 10px; overflow: hidden; border: 1px solid var(--border); background: var(--surface2); }
    .captura-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .captura-thumb-pdf { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 10px; color: var(--muted); text-align: center; padding: 4px; word-break: break-all; }
    .captura-thumb-num { position: absolute; top: 4px; left: 4px; background: rgba(0,0,0,.65); color: #fff; font-size: 11px; font-weight: 600; border-radius: 50%; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; }
    .captura-thumb-del { position: absolute; top: 4px; right: 4px; background: rgba(0,0,0,.65); color: #fff; border: none; border-radius: 50%; width: 18px; height: 18px; font-size: 11px; line-height: 1; cursor: pointer; }
    .captura-peso { font-size: 12px; color: var(--muted); margin-bottom: 12px; min-height: 16px; }
    .captura-acciones { display: flex; gap: 8px; margin-bottom: 14px; }
    .captura-acciones button { flex: 1; }
    .captura-btn-procesar:disabled { opacity: .5; cursor: not-allowed; }
  `;
  document.head.appendChild(style);
})();

const CAPTURA_MAX_LADO = 1600;
const CAPTURA_JPEG_CALIDAD = 0.85;

// Redimensiona en el navegador (canvas) a máximo 1600px en el lado largo,
// JPEG calidad 0.85. Un PDF se deja tal cual (no se puede redimensionar
// con canvas).
function redimensionarImagenCaptura(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { resolve(file); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const ladoLargo = Math.max(width, height);
      if (ladoLargo > CAPTURA_MAX_LADO) {
        const factor = CAPTURA_MAX_LADO / ladoLargo;
        width = Math.round(width * factor);
        height = Math.round(height * factor);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('No se pudo procesar la imagen')); return; }
        resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }));
      }, 'image/jpeg', CAPTURA_JPEG_CALIDAD);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')); };
    img.src = url;
  });
}

// ids: { home, captura, thumbs, peso, btnFoto, btnGaleria, btnPdf,
//        inputCamara, inputGaleria, inputPdf, btnProcesar, btnCancelar }
// onProcesar(archivos) — se llama al pulsar "Procesar", con los File ya
// redimensionados, en el mismo orden de captura.
function crearCapturaSecuencial({ ids, onProcesar, maxFotos = 10 }) {
  let fotos = []; // [{ file, previewUrl, esPdf }]

  const el = (id) => document.getElementById(id);
  const thumbsEl     = el(ids.thumbs);
  const pesoEl       = el(ids.peso);
  const btnFoto      = el(ids.btnFoto);
  const btnProcesar  = el(ids.btnProcesar);
  const btnCancelar  = el(ids.btnCancelar);
  const inputCamara  = el(ids.inputCamara);
  const inputGaleria = el(ids.inputGaleria);
  const inputPdf     = el(ids.inputPdf);
  const capturaEl    = el(ids.captura);
  const homeEl       = el(ids.home);

  function render() {
    thumbsEl.innerHTML = fotos.map((f, i) => `
      <div class="captura-thumb">
        <span class="captura-thumb-num">${i + 1}</span>
        ${f.esPdf
          ? `<div class="captura-thumb-pdf">PDF<br>${esc(f.file.name.slice(0, 16))}</div>`
          : `<img src="${f.previewUrl}" alt="foto ${i + 1}">`}
        <button class="captura-thumb-del" data-idx="${i}" title="Quitar">✕</button>
      </div>
    `).join('');
    btnFoto.textContent = fotos.length ? '+ Añadir otra foto' : '📷 Hacer foto';
    btnProcesar.textContent = `Procesar (${fotos.length} foto${fotos.length === 1 ? '' : 's'})`;
    btnProcesar.disabled = fotos.length === 0;
    const pesoTotal = fotos.reduce((s, f) => s + f.file.size, 0);
    pesoEl.textContent = fotos.length ? `${(pesoTotal / (1024 * 1024)).toFixed(2)} MB en total` : '';
  }

  async function agregar(file) {
    if (fotos.length >= maxFotos) { alert(`Máximo ${maxFotos} fotos.`); return; }
    try {
      const procesado = file.type === 'application/pdf' ? file : await redimensionarImagenCaptura(file);
      const esPdf = procesado.type === 'application/pdf';
      fotos.push({ file: procesado, previewUrl: esPdf ? null : URL.createObjectURL(procesado), esPdf });
      render();
    } catch (e) {
      alert('No se pudo procesar la imagen: ' + e.message);
    }
  }

  function limpiar() {
    fotos.forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
    fotos = [];
    capturaEl.classList.add('hidden');
  }

  function abrir() {
    limpiar();
    homeEl.classList.add('hidden');
    capturaEl.classList.remove('hidden');
    render();
  }

  function cancelar() {
    limpiar();
    homeEl.classList.remove('hidden');
  }

  btnFoto.addEventListener('click', () => inputCamara.click());
  el(ids.btnGaleria).addEventListener('click', () => inputGaleria.click());
  el(ids.btnPdf).addEventListener('click', () => inputPdf.click());
  btnCancelar.addEventListener('click', cancelar);

  btnProcesar.addEventListener('click', async () => {
    if (!fotos.length) return;
    const archivos = fotos.map(f => f.file);
    limpiar();
    await onProcesar(archivos);
  });

  inputCamara.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await agregar(file);
  });
  inputGaleria.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) await agregar(f);
  });
  inputPdf.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) await agregar(f);
  });

  thumbsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.captura-thumb-del');
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    const f = fotos[idx];
    if (f?.previewUrl) URL.revokeObjectURL(f.previewUrl);
    fotos.splice(idx, 1);
    render();
  });

  return { abrir, cancelar };
}
