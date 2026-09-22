-- Inventario estimado (Fase 2 del escandallo, ya prevista en 042): usa las
-- tablas platos/escandallo/plato_alias, que existen desde 042 pero siguen
-- vacías — su backend/UI es este módulo. Compartido por Timbol, Comarea y
-- cualquier cliente futuro, mismo patrón cliente + tabla única que el resto
-- del hub. Safe to re-run.

-- Punto de partida del stock de un ingrediente: "el día que Roman cuenta
-- algo a mano" resetea cantidad_inicial/fecha_inicial sin perder el
-- histórico de compras/ventas de antes — GET /inventario solo suma compras
-- y resta consumo teórico DESDE fecha_inicial, nunca desde el origen de los
-- tiempos. `unidad` es la unidad de referencia del ingrediente (la del
-- escandallo, o la de la última compra si aún no hay receta) — compras y
-- consumo se convierten a ella; lo no convertible se marca
-- unidad_conflicto en la respuesta del endpoint, nunca se sume mezclando
-- escalas.
create table if not exists public.inventario_stock (
  id                bigserial       primary key,
  cliente           text            not null,
  ingrediente_norm  text            not null,   -- normalizarTextoProducto(), ver backend/lib/tarifas.js
  unidad            text            not null,   -- normalizarUnidad(), ver backend/lib/tarifas.js
  cantidad_inicial  numeric(12, 4)  not null default 0,
  fecha_inicial     date            not null,
  updated_at        timestamptz     not null default now()
);

create unique index if not exists inventario_stock_cliente_ingrediente_idx
  on public.inventario_stock (cliente, ingrediente_norm);

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Mismo patrón que platos/escandallo/plato_alias (042): el backend accede
-- con la service role key (bypassa RLS); esto es defensa en profundidad.
alter table public.inventario_stock enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['inventario_stock']
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
