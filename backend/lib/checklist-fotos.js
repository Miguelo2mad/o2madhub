'use strict';
// Fotos de checklist: subida a Drive + hora real (EXIF) + verificación IA.
// Todo lo de aquí es "mejor esfuerzo": si el EXIF no está o la IA falla, la
// respuesta ya se ha guardado antes de llamar a nada de esto — el
// checklist nunca bloquea al empleado por un fallo de foto.
const exifr = require('exifr');
const { ensureFolderPath, uploadFile } = require('./google');
const { extraerJson, buildFileBlock } = require('./claude-json');

const MINUTOS_FOTO_ANTIGUA = 30;

// Hora real en la que se tomó la foto (EXIF DateTimeOriginal); si no hay
// EXIF o el formato no lo trae (frecuente en capturas ya recomprimidas),
// se usa la hora de subida — nunca se lanza por esto.
async function fechaTomadaFoto(buffer) {
  try {
    const exif = await exifr.parse(buffer, ['DateTimeOriginal']);
    if (exif?.DateTimeOriginal) return new Date(exif.DateTimeOriginal).toISOString();
  } catch (e) {
    console.warn('[checklist-fotos] no se pudo leer EXIF, se usa la hora de subida:', e.message);
  }
  return new Date().toISOString();
}

// Sube a Drive en cliente/checklists/AAAA-MM/ y calcula foto_antigua (más
// de 30 min entre la hora EXIF y la hora del servidor en el momento de
// subir).
async function subirFotoTarea({ cliente, fecha, tareaId, buffer, mimeType }) {
  const mes = fecha.slice(0, 7);
  const folderId = await ensureFolderPath([cliente, 'checklists', mes]);
  const ext = mimeType && mimeType.includes('png') ? 'png' : 'jpg';
  const nombre = `tarea-${tareaId}-${Date.now()}.${ext}`;
  const { id: foto_drive_id } = await uploadFile(nombre, buffer, folderId, mimeType || 'image/jpeg');

  const foto_tomada_at = await fechaTomadaFoto(buffer);
  const foto_antigua = (Date.now() - new Date(foto_tomada_at).getTime()) > MINUTOS_FOTO_ANTIGUA * 60 * 1000;

  return { foto_drive_id, foto_tomada_at, foto_antigua };
}

const VERIFICACION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    coincide:  { type: 'boolean' },
    motivo:    { type: 'string' },
    confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
  },
  required: ['coincide', 'motivo', 'confianza'],
};

// Se llama SIEMPRE de forma asíncrona (el caller no espera esto para
// responder al empleado). Un fallo aquí se registra y ya está — la
// respuesta queda guardada sin resultado de IA, revisable a mano.
async function verificarFoto(buffer, mimeType, descripcionTarea) {
  const texto = `Esta foto se subió para completar una tarea de un checklist de turno en
un restaurante. Descripción de la tarea: "${descripcionTarea || '(sin descripción)'}".
Compara la foto con lo que la tarea pide y devuelve SOLO:
{ coincide: boolean, motivo: string, confianza: "alta"|"media"|"baja" }
"coincide" es false si la foto claramente no corresponde a la tarea (en
blanco, borrosa, de otro sitio, un producto distinto, etc.). "confianza" es
tu seguridad en ESE juicio, no en si el trabajo está bien hecho.`;

  const { data } = await extraerJson({
    maxTokens: 512,
    effort: 'low',
    schema: VERIFICACION_SCHEMA,
    content: [buildFileBlock(buffer, mimeType || 'image/jpeg'), { type: 'text', text: texto }],
    mensajeError: 'La IA devolvió una respuesta incompleta al verificar la foto.',
  });
  return data;
}

module.exports = { subirFotoTarea, verificarFoto, MINUTOS_FOTO_ANTIGUA };
