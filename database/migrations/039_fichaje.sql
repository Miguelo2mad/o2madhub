-- Fichaje de personal: módulo reutilizable parametrizado por cliente (texto
-- libre en `empleados.cliente`, igual que el resto del hub). No es un
-- registro legal de jornada — el objetivo único es horas en tiempo real y
-- euros de extras a fin de mes. Safe to re-run.
--
-- Sensible por definición (PIN hasheados + horario de personas): a
-- diferencia de timbol_facturas/comarea_facturas, aquí NO se abre lectura a
-- `authenticated` vía Supabase Auth. Todo el acceso pasa por el backend con
-- el service role key (ver backend/lib/supabase.js), así que RLS queda
-- habilitado sin ninguna política — deny-by-default para anon/authenticated.

create table if not exists public.empleados (
  id                bigserial       primary key,
  cliente           text            not null,
  nombre            text            not null,
  puesto            text,
  horas_semana      numeric(5, 2)   not null,
  precio_hora_extra numeric(8, 2)   not null,
  pin_hash          text            not null,
  url_token         text            not null unique,
  activo            boolean         not null default true,
  created_at        timestamptz     not null default now(),
  updated_at        timestamptz     not null default now()
);

create index if not exists empleados_cliente_idx on public.empleados (cliente);

alter table public.empleados enable row level security;

create table if not exists public.fichajes (
  id           bigserial       primary key,
  empleado_id  bigint          not null references public.empleados(id),
  entrada_at   timestamptz     not null,
  salida_at    timestamptz,
  -- Turno abierto >12h: deja de sumar y se marca aquí en vez de inventar una
  -- hora de salida. Excluido de extras hasta que un gestor/admin lo corrija
  -- vía PATCH /fichaje/:id (ver backend/lib/fichaje-calc.js).
  incidencia   boolean         not null default false,
  created_at   timestamptz     not null default now()
);

create index if not exists fichajes_empleado_entrada_idx on public.fichajes (empleado_id, entrada_at);

-- Un empleado no puede tener dos turnos abiertos: lo garantiza la propia
-- base de datos (no solo el backend) para que una doble pulsación no cree
-- dos filas con salida_at null. El backend traduce la violación (23505) a
-- un 409 "ya tienes un turno abierto".
create unique index if not exists fichajes_un_abierto_por_empleado
  on public.fichajes (empleado_id)
  where salida_at is null;

alter table public.fichajes enable row level security;

-- Auditoría de correcciones manuales de entrada_at/salida_at. El fichaje
-- original nunca se borra ni se sobrescribe sin dejar rastro: si hay una
-- discusión con un empleado sobre sus horas, esta tabla la resuelve.
create table if not exists public.fichajes_correcciones (
  id             bigserial       primary key,
  fichaje_id     bigint          not null references public.fichajes(id),
  campo          text            not null check (campo in ('entrada_at', 'salida_at')),
  valor_anterior timestamptz,
  valor_nuevo    timestamptz,
  autor          text            not null,
  motivo         text            not null,
  created_at     timestamptz     not null default now()
);

create index if not exists fichajes_correcciones_fichaje_idx on public.fichajes_correcciones (fichaje_id);

alter table public.fichajes_correcciones enable row level security;

-- Snapshots congelados del informe mensual: precio_hora_extra vigente en el
-- momento de generar, no el actual. Cada generación (JSON o CSV) inserta una
-- fila nueva; las anteriores se conservan, nunca se sobrescriben.
create table if not exists public.informes_fichaje (
  id           bigserial       primary key,
  cliente      text            not null,
  mes          text            not null,   -- 'YYYY-MM'
  generado_at  timestamptz     not null default now(),
  detalle      jsonb           not null
);

create index if not exists informes_fichaje_cliente_mes_idx on public.informes_fichaje (cliente, mes);

alter table public.informes_fichaje enable row level security;
