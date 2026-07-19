// backend/lib/image.js
// Composición de creatividades con sharp: coge una foto y le incrusta el titular,
// subtítulo, un scrim para legibilidad y una marca de branding. Las fuentes van
// EMBEBIDAS en el SVG (base64) para que el render sea idéntico en local y en Railway,
// sin depender de las fuentes del sistema/contenedor.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// ── Fuentes embebidas ───────────────────────────────────────────────────────
const FONT_FILES = {
  Anton: '@expo-google-fonts/anton/400Regular/Anton_400Regular.ttf',
  Poppins: '@expo-google-fonts/poppins/600SemiBold/Poppins_600SemiBold.ttf',
  PoppinsBold: '@expo-google-fonts/poppins/700Bold/Poppins_700Bold.ttf',
};
const fontCache = {};
function fontDataUri(name) {
  if (fontCache[name]) return fontCache[name];
  const buf = fs.readFileSync(path.join(__dirname, '..', '..', 'node_modules', FONT_FILES[name]));
  return (fontCache[name] = `data:font/ttf;base64,${buf.toString('base64')}`);
}

// ── Formatos de salida ──────────────────────────────────────────────────────
const FORMATS = {
  story:  { w: 1080, h: 1920 },
  post:   { w: 1080, h: 1350 },
  square: { w: 1080, h: 1080 },
};

const escapeXml = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// Envuelve un texto en líneas de como mucho `maxChars` caracteres (por palabras).
function wrap(text, maxChars, maxLines) {
  const words = String(text || '').trim().split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length > maxChars && line) { lines.push(line); line = w; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

// Construye el SVG del overlay (scrim + textos + branding) del tamaño del lienzo.
function buildOverlaySvg({ w, h, titular, subtitulo, brand, cta, accent = '#E9C46A' }) {
  const pad = Math.round(w * 0.07);
  const usable = w - pad * 2;
  // Tamaños relativos al ancho para que escalen entre formatos.
  let titSize = Math.round(w * 0.085);
  const subSize = Math.round(w * 0.040);
  const brandSize = Math.round(w * 0.030);
  const ctaSize = Math.round(w * 0.038);

  // Anchos medios de glifo (advance/fontSize), calibrados para no desbordar.
  const ANTON_F = 0.70;   // Anton en MAYÚSCULAS es más ancho de lo que aparenta
  const POPPINS_F = 0.55;

  // Caracteres por línea que caben en `usable` para cada fuente/tamaño.
  const titMaxChars = Math.max(6, Math.floor(usable / (titSize * ANTON_F)));
  let titLines = wrap((titular || '').toUpperCase(), titMaxChars, 3);
  // Si aun así la línea más larga se pasa (palabra muy larga), reducimos el tamaño.
  const longest = titLines.reduce((m, l) => Math.max(m, l.length), 0);
  if (longest * titSize * ANTON_F > usable) {
    titSize = Math.floor(usable / (longest * ANTON_F));
  }
  const subMaxChars = Math.max(10, Math.floor(usable / (subSize * POPPINS_F)));
  const subLines = subtitulo ? wrap(subtitulo, subMaxChars, 2) : [];

  // Bloque de texto anclado abajo. Calculamos alturas para apilar de abajo hacia arriba.
  const titLH = Math.round(titSize * 1.02);
  const subLH = Math.round(subSize * 1.25);
  const gapTitSub = subLines.length ? Math.round(subSize * 0.8) : 0;
  const ctaH = cta ? Math.round(ctaSize * 2.4) : 0;
  const gapCta = cta ? Math.round(subSize * 0.9) : 0;

  const blockH = titLines.length * titLH + gapTitSub + subLines.length * subLH + gapCta + ctaH;
  let y = h - pad - blockH + titSize; // baseline de la primera línea de titular

  const titSpans = titLines.map((ln, i) =>
    `<text x="${pad}" y="${y + i * titLH}" font-family="Anton" font-size="${titSize}" fill="#ffffff" letter-spacing="1">${escapeXml(ln)}</text>`
  ).join('');
  let cursor = y + (titLines.length - 1) * titLH + gapTitSub;

  const subSpans = subLines.map((ln, i) =>
    `<text x="${pad}" y="${cursor + subSize + i * subLH}" font-family="Poppins" font-size="${subSize}" fill="#f1f1f1">${escapeXml(ln)}</text>`
  ).join('');
  cursor += subLines.length * subLH;

  // Pill de CTA (opcional).
  let ctaSvg = '';
  if (cta) {
    const ctaText = cta.toUpperCase();
    const ctaW = Math.round(ctaText.length * ctaSize * 0.62) + pad;
    const ctaY = cursor + gapCta;
    ctaSvg = `
      <rect x="${pad}" y="${ctaY}" rx="${Math.round(ctaSize)}" ry="${Math.round(ctaSize)}"
            width="${ctaW}" height="${Math.round(ctaSize * 1.9)}" fill="${accent}"/>
      <text x="${pad + ctaW / 2}" y="${ctaY + Math.round(ctaSize * 1.28)}" text-anchor="middle"
            font-family="PoppinsBold" font-size="${ctaSize}" fill="#141414" letter-spacing="1">${escapeXml(ctaText)}</text>`;
  }

  // Marca de branding arriba a la izquierda.
  const brandSvg = brand
    ? `<text x="${pad}" y="${pad + brandSize}" font-family="PoppinsBold" font-size="${brandSize}"
           fill="#ffffff" letter-spacing="3">${escapeXml(brand.toUpperCase())}</text>`
    : '';

  return Buffer.from(`<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <style>
        @font-face { font-family: 'Anton'; src: url('${fontDataUri('Anton')}') format('truetype'); }
        @font-face { font-family: 'Poppins'; src: url('${fontDataUri('Poppins')}') format('truetype'); }
        @font-face { font-family: 'PoppinsBold'; src: url('${fontDataUri('PoppinsBold')}') format('truetype'); }
      </style>
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
    ${brandSvg}
    ${titSpans}
    ${subSpans}
    ${ctaSvg}
  </svg>`);
}

// Genera un PNG de creatividad.
//   imageBuffer : Buffer de la foto original
//   copy        : { titular, subtitulo, cta } (de creative-agent)
//   opts        : { format: 'post'|'story'|'square', brand, accent }
// Devuelve { buffer, format, width, height }.
async function composeCreative(imageBuffer, copy = {}, opts = {}) {
  const format = FORMATS[opts.format] ? opts.format : 'post';
  const { w, h } = FORMATS[format];

  const base = await sharp(imageBuffer)
    .rotate() // respeta EXIF
    .resize(w, h, { fit: 'cover', position: 'attention' }) // recorte inteligente hacia el sujeto
    .toBuffer();

  const overlay = buildOverlaySvg({
    w, h,
    titular: copy.titular,
    subtitulo: copy.subtitulo,
    cta: copy.cta,
    brand: opts.brand,
    accent: opts.accent || '#E9C46A',
  });

  const buffer = await sharp(base)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toBuffer();

  return { buffer, format, width: w, height: h };
}

module.exports = { composeCreative, FORMATS };
