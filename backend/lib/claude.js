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
  x: 'General / Holding',
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

const SYSTEM = `Eres un asistente que extrae datos de facturas de proveedores para O2MAD.
Devuelve los campos solicitados a partir del correo. Reglas:
- importe: número en euros sin símbolo (ej. 72.00). null si no aparece.
- fecha_factura: formato YYYY-MM-DD. null si no aparece.
- sociedad_codigo: elige el código que mejor encaje según el proveedor/concepto:
${Object.entries(SOCIEDADES).map(([k, v]) => `    ${k} = ${v}`).join('\n')}
  Si no está claro, usa "x".
- es_factura: false si el correo no es realmente una factura/recibo (newsletter, aviso, etc.).`;

// Extract invoice fields from an email-like object { subject, from, date, bodyText }.
async function extractFactura(email) {
  const userText = [
    `De: ${email.from}`,
    `Asunto: ${email.subject}`,
    `Fecha del correo: ${email.date}`,
    '',
    'Cuerpo:',
    (email.bodyText || '').slice(0, 8000),
  ].join('\n');

  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    output_config: {
      effort: 'low', // extracción simple → barato y rápido
      format: { type: 'json_schema', schema: FACTURA_SCHEMA },
    },
    messages: [
      { role: 'user', content: `${SYSTEM}\n\n---\n${userText}` },
    ],
  });

  const text = res.content.find(b => b.type === 'text')?.text || '{}';
  return JSON.parse(text);
}

module.exports = { client, extractFactura, SOCIEDADES, FACTURA_SCHEMA };
