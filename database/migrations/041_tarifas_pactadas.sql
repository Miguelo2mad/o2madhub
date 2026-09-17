-- Tarifas pactadas por proveedor, compartidas entre Timbol, Comarea y
-- cualquier cliente futuro (mismo patrón multi-cliente que empleados/
-- fichajes en 039_fichaje.sql: tablas únicas + columna `cliente`, sin
-- tabla por cliente). Safe to re-run.

create table if not exists public.proveedores (
  id              bigserial       primary key,
  cliente         text            not null,
  nif             text            not null,   -- normalizado: ver normalizarNif() en backend/lib/tarifas.js
  nombre          text            not null,
  tolerancia_pct  numeric(5, 2)   not null default 2,
  created_at      timestamptz     not null default now()
);

create unique index if not exists proveedores_cliente_nif_idx on public.proveedores (cliente, nif);

-- Una tarifa por proveedor y periodo. Al confirmar una nueva para el mismo
-- proveedor, la ingesta pone vigente_hasta = ayer en la anterior — nunca se
-- borra una tarifa. El índice único parcial (vigente_hasta is null) es la
-- garantía a nivel de BD de que no queden dos tarifas abiertas a la vez,
-- igual que fichajes_un_abierto_por_empleado en 039_fichaje.sql.
create table if not exists public.tarifas (
  id              bigserial       primary key,
  cliente         text            not null,
  proveedor_id    bigint          not null references public.proveedores(id) on delete cascade,
  nombre          text,                       -- ej. "Temporada 2027"; libre, UI de temporadas en una pasada posterior
  vigente_desde   date            not null,
  vigente_hasta   date,                       -- null = vigente actualmente
  origen_archivo  text,
  created_at      timestamptz     not null default now()
);

create index if not exists tarifas_cliente_proveedor_idx on public.tarifas (cliente, proveedor_id);
create unique index if not exists tarifas_una_vigente_por_proveedor
  on public.tarifas (cliente, proveedor_id)
  where vigente_hasta is null;

create table if not exists public.tarifa_productos (
  id              bigserial       primary key,
  tarifa_id       bigint          not null references public.tarifas(id) on delete cascade,
  producto        text            not null,
  unidad          text            not null,   -- normalizada: ver normalizarUnidad() en backend/lib/tarifas.js
  precio          numeric(12, 4)  not null,
  notas           text
);

create index if not exists tarifa_productos_tarifa_id_idx on public.tarifa_productos (tarifa_id);

-- Cada emparejamiento confirmado (por el usuario o por el modelo con
-- confianza alta) queda aquí. La comparación de una línea de factura
-- consulta esta tabla ANTES de llamar al modelo — normalizarTextoProducto()
-- se aplica igual al escribir texto_factura que al buscarlo, si no el join
-- nunca casa.
create table if not exists public.producto_alias (
  id              bigserial       primary key,
  cliente         text            not null,
  proveedor_id    bigint          not null references public.proveedores(id) on delete cascade,
  texto_factura   text            not null,   -- normalizado: ver normalizarTextoProducto()
  producto_tarifa text            not null,   -- nombre tal cual en tarifa_productos.producto
  created_at      timestamptz     not null default now()
);

create unique index if not exists producto_alias_cliente_proveedor_texto_idx
  on public.producto_alias (cliente, proveedor_id, texto_factura);

alter table public.proveedores      enable row level security;
alter table public.tarifas          enable row level security;
alter table public.tarifa_productos enable row level security;
alter table public.producto_alias   enable row level security;

-- Mismo patrón que timbol_facturas/comarea_facturas: lectura para cualquier
-- autenticado, escritura de alta para cualquier autenticado, update/delete
-- solo admin. El backend accede con la service role key (bypassa RLS); esto
-- es defensa en profundidad, no la barrera real — esa la ponen
-- requireAuth/requireRole en Express.
do $$
declare
  t text;
begin
  foreach t in array array['proveedores', 'tarifas', 'tarifa_productos', 'producto_alias']
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

-- Comparación en las líneas de factura ya existentes (Timbol y Comarea).
alter table public.timbol_factura_lineas
  add column if not exists producto_tarifa text,
  add column if not exists precio_pactado  numeric(12, 4),
  add column if not exists desviacion_eur  numeric(12, 2),
  add column if not exists desviacion_pct  numeric(7, 2),
  add column if not exists estado_precio   text;

alter table public.timbol_factura_lineas
  drop constraint if exists timbol_factura_lineas_estado_precio_check;
alter table public.timbol_factura_lineas
  add constraint timbol_factura_lineas_estado_precio_check
  check (estado_precio is null or estado_precio in ('ok', 'sobreprecio', 'bajo_precio', 'sin_tarifa', 'unidad_distinta', 'revisar'));

alter table public.comarea_factura_lineas
  add column if not exists producto_tarifa text,
  add column if not exists precio_pactado  numeric(12, 4),
  add column if not exists desviacion_eur  numeric(12, 2),
  add column if not exists desviacion_pct  numeric(7, 2),
  add column if not exists estado_precio   text;

alter table public.comarea_factura_lineas
  drop constraint if exists comarea_factura_lineas_estado_precio_check;
alter table public.comarea_factura_lineas
  add constraint comarea_factura_lineas_estado_precio_check
  check (estado_precio is null or estado_precio in ('ok', 'sobreprecio', 'bajo_precio', 'sin_tarifa', 'unidad_distinta', 'revisar'));

-- Total de sobreprecio de la factura (suma de desviaciones positivas de las
-- líneas en estado 'sobreprecio'), para /analytics/sobreprecios.
alter table public.timbol_facturas
  add column if not exists total_sobreprecio_eur numeric(12, 2) not null default 0;
alter table public.comarea_facturas
  add column if not exists total_sobreprecio_eur numeric(12, 2) not null default 0;
