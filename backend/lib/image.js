// backend/lib/image.js
// Composición de creatividades con sharp. El TEXTO se rasteriza a TRAZADOS vectoriales
// con opentype.js usando la fuente exacta (la de por defecto o la que suba el cliente),
// y se compone como <path> en un SVG. Ventajas frente a <text>:
//   · No depende de que el contenedor tenga la fuente (adiós "tofu" en Railway).
//   · Permite usar la TIPOGRAFÍA PROPIA de cada cliente (su manual de marca).
//   · Métricas reales → ajuste de línea y tamaño exactos.
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');
const sharp = require('sharp');

const FONTS_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

function loadFontFile(file) {
  const buf = fs.readFileSync(path.join(FONTS_DIR, file));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

// Fuentes por defecto O2MAD.
const DEFAULT_DISPLAY = loadFontFile('Anton_400Regular.ttf');   // titulares
const DEFAULT_BODY = loadFontFile('Poppins_600SemiBold.ttf');   // subtítulo
const DEFAULT_BOLD = loadFontFile('Poppins_700Bold.ttf');       // marca + CTA

// Cache de fuentes de cliente (base64 → Font) para no re-parsear en cada render.
const clientFontCache = new Map();
function parseClientFont(data) {
  if (!data || typeof data !== 'string') return null;
  const key = data.length + ':' + data.slice(28, 60);
  if (clientFontCache.has(key)) return clientFontCache.get(key);
  try {
    const m = data.match(/^data:[^;]*;base64,(.+)$/);
    const buf = Buffer.from(m ? m[1] : data, 'base64');
    const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    clientFontCache.set(key, font);
    return font;
  } catch (e) {
    console.error('[image] fuente de cliente inválida:', e.message);
    return null;
  }
}

// ── Métricas y trazado de texto ─────────────────────────────────────────────
function measure(font, text, size, ls = 0) {
  const chars = [...String(text)];
  let w = 0;
  for (const ch of chars) w += (font.charToGlyph(ch).advanceWidth / font.unitsPerEm) * size + ls;
  return chars.length ? w - ls : 0;
}

// Devuelve un <path> SVG con el texto ya posicionado (soporta letter-spacing y anclaje).
function textPath(font, text, x, y, size, { ls = 0, anchor = 'start', fill = '#ffffff' } = {}) {
  let sx = x;
  if (anchor !== 'start') { const w = measure(font, text, size, ls); sx = anchor === 'middle' ? x - w / 2 : x - w; }
  const full = new opentype.Path();
  let cx = sx;
  for (const ch of [...String(text)]) {
    const g = font.charToGlyph(ch);
    full.extend(g.getPath(cx, y, size));
    cx += (g.advanceWidth / font.unitsPerEm) * size + ls;
  }
  return `<path d="${full.toPathData(2)}" fill="${fill}"/>`;
}

// Envuelve por palabras usando métricas reales; si la línea más larga no cabe, reduce
// el tamaño para que quepa. Devuelve { lines, size }.
function wrapFit(font, text, size, usable, maxLines, ls = 0) {
  const words = String(text || '').trim().split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const cand = line ? `${line} ${w}` : w;
    if (measure(font, cand, size, ls) > usable && line) { lines.push(line); line = w; }
    else line = cand;
  }
  if (line) lines.push(line);
  const kept = lines.slice(0, maxLines);
  const maxW = Math.max(1, ...kept.map(l => measure(font, l, size, ls)));
  const finalSize = maxW > usable ? Math.floor(size * (usable / maxW)) : size;
  return { lines: kept, size: finalSize };
}

// ── Formatos de salida ──────────────────────────────────────────────────────
const FORMATS = {
  story:  { w: 1080, h: 1920 },
  post:   { w: 1080, h: 1350 },
  square: { w: 1080, h: 1080 },
};

// Construye el SVG del overlay (scrim + textos-trazado + branding).
function buildOverlaySvg({ w, h, titular, subtitulo, brand, cta, accent, fonts }) {
  const { display, body, bold } = fonts;
  const pad = Math.round(w * 0.07);
  const usable = w - pad * 2;

  // Titular (fuente display, MAYÚSCULAS).
  const titLS = Math.round(w * 0.001);
  const tit = wrapFit(display, (titular || '').toUpperCase(), Math.round(w * 0.088), usable, 3, titLS);
  // Subtítulo (fuente body).
  const sub = subtitulo
    ? wrapFit(body, subtitulo, Math.round(w * 0.040), usable, 2, 0)
    : { lines: [], size: 0 };

  const brandSize = Math.round(w * 0.030);
  const ctaSize = Math.round(w * 0.038);

  const titLH = Math.round(tit.size * 1.04);
  const subLH = Math.round((sub.size || 1) * 1.3);
  const gapTitSub = sub.lines.length ? Math.round(sub.size * 0.8) : 0;
  const ctaBoxH = cta ? Math.round(ctaSize * 1.9) : 0;
  const gapCta = cta ? Math.round((sub.size || tit.size * 0.4) * 0.9) : 0;

  const blockH = tit.lines.length * titLH + gapTitSub + sub.lines.length * subLH + gapCta + ctaBoxH;
  let y = h - pad - blockH + tit.size; // baseline de la primera línea del titular

  const titPaths = tit.lines.map((ln, i) =>
    textPath(display, ln, pad, y + i * titLH, tit.size, { ls: titLS, fill: '#ffffff' })
  ).join('');
  let cursor = y + (tit.lines.length - 1) * titLH + gapTitSub;

  const subPaths = sub.lines.map((ln, i) =>
    textPath(body, ln, pad, cursor + sub.size + i * subLH, sub.size, { fill: '#f1f1f1' })
  ).join('');
  cursor += sub.lines.length * subLH;

  // Pill de CTA (opcional).
  let ctaSvg = '';
  if (cta) {
    const ctaText = String(cta).toUpperCase();
    const innerPad = Math.round(ctaSize * 0.9);
    const ctaW = Math.round(measure(bold, ctaText, ctaSize, 1)) + innerPad * 2;
    const ctaY = cursor + gapCta;
    const textY = ctaY + Math.round(ctaBoxH * 0.68);
    ctaSvg = `<rect x="${pad}" y="${ctaY}" rx="${Math.round(ctaSize)}" ry="${Math.round(ctaSize)}" width="${ctaW}" height="${ctaBoxH}" fill="${accent}"/>`
      + textPath(bold, ctaText, pad + ctaW / 2, textY, ctaSize, { ls: 1, anchor: 'middle', fill: '#141414' });
  }

  // Marca de branding (solo si no hay logo; el logo lo compone sharp aparte).
  const brandSvg = brand
    ? textPath(bold, String(brand).toUpperCase(), pad, pad + brandSize, brandSize, { ls: Math.round(brandSize * 0.12), fill: '#ffffff' })
    : '';

  return Buffer.from(`<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.45" stop-color="#000000" stop-opacity="0"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0.72"/>
      </linearGradient>
      <linearGradient id="topscrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000000" stop-opacity="0.45"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${w}" height="${Math.round(h * 0.18)}" fill="url(#topscrim)"/>
    <rect x="0" y="${Math.round(h * 0.45)}" width="${w}" height="${Math.round(h * 0.55)}" fill="url(#scrim)"/>
    ${brandSvg}${titPaths}${subPaths}${ctaSvg}
  </svg>`);
}

// Decodifica un logo desde data URI o base64 pelado.
function decodeLogo(logo) {
  if (!logo || typeof logo !== 'string') return null;
  const m = logo.match(/^data:image\/[a-zA-Z.+-]+;base64,(.+)$/);
  try { return Buffer.from(m ? m[1] : logo, 'base64'); } catch { return null; }
}

// Genera un PNG de creatividad.
//   imageBuffer : Buffer de la foto original
//   copy        : { titular, subtitulo, cta }
//   opts        : { format, brand, accent, logo, fontDisplay, fontBody }
//                 fontDisplay/fontBody = data URI/base64 de la TTF/OTF del cliente.
// Devuelve { buffer, format, width, height }.
async function composeCreative(imageBuffer, copy = {}, opts = {}) {
  const format = FORMATS[opts.format] ? opts.format : 'post';
  const { w, h } = FORMATS[format];
  const pad = Math.round(w * 0.07);

  // Fuentes: las del cliente si las sube, si no las de O2MAD.
  const cDisplay = parseClientFont(opts.fontDisplay);
  const cBody = parseClientFont(opts.fontBody);
  const fonts = {
    display: cDisplay || DEFAULT_DISPLAY,
    body: cBody || DEFAULT_BODY,
    bold: cBody || DEFAULT_BOLD,
  };

  const base = await sharp(imageBuffer)
    .rotate()
    .resize(w, h, { fit: 'cover', position: 'attention' })
    .toBuffer();

  // Logo (opcional): esquina superior; si hay logo, no ponemos el nombre en texto.
  const composites = [];
  let logoBuf = decodeLogo(opts.logo);
  if (logoBuf) {
    try {
      logoBuf = await sharp(logoBuf)
        .resize({ height: Math.round(h * 0.06), width: Math.round(w * 0.42), fit: 'inside', withoutEnlargement: true })
        .png().toBuffer();
    } catch { logoBuf = null; }
  }

  const overlay = buildOverlaySvg({
    w, h,
    titular: copy.titular,
    subtitulo: copy.subtitulo,
    cta: copy.cta,
    brand: logoBuf ? '' : opts.brand,
    accent: opts.accent || '#E9C46A',
    fonts,
  });
  composites.push({ input: overlay, top: 0, left: 0 });
  if (logoBuf) composites.push({ input: logoBuf, top: pad, left: pad });

  const buffer = await sharp(base).composite(composites).png().toBuffer();
  return { buffer, format, width: w, height: h };
}

module.exports = { composeCreative, FORMATS };
