-- Módulo de Banco: extractos bancarios semanales cruzados con facturas y
-- ventas. Compartido por Timbol, Comarea y cualquier cliente futuro, mismo
-- patrón cliente + tabla única que el resto del hub. Safe to re-run.

-- referencia_id es polimórfico A PROPÓSITO (sin foreign key): según
-- tipo_conciliacion apunta a timbol_facturas/comarea_facturas.id o a
-- ventas_diarias.id. 'nomina' es la única excepción: el módulo de personal
-- (gastos_personal) todavía no existe, así que por ahora solo se puede
-- fijar a mano vía PATCH /banco/:id/conciliar con referencia_id null —
-- la conciliación automática nunca la usa. El día que exista esa tabla,
-- referencia_id sí apuntará a ella para 'nomina'.
create table if not exists public.movimientos_banco (
  id                bigserial       primary key,
  cliente           text            not null,
  fecha             date            not null,
  concepto          text            not null,   -- tal cual el extracto
  concepto_norm     text            not null,   -- normalizarTextoProducto(), ver backend/lib/tarifas.js
  importe           numeric(12, 2)  not null,   -- positivo = ingreso, negativo = cargo
  saldo             numeric(12, 2),             -- null si el extracto no lo trae
  origen_archivo    text,
  conciliado        boolean         not null default false,
  tipo_conciliacion text,                       -- factura | venta | nomina | otro
  referencia_id     bigint,                     -- id de la factura/venta conciliada; null en 'nomina' y 'otro'
  created_at        timestamptz     not null default now()
);

alter table public.movimientos_banco
  drop constraint if exists movimientos_banco_tipo_conciliacion_check;
alter table public.movimientos_banco
  add constraint movimientos_banco_tipo_conciliacion_check
  check (tipo_conciliacion is null or tipo_conciliacion in ('factura', 'venta', 'nomina', 'otro'));

create index if not exists movimientos_banco_cliente_fecha_idx
  on public.movimientos_banco (cliente, fecha);

-- Evita subir el mismo extracto (o una semana solapada con la anterior)
-- dos veces: mismo cliente, fecha, concepto normalizado e importe exactos.
create unique index if not exists movimientos_banco_dedupe_idx
  on public.movimientos_banco (cliente, fecha, concepto_norm, importe);

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Mismo patrón que el resto del hub: el backend accede con la service role
-- key (bypassa RLS); esto es defensa en profundidad.
alter table public.movimientos_banco enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['movimientos_banco']
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
