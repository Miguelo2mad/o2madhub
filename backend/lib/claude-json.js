// Llamada a Claude con salida JSON estructurada + reintento ante respuesta
// truncada. Antes este mismo patrón (llamar, JSON.parse en try/catch,
// reintentar la llamada completa una vez, rendirse con un error legible)
// estaba copiado tres veces: en extraccion.js (extraerFactura) y en
// tarifas.js (extraerBloqueTarifa, emparejarLineas). Punto único a partir
// de ahora para cualquier extracción de JSON vía Claude en el hub.
const { client } = require('./claude');

// Bloque de contenido para adjuntar una imagen o un PDF, según el mimetype.
function buildFileBlock(buffer, mimeType) {
  const isImage = mimeType.startsWith('image/');
  return isImage
    ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } }
    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
}

// Pide un JSON con el esquema dado y reintenta UNA vez si la respuesta
// llega truncada (JSON.parse falla). Si el segundo intento también falla,
// lanza `mensajeError` — nunca devuelve un JSON a medias en silencio.
async function extraerJson({ model = 'claude-opus-4-8', maxTokens, effort = 'medium', schema, content, mensajeError }) {
  const llamar = () => client.messages.create({
    model,
    max_tokens: maxTokens,
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  });

  let res = await llamar();
  let text = res.content.find(b => b.type === 'text')?.text || '';
  try {
    return { data: JSON.parse(text), usage: res.usage };
  } catch (e) {
    console.warn('[claude-json] JSON.parse falló en el primer intento, reintentando:', e.message);
  }

  res = await llamar();
  text = res.content.find(b => b.type === 'text')?.text || '';
  try {
    return { data: JSON.parse(text), usage: res.usage };
  } catch (e) {
    throw new Error(mensajeError || 'La IA devolvió una respuesta incompleta.');
  }
}

module.exports = { buildFileBlock, extraerJson };
