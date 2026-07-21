-- timbol_facturas: facturas de proveedores subidas manualmente por Timbol.
-- Patrón idéntico a comarea_facturas + profiles (RLS + auth_role). Safe to re-run.

create table if not exists public.timbol_facturas (
  id             bigserial       primary key,
  proveedor      text            not null,
  numero_factura text,
  fecha_factura  date,
  importe_total  numeric(12, 2),
  importe_base   numeric(12, 2),
  iva_porcentaje numeric(5,  2),
  concepto       text,
  cif_proveedor  text,
  desviacion     numeric(12, 2),   -- desviación vs presupuesto, rellenar manualmente
  drive_file_id  text,
  drive_url      text,
  mes            smallint,
  anyo           smallint,
  subido_por     text,
  created_at     timestamptz     not null default now()
);

alter table public.timbol_facturas enable row level security;

-- READ: cualquier usuario autenticado
drop policy if exists "timbol_facturas: read (authenticated)" on public.timbol_facturas;
create policy "timbol_facturas: read (authenticated)" on public.timbol_facturas
  for select to authenticated using (true);

-- INSERT: cualquier usuario autenticado (gestores y admins pueden subir facturas)
drop policy if exists "timbol_facturas: insert (authenticated)" on public.timbol_facturas;
create policy "timbol_facturas: insert (authenticated)" on public.timbol_facturas
  for insert to authenticated with check (true);

-- UPDATE/DELETE: solo admins
drop policy if exists "timbol_facturas: admin update" on public.timbol_facturas;
create policy "timbol_facturas: admin update" on public.timbol_facturas
  for update to authenticated
  using  (public.auth_role() = 'admin')
  with check (public.auth_role() = 'admin');

drop policy if exists "timbol_facturas: admin delete" on public.timbol_facturas;
create policy "timbol_facturas: admin delete" on public.timbol_facturas
  for delete to authenticated
  using (public.auth_role() = 'admin');
