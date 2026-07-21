-- comarea_factura_lineas: desglose de líneas de producto por factura.
-- Fase 1 de detección de subidas de precio: solo EXTRAEMOS las líneas (producto,
-- cantidad, unidad, precio_unitario). La comparación de precios vs histórico es Fase 2.
-- Patrón idéntico a comarea_facturas (RLS + auth_role). Safe to re-run.

-- Flag de cordura del desglose: true si la suma de líneas cuadra con importe_base
-- (±2%). Se marca en el endpoint de subida; nunca bloquea el guardado.
alter table public.comarea_facturas
  add column if not exists lineas_verificadas boolean not null default false;

create table if not exists public.comarea_factura_lineas (
  id              bigserial       primary key,
  factura_id      bigint          not null
    references public.comarea_facturas(id) on delete cascade,
  producto        text,                       -- nombre del producto tal cual aparece
  cantidad        numeric(12, 3),
  unidad          text,                       -- kg, l, ud, caja... normalizado a minúsculas
  precio_unitario numeric(12, 4),
  importe_linea   numeric(12, 2),             -- cantidad × precio_unitario
  created_at      timestamptz     not null default now()
);

-- Índices para Fase 2: borrado/lectura por factura y búsqueda de histórico por producto.
create index if not exists comarea_factura_lineas_factura_id_idx
  on public.comarea_factura_lineas (factura_id);
create index if not exists comarea_factura_lineas_producto_idx
  on public.comarea_factura_lineas (producto);

alter table public.comarea_factura_lineas enable row level security;

-- READ: cualquier usuario autenticado
drop policy if exists "comarea_factura_lineas: read (authenticated)" on public.comarea_factura_lineas;
create policy "comarea_factura_lineas: read (authenticated)" on public.comarea_factura_lineas
  for select to authenticated using (true);

-- INSERT: cualquier usuario autenticado (se insertan junto con la factura)
drop policy if exists "comarea_factura_lineas: insert (authenticated)" on public.comarea_factura_lineas;
create policy "comarea_factura_lineas: insert (authenticated)" on public.comarea_factura_lineas
  for insert to authenticated with check (true);

-- UPDATE/DELETE: solo admins (el borrado normal llega por cascade al borrar la factura)
drop policy if exists "comarea_factura_lineas: admin update" on public.comarea_factura_lineas;
create policy "comarea_factura_lineas: admin update" on public.comarea_factura_lineas
  for update to authenticated
  using  (public.auth_role() = 'admin')
  with check (public.auth_role() = 'admin');

drop policy if exists "comarea_factura_lineas: admin delete" on public.comarea_factura_lineas;
create policy "comarea_factura_lineas: admin delete" on public.comarea_factura_lineas
  for delete to authenticated
  using (public.auth_role() = 'admin');
