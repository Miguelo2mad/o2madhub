// Claude client + invoice field extraction.
// Uses structured outputs (output_config.format) so the response is guaranteed valid JSON.
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Códigos de sociedad usados en la tabla `facturas`.
const SOCIEDADES = {
  g: 'Gulliver AI',
  a: 'Apper Street',
  d: 'O2DOSMAD Design',
  s: 'SalesPro',
  x: 'Sin Clasificar',
};

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

- SI SE ADJUNTA UN PDF: extrae los datos del PDF (es la fuente principal), no del correo:
    · fecha_factura = FECHA DE EMISIÓN que aparece en el PDF (YYYY-MM-DD), NUNCA la fecha del correo.
    · proveedor = emisor real de la factura (quien la emite).
    · importe = importe TOTAL exacto del PDF (con IVA si aparece el total).
    · referencia = número de factura del PDF.
    · sociedad_codigo = SOCIEDAD DESTINATARIA (cliente al que va dirigida la factura), mapeando:
        O2DOSMAD / O2MAD Design → d;  Gulliver → g;  Apper Street → a;
        Brand Strategy / SalesPro → s;  si no está claro → x.
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
- sociedad_codigo: elige el código que mejor encaje según el proveedor/concepto:
${Object.entries(SOCIEDADES).map(([k, v]) => `    ${k} = ${v}`).join('\n')}
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

module.exports = { client, extractFactura, SOCIEDADES, FACTURA_SCHEMA };
