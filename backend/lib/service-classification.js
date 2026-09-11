'use strict';
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORIES = [
  'SEO', 'GOOGLE_ADS', 'META_ADS', 'SOCIAL_MEDIA', 'WEB_DESIGN', 'WEB_DEVELOPMENT',
  'ECOMMERCE', 'PHOTO', 'VIDEO', 'BRANDING', 'CONTENT', 'AI_AUTOMATION',
  'WHATSAPP_AI', 'VOICE_AI', 'CRM', 'CONSULTING', 'HOSTING', 'MAINTENANCE', 'OTHER',
];

// Rules applied in order; first match wins.
// Descriptions are lowercased and diacritics stripped before matching.
const RULES = [
  { category: 'VOICE_AI',        patterns: [/ia\s+de\s+voz/, /voz\s+ia/, /voice\s*ai/, /agente\s+de\s+voz/] },
  { category: 'WHATSAPP_AI',     patterns: [/whatsapp/] },
  // CRM before AI_AUTOMATION so "active campaing crm" maps to CRM, not AI_AUTOMATION
  { category: 'CRM',             patterns: [/\bcrm\b/, /salesforce/, /hubspot/, /pipedrive/] },
  { category: 'AI_AUTOMATION',   patterns: [/active\s*camp/, /activecampaign/, /zapier/, /automatizac/, /chatbot/, /chat\s*gpt/, /\bgpt\b/] },
  { category: 'VIDEO',           patterns: [/\bvideo/, /audiovisual/, /grabacion/, /\breels\b/] },
  { category: 'PHOTO',           patterns: [/fotografi/, /sesion\s+foto/, /reportaje\s+foto/, /foto\s+product/] },
  { category: 'BRANDING',        patterns: [/\bbranding\b/, /identidad\s+visual/, /identidad\s+corporat/, /imagen\s+corporat/, /\blogo\b/, /logotipo/, /manual\s+de\s+marca/] },
  { category: 'GOOGLE_ADS',      patterns: [/google\s+ads/, /adwords/, /\bsem\b/, /campana\s+google/] },
  { category: 'META_ADS',        patterns: [/meta\s+ads/, /facebook\s+ads/, /instagram\s+ads/, /campana\s+facebook/, /campana\s+instagram/, /campana\s+meta/] },
  // ECOMMERCE: funnels de hotel son producto core de O2MAD (motor de reservas + CRO)
  { category: 'ECOMMERCE',       patterns: [/funnel/, /motor\s+de\s+reservas/, /motor\s+reservas/, /ecommerce/, /e-commerce/, /tienda\s+online/, /woocommerce/, /shopify/, /prestashop/] },
  // SOCIAL_MEDIA: "router social" es la plataforma de O2MAD para distribución en RRSS
  { category: 'SOCIAL_MEDIA',    patterns: [/redes\s+sociales/, /social\s+media/, /\brrss\b/, /router\s+social/, /gestion\s+de?\s+redes/, /gestion\s+rrss/, /publicaciones\s+en/, /tik.?tok/, /community\s+manag/, /socialmedia/] },
  { category: 'SEO',             patterns: [/\bseo\b/, /posicionamiento\s+web/, /posicionamiento\s+google/, /link\s+build/] },
  // CONTENT: "router multimedia" is O2MAD's multimedia content platform
  { category: 'CONTENT',         patterns: [/\bcontenido/, /redaccion/, /copywriting/, /\bcopy\b/, /\bblog\b/, /router\s+multimedia/, /\bmultimedia\b/] },
  { category: 'WEB_DESIGN',      patterns: [/diseno\s+web/, /web\s+design/, /landing\s+page/, /maquetacion/, /\bux\b/, /\bui\b/, /wireframe/] },
  { category: 'HOSTING',         patterns: [/\bhosting\b/, /\bcms\b/, /alojamiento\s+web/, /\bdominio\b/, /\bssl\b/] },
  { category: 'MAINTENANCE',     patterns: [/mantenimiento\s+web/, /mantenimiento\s+word/, /soporte\s+tec/, /actualizacion\s+web/, /\bbackup\b/] },
  { category: 'WEB_DEVELOPMENT', patterns: [/desarrollo\s+web/, /programacion/, /desarrollo\s+app/, /app\s+movil/, /software\s+a\s+medida/] },
  { category: 'CONSULTING',      patterns: [/marketing\s+online/, /marketing\s+digital/, /servicios\s+de\s+marketing/, /consultoria/, /estrategia\s+digital/, /plan\s+de\s+marketing/] },
];

function normalize(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function classifyByRules(description) {
  const d = normalize(description);
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      if (p.test(d)) return rule.category;
    }
  }
  return null;
}

const AI_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:       { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
        },
        required: ['id', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

const SYSTEM_CLASSIFY = `Eres un clasificador de servicios de agencia de marketing digital.
Asigna cada línea de factura a UNA de estas categorías:
${CATEGORIES.join(', ')}

Criterios:
- SEO: posicionamiento orgánico, link building, auditoría SEO
- GOOGLE_ADS: campañas de pago en Google (SEM, Display, Search Ads)
- META_ADS: campañas de pago en Facebook/Instagram/Meta
- SOCIAL_MEDIA: gestión orgánica de redes sociales, community management
- CONTENT: creación de contenido, blog, redacción, copywriting
- WEB_DESIGN: diseño de páginas web, landing pages, UX/UI
- WEB_DEVELOPMENT: programación, desarrollo a medida, apps
- HOSTING: hosting, dominios, servidores, SSL, CMS
- MAINTENANCE: mantenimiento y soporte técnico web
- ECOMMERCE: tiendas online
- PHOTO: fotografía de producto, reportaje fotográfico
- VIDEO: producción de vídeo, reels, audiovisual
- BRANDING: identidad de marca, logos, manuales corporativos
- AI_AUTOMATION: automatización con IA, email marketing automation (ActiveCampaign, Zapier)
- WHATSAPP_AI: chatbot o agente IA para WhatsApp
- VOICE_AI: agente de voz con IA
- CRM: software CRM (Salesforce, HubSpot, Pipedrive)
- CONSULTING: estrategia de marketing, consultoría digital
- OTHER: si no encaja en ninguna categoría anterior`;

// lines: [{id: string, description: string}]
async function classifyBatch(lines) {
  const prompt = `Clasifica estas líneas de factura:\n\n${lines.map(l => `${l.id}: ${l.description || '(sin descripción)'}`).join('\n')}`;

  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: SYSTEM_CLASSIFY,
    output_config: {
      format: {
        type: 'json_schema',
        schema: AI_SCHEMA,
      },
    },
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.content.find(b => b.type === 'text')?.text || '{}';
  return JSON.parse(text).results || [];
}

module.exports = { classifyByRules, classifyBatch, CATEGORIES, RULES, normalize };
