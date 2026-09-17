-- Ventas diarias y control de consumo, compartido por Timbol, Comarea y
-- cualquier cliente futuro (mismo patrón multi-cliente que fichaje.js y
-- tarifas.js: tablas únicas + columna `cliente`). Fase 1 (ventas_diarias,
-- ventas_diarias_historico, ventas_lineas, clientes_pos) se usa desde ya;
-- Fase 2 (platos, escandallo, plato_alias) va en la misma migración pero
-- su backend/UI llega en una pasada posterior. Safe to re-run.

-- ── Fase 1: ventas diarias ───────────────────────────────────────────────

-- Un cierre por día y cliente. Si llega uno nuevo para el mismo
-- (cliente, fecha), el backend mueve el existente a
-- ventas_diarias_historico antes de reemplazarlo — nunca se pierde.
create table if not exists public.ventas_diarias (
  id                    bigserial       primary key,
  cliente               text            not null,
  fecha                 date            not null,
  total_bruto           numeric(12, 2),
  total_neto            numeric(12, 2),
  num_tickets           integer,
  desglose_pago         jsonb           not null default '{}',   -- {efectivo, tarjeta, otros}
  origen                text            not null,                -- foto | api | manual
  origen_ref            text,                                    -- nombre de archivo, id de sync...
  detalle_por_articulo  boolean         not null default true,   -- false si el documento solo traía totales por familia
  created_at            timestamptz     not null default now()
);

create unique index if not exists ventas_diarias_cliente_fecha_idx on public.ventas_diarias (cliente, fecha);

alter table public.ventas_diarias
  drop constraint if exists ventas_diarias_origen_check;
alter table public.ventas_diarias
  add constraint ventas_diarias_origen_check check (origen in ('foto', 'api', 'manual'));

-- Copia congelada de una ventas_diarias sustituida por un cierre posterior
-- del mismo día. Mismas columnas + cuándo se sustituyó; sin unique (puede
-- haber varias versiones históricas del mismo día).
create table if not exists public.ventas_diarias_historico (
  id                    bigserial       primary key,
  venta_id_original     bigint,         -- id que tenía en ventas_diarias antes de sustituirse
  cliente               text            not null,
  fecha                 date            not null,
  total_bruto           numeric(12, 2),
  total_neto            numeric(12, 2),
  num_tickets           integer,
  desglose_pago         jsonb           not null default '{}',
  origen                text,
  origen_ref            text,
  detalle_por_articulo  boolean,
  created_at            timestamptz,
  reemplazado_at        timestamptz     not null default now()
);

create index if not exists ventas_diarias_historico_cliente_fecha_idx on public.ventas_diarias_historico (cliente, fecha);

-- cliente denormalizado a propósito: permite el índice (cliente,
-- producto_norm) para agregados de /analytics/ventas-producto sin un join
-- contra ventas_diarias en cada consulta.
create table if not exists public.ventas_lineas (
  id            bigserial       primary key,
  venta_id      bigint          not null references public.ventas_diarias(id) on delete cascade,
  cliente       text            not null,
  producto      text,
  producto_norm text,           -- normalizarTextoProducto(), ver backend/lib/tarifas.js
  cantidad      numeric(12, 3),
  importe       numeric(12, 2),
  familia       text
);

create index if not exists ventas_lineas_venta_id_idx on public.ventas_lineas (venta_id);
create index if not exists ventas_lineas_cliente_producto_norm_idx on public.ventas_lineas (cliente, producto_norm);

-- Config de integración por TPV. credenciales_cifradas: {iv, tag, data} en
-- base64 (AES-256-GCM, clave en la env var POS_CREDENTIALS_KEY — solo se
-- lee al cifrar/descifrar, nunca en el arranque; ver backend/lib/pos/).
create table if not exists public.clientes_pos (
  id                    bigserial       primary key,
  cliente               text            not null,
  adaptador             text            not null default 'manual',
  credenciales_cifradas jsonb,
  activo                boolean         not null default false,
  ultimo_sync_at        timestamptz,
  ultimo_sync_error     text,
  created_at            timestamptz     not null default now(),
  updated_at            timestamptz     not null default now()
);

create unique index if not exists clientes_pos_cliente_idx on public.clientes_pos (cliente);

-- ── Fase 2: escandallo y consumo teórico (UI en una pasada posterior) ────

create table if not exists public.platos (
  id          bigserial       primary key,
  cliente     text            not null,
  nombre      text            not null,
  nombre_norm text            not null,   -- normalizarTextoProducto()
  activo      boolean         not null default true,
  created_at  timestamptz     not null default now()
);

create unique index if not exists platos_cliente_nombre_norm_idx on public.platos (cliente, nombre_norm);

create table if not exists public.escandallo (
  id                bigserial       primary key,
  plato_id          bigint          not null references public.platos(id) on delete cascade,
  ingrediente       text            not null,
  ingrediente_norm  text            not null,   -- normalizarTextoProducto()
  cantidad          numeric(12, 4)  not null,
  unidad            text            not null    -- normalizarUnidad(), ver backend/lib/tarifas.js
);

create index if not exists escandallo_plato_id_idx on public.escandallo (plato_id);

-- Empareja el nombre de un plato tal como lo escupe el TPV (texto_tpv_norm,
-- normalizado) con el plato real — mismo patrón que producto_alias en
-- tarifas: se busca aquí antes de pedirle nada al modelo, se escribe solo
-- en corrección manual.
create table if not exists public.plato_alias (
  id              bigserial       primary key,
  cliente         text            not null,
  texto_tpv_norm  text            not null,
  plato_id        bigint          not null references public.platos(id) on delete cascade,
  created_at      timestamptz     not null default now()
);

create unique index if not exists plato_alias_cliente_texto_idx on public.plato_alias (cliente, texto_tpv_norm);

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Mismo patrón que timbol_facturas/tarifas: el backend accede con la
-- service role key (bypassa RLS) — esto es defensa en profundidad, no la
-- barrera real, que ponen requireAuth/requireRole en Express.
alter table public.ventas_diarias            enable row level security;
alter table public.ventas_diarias_historico  enable row level security;
alter table public.ventas_lineas             enable row level security;
alter table public.platos                    enable row level security;
alter table public.escandallo                enable row level security;
alter table public.plato_alias               enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['ventas_diarias', 'ventas_diarias_historico', 'ventas_lineas', 'platos', 'escandallo', 'plato_alias']
  loop
    execute format('drop policy if exists "%1$s: read (authenticated)" on public.%1$s', t);
    execute format('create policy "%1$s: read (authenticated)" on public.%1$s for select to authenticated using (true)', t);

    execute format('drop policy if exists "%1$s: insert (authenticated)" on public.%1$s', t);
    execute format('create policy "%1$s: insert (authenticated)" on public.%1$s for insert to authenticated with check (true)', t);

    execute format('drop policy if exists "%1$s: admin update" on public.%1$s', t);
    execute format('create policy "%1$s: admin update" on public.%1$s for update to authenticated using (public.auth_role() = ''admin'') with check (public.auth_role() = ''admin'')', t);

    execute format('drop policy if exists "%1$s: admin delete" on public.%1$s', t);
    execute format('create policy "%1$s: admin delete" on public.%1$s for delete to authenticated using (public.auth_role() = ''admin'')', t);
  end loop;
end $$;

-- clientes_pos guarda credenciales (aunque cifradas): RLS habilitado SIN
-- ninguna política, deny-by-default para anon/authenticated — mismo
-- criterio que empleados/fichajes en 039_fichaje.sql. Todo el acceso pasa
-- por el backend con la service role key.
alter table public.clientes_pos enable row level security;
