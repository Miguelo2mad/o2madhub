// backend/agents/content-agent.js
// Agente Content Studio — escanea Drive por cliente y etiqueta assets con Claude Vision

const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

let supabase;
let anthropic;

function getSupabase() {
  if (!supabase) supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return supabase;
}

function getAnthropic() {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

// Auth Google Drive
async function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });
  return google.drive({ version: 'v3', auth });
}

// Listar archivos de una carpeta de Drive recursivamente
async function listDriveFiles(drive, folderId, clientId, clientName) {
  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/')`,
      fields: 'nextPageToken, files(id, name, mimeType, createdTime, webViewLink, webContentLink)',
      pageSize: 100,
      pageToken: pageToken || undefined
    });

    for (const file of res.data.files) {
      files.push({
        drive_file_id: file.id,
        file_name: file.name,
        file_type: file.mimeType.includes('video') ? 'video' : 'foto',
        drive_url: file.webViewLink,
        fecha_sesion: file.createdTime ? file.createdTime.split('T')[0] : null,
        client_id: clientId,
        client_name: clientName
      });
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

// Descargar thumbnail de imagen para análisis
async function getImageBase64(drive, fileId, mimeType) {
  try {
    if (mimeType.includes('video')) {
      // Para vídeos usamos el thumbnail de Drive
      const res = await drive.files.get({
        fileId,
        fields: 'thumbnailLink'
      });
      if (!res.data.thumbnailLink) return null;

      const axios = require('axios');
      const imgRes = await axios.get(res.data.thumbnailLink, { responseType: 'arraybuffer' });
      return Buffer.from(imgRes.data).toString('base64');
    } else {
      // Para fotos descargamos versión reducida
      const res = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' }
      );
      const buffer = Buffer.from(res.data);
      // Limitar a 1MB para Claude
      if (buffer.length > 1000000) {
        return buffer.slice(0, 1000000).toString('base64');
      }
      return buffer.toString('base64');
    }
  } catch (err) {
    console.error(`Error descargando archivo ${fileId}:`, err.message);
    return null;
  }
}

// Etiquetar asset con Claude Vision
async function tagAssetWithClaude(fileData, imageBase64) {
  try {
    if (!imageBase64 || imageBase64.length < 100) {
      console.log(`⚠️ Imagen sin contenido suficiente para ${fileData.file_name}, usando defaults`);
      return {
        tags: ['sin-etiquetar'],
        escena: 'No analizado',
        descripcion: 'Imagen no disponible para análisis',
        orientacion: 'horizontal',
        score_calidad: 5,
        apta_para_publicar: true
      };
    }

    const response = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: imageBase64
              }
            },
            {
              type: 'text',
              text: `Analiza esta imagen de un cliente de hostelería o restauración en Mallorca.

Devuelve SOLO un JSON válido sin markdown ni texto adicional:
{
  "tags": ["tag1", "tag2", "tag3"],
  "escena": "descripción breve de 5-8 palabras",
  "descripcion": "descripción de 1-2 frases",
  "orientacion": "vertical",
  "score_calidad": 7,
  "apta_para_publicar": true
}

Tags disponibles:
LUGAR: piscina, terraza, playa, habitacion, restaurante, bar, recepcion, jardin, exterior, interior
MOMENTO: amanecer, manana, mediodia, atardecer, noche
CONTENIDO: personas, familia, pareja, comida, bebida, coctel, detalle, paisaje, arquitectura
AMBIENTE: romantico, familiar, lujo, relax, animado, intimo, moderno
CALIDAD: luz-natural, luz-artificial, primer-plano, plano-general

orientacion: vertical | horizontal | cuadrado
score_calidad: 1-10
apta_para_publicar: false solo si hay logos competidores o mala calidad extrema`
            }
          ]
        }
      ]
    });

    const rawText = response?.content?.[0]?.text;

    if (!rawText || rawText.trim() === '' || rawText.trim() === 'undefined') {
      console.log(`⚠️ Claude devolvió respuesta vacía para ${fileData.file_name}`);
      return {
        tags: ['sin-etiquetar'],
        escena: 'Sin análisis',
        descripcion: '',
        orientacion: 'horizontal',
        score_calidad: 5,
        apta_para_publicar: true
      };
    }

    const clean = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    try {
      return JSON.parse(clean);
    } catch (parseErr) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      console.log(`⚠️ No se pudo parsear JSON para ${fileData.file_name}: ${clean.substring(0, 100)}`);
      return {
        tags: ['sin-etiquetar'],
        escena: 'Error de análisis',
        descripcion: '',
        orientacion: 'horizontal',
        score_calidad: 5,
        apta_para_publicar: true
      };
    }

  } catch (err) {
    console.error(`❌ Error Claude Vision para ${fileData.file_name}:`, err.message);
    return {
      tags: ['sin-etiquetar'],
      escena: 'Error de análisis',
      descripcion: '',
      orientacion: 'horizontal',
      score_calidad: 5,
      apta_para_publicar: true
    };
  }
}

// Proceso principal: escanear cliente
async function scanClientAssets(clientId, clientName, driveFolderId) {
  console.log(`\n🔍 Escaneando assets de ${clientName}...`);

  // Guardar estado inicial del scan
  await getSupabase().from('content_scan_status').upsert({
    client_id: clientId,
    status: 'running',
    total: 0,
    processed: 0,
    current_file: 'Conectando con Drive...',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: 'client_id' });

  const drive = await getDriveClient();

  // 1. Listar todos los archivos de Drive
  const files = await listDriveFiles(drive, driveFolderId, clientId, clientName);
  console.log(`📁 ${files.length} archivos encontrados en Drive`);

  // 2. Filtrar los que ya están en Supabase
  const { data: existing } = await getSupabase()
    .from('asset_library')
    .select('drive_file_id')
    .eq('client_id', clientId);

  const existingIds = new Set((existing || []).map(e => e.drive_file_id));
  const newFiles = files.filter(f => !existingIds.has(f.drive_file_id));
  console.log(`✨ ${newFiles.length} assets nuevos para etiquetar`);

  await getSupabase().from('content_scan_status').upsert({
    client_id: clientId,
    status: 'running',
    total: newFiles.length,
    processed: 0,
    current_file: `${newFiles.length} archivos encontrados, etiquetando...`,
    updated_at: new Date().toISOString()
  }, { onConflict: 'client_id' });

  // 3. Etiquetar en lotes paralelos de 5
  const BATCH_SIZE = 5;
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < newFiles.length; i += BATCH_SIZE) {
    const batch = newFiles.slice(i, i + BATCH_SIZE);

    await getSupabase().from('content_scan_status').upsert({
      client_id: clientId,
      status: 'running',
      total: newFiles.length,
      processed: processed,
      current_file: `Procesando lote ${Math.floor(i / BATCH_SIZE) + 1} de ${Math.ceil(newFiles.length / BATCH_SIZE)}...`,
      updated_at: new Date().toISOString()
    }, { onConflict: 'client_id' });

    const results = await Promise.allSettled(
      batch.map(async (file) => {
        try {
          const imageBase64 = await getImageBase64(drive, file.drive_file_id,
            file.file_type === 'video' ? 'video/mp4' : 'image/jpeg');

          let tagData = {
            tags: ['sin-etiquetar'],
            escena: 'Pendiente de análisis',
            descripcion: '',
            orientacion: 'horizontal',
            score_calidad: 5,
            apta_para_publicar: true
          };

          if (imageBase64) {
            tagData = await tagAssetWithClaude(file, imageBase64);
          }

          const { error } = await getSupabase().from('asset_library').upsert({
            ...file,
            ...tagData,
            updated_at: new Date().toISOString()
          }, { onConflict: 'drive_file_id' });

          if (error) throw new Error(error.message);
          return { ok: true, file: file.file_name };
        } catch (err) {
          console.error(`  ❌ Error procesando ${file.file_name}:`, err.message);
          return { ok: false, file: file.file_name, error: err.message };
        }
      })
    );

    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value.ok) processed++;
      else errors++;
    });

    console.log(`  Lote ${Math.floor(i / BATCH_SIZE) + 1} completado — ${processed}/${newFiles.length} procesados`);

    if (i + BATCH_SIZE < newFiles.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  await getSupabase().from('content_scan_status').upsert({
    client_id: clientId,
    status: 'completed',
    total: newFiles.length,
    processed: processed,
    current_file: 'Completado',
    finished_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: 'client_id' });

  console.log(`✅ ${clientName}: ${processed} assets procesados, ${errors} errores`);
  return { processed, errors, total: newFiles.length };
}

// Generar plan semanal con Claude
async function generateWeeklyPlan(clientId) {
  // 1. Cargar config del cliente
  const { data: config } = await getSupabase()
    .from('content_client_config')
    .select('*')
    .eq('client_id', clientId)
    .single();

  if (!config) throw new Error(`No hay configuración para cliente ${clientId}`);

  // 2. Cargar assets disponibles (no usados recientemente)
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 28);

  const { data: assets } = await getSupabase()
    .from('asset_library')
    .select('*')
    .eq('client_id', clientId)
    .eq('apta_para_publicar', true)
    .gte('score_calidad', 6)
    .or(`ultima_vez_usado.is.null,ultima_vez_usado.lt.${cutoffDate.toISOString()}`);

  if (!assets || assets.length === 0) {
    throw new Error('No hay assets disponibles para este cliente');
  }

  // 3. Calcular fechas de la semana
  const hoy = new Date();
  const lunes = new Date(hoy);
  lunes.setDate(hoy.getDate() + (1 - hoy.getDay() + 7) % 7);

  // 4. Generar plan con Claude
  const mix = config.mix_semanal;
  const totalPiezas = Object.values(mix).reduce((a, b) => a + b, 0);

  const assetsResumen = assets.slice(0, 30).map(a => ({
    id: a.id,
    nombre: a.file_name,
    tipo: a.file_type,
    tags: a.tags,
    escena: a.escena,
    score: a.score_calidad
  }));

  const prompt = `Eres el director creativo de O2MAD, agencia premium de marketing para hostelería en Mallorca.

CLIENTE: ${config.client_name}
PROMPT MAESTRO: ${config.prompt_maestro}
TONO: ${config.tono || 'Premium, aspiracional, emocional'}
PROHIBICIONES: ${config.prohibiciones || 'Ninguna específica'}
IDIOMAS: ${config.idiomas.join(', ')}
HASHTAGS FIJOS: ${config.hashtags_fijos.join(' ')}
HORA ÓPTIMA: ${config.hora_optima_publicacion}

MIX SEMANAL A GENERAR:
- Reels: ${mix.reels || 0}
- Fotos con copy: ${mix.foto || 0}
- Carruseles: ${mix.carrusel || 0}
- Stories: ${mix.story || 0}
TOTAL: ${totalPiezas} piezas

ASSETS DISPONIBLES EN DRIVE:
${JSON.stringify(assetsResumen, null, 2)}

SEMANA: del ${lunes.toLocaleDateString('es-ES')}

Genera el plan completo. Para cada pieza asigna el asset más adecuado según el tipo de contenido.

Devuelve SOLO un JSON válido con este formato:
{
  "piezas": [
    {
      "dia": 1,
      "fecha_publicacion": "2026-06-30",
      "tipo": "reel|foto|carrusel|story",
      "asset_id": "uuid-del-asset",
      "titulo": "Título interno de la pieza",
      "copy_caption": "Copy completo para el pie de la publicación con emojis si aplica y hashtags al final",
      "copy_superpuesto": "Frase corta para texto sobre imagen (solo si tipo es foto con overlay o carrusel)",
      "hora_publicacion": "19:00",
      "red": "instagram",
      "notas": "Nota interna para el equipo"
    }
  ]
}`;

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const rawText = response?.content?.[0]?.text;

  if (!rawText || rawText.trim() === '' || rawText.trim() === 'undefined') {
    throw new Error('Claude no devolvió un plan válido — respuesta vacía');
  }

  let plan;
  try {
    const clean = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
      plan = JSON.parse(clean);
    } catch (e) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) plan = JSON.parse(match[0]);
      else throw new Error('No se pudo extraer JSON del plan generado');
    }
  } catch (err) {
    throw new Error('Error parseando plan de Claude: ' + err.message);
  }

  // 5. Guardar plan en Supabase
  const domingo = new Date(lunes);
  domingo.setDate(lunes.getDate() + 6);

  // Borrar plan anterior de esta semana si existe
  await getSupabase()
    .from('content_plan')
    .delete()
    .eq('client_id', clientId)
    .eq('semana_inicio', lunes.toISOString().split('T')[0])
    .eq('estado', 'pendiente');

  const piezasParaGuardar = plan.piezas.map(p => ({
    client_id: clientId,
    client_name: config.client_name,
    semana_inicio: lunes.toISOString().split('T')[0],
    semana_fin: domingo.toISOString().split('T')[0],
    tipo: p.tipo,
    asset_id: p.asset_id || null,
    titulo: p.titulo,
    copy_caption: p.copy_caption,
    copy_superpuesto: p.copy_superpuesto || null,
    hashtags: config.hashtags_fijos,
    fecha_publicacion: p.fecha_publicacion,
    hora_publicacion: p.hora_publicacion || config.hora_optima_publicacion,
    red: p.red || 'instagram',
    estado: 'pendiente',
    notas: p.notas || null
  }));

  const { data: saved, error } = await getSupabase()
    .from('content_plan')
    .insert(piezasParaGuardar)
    .select();

  if (error) throw new Error(`Error guardando plan: ${error.message}`);

  console.log(`✅ Plan generado: ${saved.length} piezas para ${config.client_name}`);
  return saved;
}

module.exports = { scanClientAssets, generateWeeklyPlan };
