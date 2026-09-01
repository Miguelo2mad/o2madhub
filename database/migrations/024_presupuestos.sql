create table if not exists presupuestos (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  numero text unique not null,               -- ej "PR-2026-0148"
  marca text not null default 'funnelshotel', -- funnelshotel | o2mad | oclinic | loprohibido
  cliente_nombre text not null,
  cliente_cif text,
  cliente_direccion text,
  cliente_contacto text,
  cliente_email text,
  cliente_telefono text,
  responsable text not null default 'Marc Oliver',
  fecha_emision date not null default current_date,
  fecha_inicio_estimada date,
  validez_dias int not null default 30,
  alcance_proyecto text,
  conceptos jsonb not null,        -- [{nombre, descripcion, cantidad, precio_unitario}]
  descuento_pct numeric default 0,
  iva_pct numeric default 21,
  subtotal numeric not null,
  descuento_importe numeric not null,
  iva_importe numeric not null,
  total numeric not null,
  estado text not null default 'Borrador', -- Borrador | Enviado | Visto | Firmado
  visto_at timestamptz,
  firmado_nombre text,
  firmado_dni text,
  firmado_at timestamptz,
  firmado_ip text,
  firmado_firma_png text,          -- dataURL del canvas
  created_at timestamptz default now()
);

create index if not exists idx_presupuestos_slug on presupuestos(slug);
