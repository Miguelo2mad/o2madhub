// Claude client + invoice field extraction.
// Uses structured outputs (output_config.format) so the response is guaranteed valid JSON.
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Sociedades del grupo O2MAD, con razón social, CIF y señas para identificar a qué
// sociedad va DIRIGIDA (destinataria) cada factura. 'd' y 's' son DOS entidades legales
// distintas, ambas en Gran Via Asima 20 (Palma) — distínguelas por CIF / razón social.
const SOCIEDADES_INFO = {
  d: {
    nombre: 'O2DOSMAD Design & Strategy SL',
    cif: 'B55405195',
    claves: 'O2DOSMAD, O2MAD, O2 Mad, info@o2mad.com, marketing@o2mad.com, Gran Via Asima 20 Palma',
  },
  s: {
    nombre: 'O2 Marketing and Design SL',
    cif: 'B57944829',
    claves: 'O2 Marketing and Design, CL Gran Via Asima 20 2 7 (07000) Palma — entidad legal DISTINTA de O2DOSMAD',
  },
  g: {
    nombre: 'Gulliver Ventures SL',
    cif: 'B26829291',
    claves: 'gulliver, gulliverventures, Gulliver Ventures',
  },
  a: {
    nombre: 'Apper Street SL',
    cif: 'B57856825',
    claves: 'apper street, apperstreet, apperstreetapp@gmail.com',
  },
  x: {
    nombre: 'Sin clasificar',
    cif: null,
    claves: 'úsalo cuando no haya señal clara (CIF / razón social) de la sociedad destinataria',
  },
};

// Mapa código → razón social, para uso de display (carpetas de Drive, emails, dashboard).
const SOCIEDADES = Object.fromEntries(
  Object.entries(SOCIEDADES_INFO).map(([code, info]) => [code, info.nombre])
);

// JSON schema the model must fill. Structured outputs guarantees a parseable object.
const FACTURA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    proveedor: { type: 'string', description: 'Nombre del proveedor/emisor de la factura' },
    importe: { type: ['number', 'null'], description: 'Importe total en EUR (número), o null si no se encuentra' },
    fecha_factura: { type: ['string', 'null'], description: 'Fecha de la factura en formato YYYY-MM-DD, o null' },
    sociedad_codigo: {
      type: 'string',
      enum: ['g', 'a', 'd', 's', 'x'],
      description: 'Código de la sociedad O2MAD a la que corresponde el gasto',
    },
    referencia: { type: ['string', 'null'], description: 'Número o referencia de la factura, o null' },
    concepto: { type: ['string', 'null'], description: 'Concepto/descripción breve del gasto' },
    es_factura: { type: 'boolean', description: 'true si el email realmente contiene una factura/recibo' },
  },
  required: ['proveedor', 'importe', 'fecha_factura', 'sociedad_codigo', 'referencia', 'concepto', 'es_factura'],
};

const SYSTEM = `Eres un asistente que extrae datos de FACTURAS DE PROVEEDORES (gastos de empresa) para O2MAD.
Devuelve los campos solicitados. Reglas:

- REGLA CRÍTICA — SOLO capturamos facturas en las que el grupo O2MAD es quien PAGA
  (un gasto / compra a un proveedor). NUNCA capturamos facturas que EMITE O2MAD a sus
  clientes (esos son ingresos/ventas, no gastos). Marca es_factura: false si se cumple
  CUALQUIERA de estas condiciones:
    · El EMISOR (quien emite la factura, campo "proveedor") es una empresa del grupo O2MAD:
      "O2 Mad", "O2 Marketing & Design", "O2DOSMAD", "O2DOSMAD Design & Strategy",
      "Apper Street" / "ApperStreet SL", "Gulliver", "SalesPro" / "Salespro Solutions".
      → es_factura: false (es una factura que emitimos nosotros).
    · El DESTINATARIO / CLIENTE de la factura (la empresa A QUIEN va dirigida y debe pagar)
      es un cliente externo, en especial: Zafiro, PURO / Purobeach, Clínica Nadal, Krishna,
      Canyamel, Inner Hotels, Universal Beach, Roots Beach, Son Caulelles, Clicktotravel,
      Expogrup, Assessoria Diagonal, o CUALQUIER hotel / restaurante cliente.
      → es_factura: false (le estamos facturando a un cliente).
  MUY IMPORTANTE — distingue el DESTINATARIO de la factura del PROYECTO mencionado en el
  concepto. Si un proveedor EXTERNO (un fotógrafo, freelance, agencia, etc.) nos factura
  A NOSOTROS por trabajo de un proyecto que menciona "Zafiro" / "PURO" / un hotel, ESO SÍ es
  una factura de proveedor válida que pagamos → es_factura: true. Solo excluye cuando el
  cliente es el RECEPTOR de la factura, no cuando solo aparece como proyecto en el concepto.

- SI SE ADJUNTA UN PDF: extrae los datos del PDF (es la fuente principal), no del correo:
    · fecha_factura = FECHA DE EMISIÓN que aparece en el PDF (YYYY-MM-DD), NUNCA la fecha del correo.
    · proveedor = emisor real de la factura (quien la emite).
    · importe = importe TOTAL exacto del PDF (con IVA si aparece el total).
    · referencia = número de factura del PDF.
    · sociedad_codigo = SOCIEDAD DESTINATARIA del grupo O2MAD (a quién va dirigida y debe
      pagar la factura). Identifícala por CIF o razón social (ver la lista de abajo). Ojo:
      'd' (O2DOSMAD Design & Strategy SL, CIF B55405195) y 's' (O2 Marketing and Design SL,
      CIF B57944829) son sociedades DISTINTAS — usa el CIF del destinatario para decidir.
  El correo solo sirve de contexto; los valores del PDF tienen prioridad.

- es_factura: marca true SOLO si es una factura de empresa legítima de un proveedor.
  Marca false (NO es factura) en estos casos:
    · Comida a domicilio o gastos personales (Glovo, Uber Eats, Just Eat, restaurantes, etc.).
    · Notificaciones de pago de PayPal / pasarelas (un aviso "has pagado a X" NO es una factura).
    · Newsletters, promociones, avisos, confirmaciones de pedido sin factura.
  Además, una factura legítima debe tener un NÚMERO/REFERENCIA de factura reconocible
  (p. ej. "Factura nº", "Invoice", "FA-...", "F2...", "Ref.", "Nº ..."). Si no hay número
  de factura identificable, marca es_factura: false.

- importe: número en euros sin símbolo (ej. 72.00). null si no aparece.
- fecha_factura: formato YYYY-MM-DD. null si no aparece.
- referencia: el número de factura tal cual aparece. null si no hay.
- sociedad_codigo: identifica la SOCIEDAD DESTINATARIA del grupo O2MAD por su CIF o razón
  social. Opciones (código = razón social — CIF — señas para reconocerla):
${Object.entries(SOCIEDADES_INFO).map(([k, v]) => `    ${k} = ${v.nombre}${v.cif ? ` — CIF ${v.cif}` : ''} — ${v.claves}`).join('\n')}
  Reglas específicas de proveedor:
    · "POM Design & Development S.L." → sociedad "d"
  Si no está claro, usa "x".`;

// Extract invoice fields from an email-like object { subject, from, date, bodyText }.
// If pdfBuffer is provided, the PDF is sent to Claude as a document block and is the
// primary source (emission date, real provider, exact amount, recipient sociedad).
async function extractFactura(email, pdfBuffer = null) {
  const userText = [
    `De: ${email.from}`,
    `Asunto: ${email.subject}`,
    `Fecha del correo: ${email.date}`,
    '',
    'Cuerpo:',
    (email.bodyText || '').slice(0, 8000),
  ].join('\n');

  const content = [];
  if (pdfBuffer) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') },
    });
  }
  content.push({ type: 'text', text: `${SYSTEM}\n\n---\n${userText}` });

  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    output_config: {
      effort: pdfBuffer ? 'medium' : 'low', // reading a PDF benefits from a bit more effort
      format: { type: 'json_schema', schema: FACTURA_SCHEMA },
    },
    messages: [{ role: 'user', content }],
  });

  const text = res.content.find(b => b.type === 'text')?.text || '{}';
  return JSON.parse(text);
}

module.exports = { client, extractFactura, SOCIEDADES, SOCIEDADES_INFO, FACTURA_SCHEMA };
