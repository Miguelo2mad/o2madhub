// Módulo 7 — Presupuestos. Rutas públicas: GET/POST /presupuestos/p/:slug.
// Rutas internas (requireAuth): POST/GET /api/presupuestos (montadas en index.js).
const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const { supabase } = require('../lib/supabase');

const router = express.Router();

const TMPL_PATH = path.join(__dirname, '..', '..', 'docs', 'presupuesto-template.html');

// ── Auth (igual que timbol: token = base64('presupuestos:timestamp')) ────────

function requireAuth(req, res, next) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!raw) return res.status(401).json({ error: 'No autorizado' });
  try {
    const decoded = Buffer.from(raw, 'base64').toString();
    const envPass = process.env.PRESUPUESTOS_PASS;
    if (!envPass) return res.status(401).json({ error: 'No autorizado' });
    // Token: 'presupuestos:PASSWORD:timestamp'
    const parts = decoded.split(':');
    if (parts[0] !== 'presupuestos' || parts[1] !== envPass) {
      return res.status(401).json({ error: 'No autorizado' });
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateSlug() {
  return crypto.randomBytes(8).toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 10)
    .toLowerCase();
}

async function generarNumero() {
  const year   = new Date().getFullYear();
  const prefix = `PR-${year}-`;
  const { data } = await supabase
    .from('presupuestos')
    .select('numero')
    .like('numero', `${prefix}%`)
    .order('numero', { ascending: false })
    .limit(1);
  const last = data?.[0]?.numero;
  const seq  = last ? parseInt(last.slice(-4), 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

function calcTotales(conceptos, descuento_pct) {
  const subtotal          = conceptos.reduce((s, c) => s + (Number(c.cantidad) * Number(c.precio_unitario)), 0);
  const descuento_importe = subtotal * (Number(descuento_pct) || 0) / 100;
  const base              = subtotal - descuento_importe;
  const iva_importe       = base * 0.21;
  const total             = base + iva_importe;
  return {
    subtotal:          parseFloat(subtotal.toFixed(2)),
    descuento_importe: parseFloat(descuento_importe.toFixed(2)),
    iva_importe:       parseFloat(iva_importe.toFixed(2)),
    total:             parseFloat(total.toFixed(2)),
  };
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtMoney(n) {
  return Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
}

function renderTemplate(p) {
  let html = fs.readFileSync(TMPL_PATH, 'utf8');

  const fechaValidez = (() => {
    const d = new Date(p.fecha_emision);
    d.setDate(d.getDate() + p.validez_dias);
    return fmtDate(d.toISOString().slice(0, 10));
  })();

  const conceptos = Array.isArray(p.conceptos) ? p.conceptos : [];
  const conceptosRows = conceptos.map(c => {
    const importe = Number(c.cantidad) * Number(c.precio_unitario);
    return `<tr>
      <td>${esc(c.nombre)}</td>
      <td class="desc">${esc(c.descripcion || '')}</td>
      <td class="num">${c.cantidad}</td>
      <td class="num">${fmtMoney(c.precio_unitario)}</td>
      <td class="num imp">${fmtMoney(importe)}</td>
    </tr>`;
  }).join('\n');

  const rep = (key, val) => { html = html.split(`{{${key}}}`).join(val ?? ''); };

  rep('NUMERO',                p.numero);
  rep('FECHA_EMISION',         fmtDate(p.fecha_emision));
  rep('FECHA_INICIO_ESTIMADA', fmtDate(p.fecha_inicio_estimada));
  rep('FECHA_VALIDEZ',         fechaValidez);
  rep('CLIENTE_NOMBRE',        esc(p.cliente_nombre));
  rep('CLIENTE_CIF',           esc(p.cliente_cif || '—'));
  rep('CLIENTE_DIRECCION',     esc(p.cliente_direccion || '—'));
  rep('CLIENTE_CONTACTO',      esc(p.cliente_contacto || '—'));
  rep('CLIENTE_EMAIL',         esc(p.cliente_email || '—'));
  rep('CLIENTE_TELEFONO',      esc(p.cliente_telefono || '—'));
  rep('RESPONSABLE',           esc(p.responsable));
  rep('ALCANCE_PROYECTO',      esc(p.alcance_proyecto || '').replace(/\n/g, '<br>'));
  rep('CONCEPTOS_ROWS',        conceptosRows);
  rep('SUBTOTAL',              fmtMoney(p.subtotal));
  rep('DESCUENTO_PCT',         Number(p.descuento_pct || 0).toFixed(0));
  rep('DESCUENTO_IMPORTE',     fmtMoney(p.descuento_importe));
  rep('BASE_IMPONIBLE',        fmtMoney(p.subtotal - p.descuento_importe));
  rep('IVA_IMPORTE',           fmtMoney(p.iva_importe));
  rep('TOTAL',                 fmtMoney(p.total));
  rep('ESTADO',                esc(p.estado));
  rep('SLUG',                  esc(p.slug));
  rep('MARCA',                 esc(p.marca));
  rep('RESPONSABLE_EMAIL',     'marc@funnelshotel.com');

  return html;
}

// ── Rutas públicas (sin auth) ─────────────────────────────────────────────────

// GET /presupuestos/p/:slug — renderiza el presupuesto
router.get('/p/:slug', async (req, res) => {
  const { slug } = req.params;
  const { data: p, error } = await supabase
    .from('presupuestos').select('*').eq('slug', slug).single();

  if (error || !p) {
    return res.status(404).send('<!DOCTYPE html><html><body><h2 style="font-family:sans-serif;padding:40px">Presupuesto no encontrado</h2></body></html>');
  }

  if (p.estado === 'Borrador' || p.estado === 'Enviado') {
    await supabase
      .from('presupuestos')
      .update({ estado: 'Visto', visto_at: new Date().toISOString() })
      .eq('slug', slug)
      .neq('estado', 'Firmado');
  }

  if (!fs.existsSync(TMPL_PATH)) {
    return res.status(500).send('<!DOCTYPE html><html><body><h2 style="font-family:sans-serif;padding:40px">Plantilla no configurada</h2></body></html>');
  }

  try {
    const html = renderTemplate(p);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('[presupuestos] render error:', e.message);
    res.status(500).send('Error al renderizar el presupuesto');
  }
});

// POST /presupuestos/p/:slug/firmar — firma pública del cliente
router.post('/p/:slug/firmar', async (req, res) => {
  const { slug } = req.params;
  const { nombre, dni, firma_png } = req.body || {};

  if (!nombre || !dni || !firma_png) {
    return res.status(400).json({ error: 'nombre, dni y firma_png son requeridos' });
  }

  const { data: p, error } = await supabase
    .from('presupuestos').select('id, estado').eq('slug', slug).single();

  if (error || !p) return res.status(404).json({ error: 'Presupuesto no encontrado' });
  if (p.estado === 'Firmado') return res.status(409).json({ error: 'El presupuesto ya está firmado' });

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;

  const { error: updErr } = await supabase.from('presupuestos').update({
    estado:           'Firmado',
    firmado_nombre:   nombre,
    firmado_dni:      dni,
    firmado_firma_png: firma_png,
    firmado_at:       new Date().toISOString(),
    firmado_ip:       ip,
  }).eq('slug', slug);

  if (updErr) {
    console.error('[presupuestos] firmar error:', updErr.message);
    return res.status(500).json({ error: updErr.message });
  }

  console.log(`[presupuestos] ✓ firmado ${slug} — ${nombre} (${ip})`);
  res.json({ ok: true });
});

// ── Rutas internas (requireAuth) ─────────────────────────────────────────────

// POST /api/presupuestos — crear presupuesto
router.post('/', requireAuth, async (req, res) => {
  const {
    marca = 'funnelshotel',
    cliente_nombre, cliente_cif, cliente_direccion,
    cliente_contacto, cliente_email, cliente_telefono,
    responsable = 'Marc Oliver',
    fecha_inicio_estimada, validez_dias = 30,
    alcance_proyecto,
    conceptos = [],
    descuento_pct = 0,
  } = req.body || {};

  if (!cliente_nombre) return res.status(400).json({ error: 'cliente_nombre es requerido' });
  if (!conceptos.length) return res.status(400).json({ error: 'Se requiere al menos un concepto' });

  const totales = calcTotales(conceptos, descuento_pct);

  let numero, slug;
  let attempts = 0;

  while (attempts < 5) {
    try {
      numero = await generarNumero();
      slug   = generateSlug();

      const row = {
        slug, numero, marca,
        cliente_nombre, cliente_cif, cliente_direccion,
        cliente_contacto, cliente_email, cliente_telefono,
        responsable,
        fecha_inicio_estimada: fecha_inicio_estimada || null,
        validez_dias: Number(validez_dias),
        alcance_proyecto,
        conceptos,
        descuento_pct: Number(descuento_pct),
        iva_pct: 21,
        ...totales,
      };

      const { error } = await supabase.from('presupuestos').insert(row);
      if (error) {
        if (error.code === '23505' && attempts < 4) { attempts++; continue; }
        throw new Error(error.message);
      }
      break;
    } catch (e) {
      if (attempts >= 4) {
        console.error('[presupuestos] crear error:', e.message);
        return res.status(500).json({ error: e.message });
      }
      attempts++;
    }
  }

  const baseUrl = process.env.RAILWAY_URL || `http://localhost:${process.env.PORT || 8080}`;
  console.log(`[presupuestos] ✓ creado ${numero} (${slug}) — ${cliente_nombre}`);
  res.json({
    slug,
    numero,
    url: `${baseUrl}/presupuestos/p/${slug}`,
  });
});

// GET /api/presupuestos — listado interno
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('presupuestos')
    .select('id, slug, numero, marca, cliente_nombre, cliente_email, responsable, total, estado, created_at, firmado_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
