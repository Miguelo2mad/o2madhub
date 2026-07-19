// backend/agents/creative-agent.js
// Content Creator — Carril A (creatividades foto + texto).
// Dado una foto + un brief + (opcional) la config del cliente, Claude Vision LEE la
// imagen y escribe el copy adaptado: titular corto para incrustar, subtítulo, caption
// para el post y hashtags. Devuelve JSON garantizado (structured outputs).
const { client } = require('../lib/claude');

// Copy que se superpone a la imagen + copy del post. El titular se incrusta sobre la
// foto, así que debe ser MUY corto; el caption es el texto de la publicación.
const CREATIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    titular:     { type: 'string', description: 'Texto principal para SUPERPONER sobre la foto. Máx 5 palabras, impactante.' },
    subtitulo:   { type: ['string', 'null'], description: 'Segunda línea opcional bajo el titular. Máx 7 palabras, o null.' },
    caption:     { type: 'string', description: 'Texto de la publicación (post), 1-3 frases con gancho. Sin hashtags aquí.' },
    hashtags:    { type: 'array', items: { type: 'string' }, description: 'Entre 4 y 10 hashtags relevantes, sin la #.' },
    cta:         { type: ['string', 'null'], description: 'Llamada a la acción corta para un sticker/botón (ej. "Reserva ya"), o null.' },
  },
  required: ['titular', 'subtitulo', 'caption', 'hashtags', 'cta'],
};

// Construye el bloque de personalización a partir de la config de cliente (o genérico).
function personaBlock(clientConfig) {
  if (!clientConfig) {
    return 'Cliente: O2MAD (agencia). Tono: cercano y profesional. Idioma: español.';
  }
  const c = clientConfig;
  return [
    `Cliente: ${c.client_name}.`,
    c.prompt_maestro ? `Guía de marca: ${c.prompt_maestro}` : null,
    c.tono ? `Tono: ${c.tono}.` : null,
    Array.isArray(c.idiomas) && c.idiomas.length ? `Idioma(s): ${c.idiomas.join(', ')}.` : 'Idioma: español.',
    c.prohibiciones ? `Evita: ${c.prohibiciones}.` : null,
    Array.isArray(c.hashtags_fijos) && c.hashtags_fijos.length
      ? `Incluye SIEMPRE estos hashtags: ${c.hashtags_fijos.join(', ')}.` : null,
  ].filter(Boolean).join('\n');
}

const SYSTEM = `Eres un director creativo de redes sociales. A partir de UNA foto y un brief,
escribes el copy de una creatividad para Instagram/redes.
- titular: lo que se SUPERPONE sobre la foto. Cortísimo (máx 5 palabras), gancho visual.
- subtitulo: apoyo opcional, o null si el titular ya basta.
- caption: el texto del post (1-3 frases), con gancho, sin hashtags dentro.
- hashtags: 4-10, relevantes al contenido REAL de la foto y al cliente.
- cta: llamada a la acción breve o null.
Mira de verdad la foto: usa lo que aparece en ella (lugar, producto, ambiente) para que el
copy sea específico, no genérico. Respeta la guía de marca, el tono y el idioma indicados.`;

// Genera el copy de una creatividad.
//   imageBase64 : string base64 de la foto (sin prefijo data:)
//   mediaType   : 'image/jpeg' | 'image/png' | 'image/webp'
//   brief       : texto libre del usuario (puede ser '')
//   clientConfig: fila de content_client_config o null
async function generateCreativeCopy({ imageBase64, mediaType = 'image/jpeg', brief = '', clientConfig = null }) {
  const userText = [
    personaBlock(clientConfig),
    '',
    `Brief del usuario: ${brief || '(sin brief; propón tú el ángulo a partir de la foto)'}`,
  ].join('\n');

  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 800,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: CREATIVE_SCHEMA },
    },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: `${SYSTEM}\n\n---\n${userText}` },
      ],
    }],
  });

  const text = res.content.find(b => b.type === 'text')?.text || '{}';
  return JSON.parse(text);
}

module.exports = { generateCreativeCopy, CREATIVE_SCHEMA };
