-- Personal — gastos: nóminas y Seguridad Social como gasto archivado, para
-- Timbol, Comarea y clientes futuros. No calcula nóminas: solo guarda lo
-- que manda la gestoría (tipo de documento, periodo, empleado si aplica e
-- importe total). Nunca se guardan bases de cotización, IRPF ni ningún
-- desglose. Safe to re-run.
--
-- Sensible por definición (nóminas ligadas a personas): mismo criterio que
-- empleados/fichajes (migración 039) — RLS habilitado sin ninguna política,
-- deny-by-default para anon/authenticated. Todo el acceso pasa por el
-- backend con el service role key.
create table if not exists public.gastos_personal (
  id            bigserial       primary key,
  cliente       text            not null,
  tipo          text            not null,
  -- Nullable en AMBOS tipos: en 'nomina' significa que la extracción no
  -- pudo emparejar el nombre con empleados.nombre y queda pendiente de
  -- asignar desde la vista previa; en 'seguridad_social' es el caso
  -- normal, ya que suele ser un pago agregado de todos los empleados.
  empleado_id   bigint          references public.empleados(id),
  periodo       date            not null, -- primer día del mes que cubre
  importe       numeric(12, 2)  not null,
  drive_file_id text,
  origen        text            not null,
  created_at    timestamptz     not null default now()
);

alter table public.gastos_personal
  drop constraint if exists gastos_personal_tipo_check;
alter table public.gastos_personal
  add constraint gastos_personal_tipo_check
  check (tipo in ('nomina', 'seguridad_social'));

alter table public.gastos_personal
  drop constraint if exists gastos_personal_origen_check;
alter table public.gastos_personal
  add constraint gastos_personal_origen_check
  check (origen in ('foto', 'pdf', 'manual'));

create index if not exists gastos_personal_cliente_periodo_idx
  on public.gastos_personal (cliente, periodo);

-- Evita duplicar la nómina del mismo empleado en el mismo mes (ej. subir el
-- mismo PDF dos veces, o una vez por foto y otra por email). Solo aplica
-- cuando hay empleado emparejado: un pago agregado de Seguridad Social
-- (empleado_id null) puede llegar en varios recibos el mismo mes sin que
-- eso sea un duplicado.
create unique index if not exists gastos_personal_dedupe_idx
  on public.gastos_personal (cliente, tipo, empleado_id, periodo)
  where empleado_id is not null;

alter table public.gastos_personal enable row level security;
