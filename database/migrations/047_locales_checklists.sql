-- Checklists de turno con validación fotográfica (Timbol, Comarea y
-- cualquier cliente futuro), apoyado en el módulo de fichaje (empleados,
-- url_token, PIN — ver 039_fichaje.sql). Safe to re-run.

-- ── Locales ──────────────────────────────────────────────────────────────
-- `locales.cliente` es texto libre (no una FK) porque todavía no existe una
-- tabla `clientes` en el hub — el aislamiento multi-cliente en todo
-- o2madhub se hace hoy por columna de texto en cada tabla (empleados.cliente,
-- ventas_diarias.cliente, etc.), no por relación. Cuando exista esa tabla
-- (próxima migración de acceso), añadir `locales.cliente_id` como FK y
-- mantener esta columna de texto EN PARALELO hasta la migración de datos
-- que la sustituya — no eliminarla de golpe, para no romper las queries
-- que ya filtran por este texto en todo el hub.
create table if not exists public.locales (
  id                      bigserial       primary key,
  cliente                 text            not null,
  nombre                  text            not null,
  dias_apertura           text[]          not null default array['lun','mar','mie','jue','vie','sab','dom'],
  numero_whatsapp_avisos  text,
  activo                  boolean         not null default true,
  created_at              timestamptz     not null default now()
);

create index if not exists locales_cliente_idx on public.locales (cliente);

alter table public.locales
  drop constraint if exists locales_dias_apertura_check;
alter table public.locales
  add constraint locales_dias_apertura_check
  check (dias_apertura <@ array['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom']::text[]);

-- Un local por defecto para cada cliente EXISTENTE (Timbol, Comarea), para
-- que nada de lo actual cambie. Va explícito (no derivado de otra tabla):
-- no hay un listado dinámico de clientes del que sacarlo, y derivarlo de
-- `empleados` se rompería si algún cliente aún no tiene ninguno dado de
-- alta. `where not exists` en vez de un unique(cliente): un cliente SÍ
-- podrá tener varios locales en el futuro, esto solo evita duplicar el
-- local por defecto si la migración se reejecuta.
insert into public.locales (cliente, nombre, dias_apertura)
select v.cliente, v.nombre, array['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom']
from (values ('timbol', 'Timbol'), ('comarea', 'Comarea')) as v(cliente, nombre)
where not exists (select 1 from public.locales l where l.cliente = v.cliente);

alter table public.empleados
  add column if not exists local_id bigint references public.locales(id);

update public.empleados e
set local_id = (select l.id from public.locales l where l.cliente = e.cliente order by l.id limit 1)
where e.local_id is null;

alter table public.locales enable row level security;

-- ── Checklists y tareas ──────────────────────────────────────────────────
create table if not exists public.checklists (
  id          bigserial       primary key,
  cliente     text            not null,
  local_id    bigint          not null references public.locales(id),
  nombre      text            not null,
  turno       text            not null check (turno in ('apertura', 'tarde', 'cierre', 'libre')),
  dias_semana text[],         -- null = todos los días de apertura del local
  activo      boolean         not null default true,
  created_at  timestamptz     not null default now()
);

create index if not exists checklists_local_idx on public.checklists (local_id);

alter table public.checklists
  drop constraint if exists checklists_dias_semana_check;
alter table public.checklists
  add constraint checklists_dias_semana_check
  check (dias_semana is null or dias_semana <@ array['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom']::text[]);

alter table public.checklists enable row level security;

create table if not exists public.checklist_tareas (
  id              bigserial       primary key,
  checklist_id    bigint          not null references public.checklists(id) on delete cascade,
  orden           integer         not null default 0,
  titulo          text            not null,
  descripcion     text,
  requiere_foto   boolean         not null default false,
  hora_limite     time,                          -- null = sin límite
  requiere_valor  boolean         not null default false,
  valor_etiqueta  text,
  valor_min       numeric(10, 2),
  valor_max       numeric(10, 2),
  activo          boolean         not null default true
);

create index if not exists checklist_tareas_checklist_idx on public.checklist_tareas (checklist_id, orden);

alter table public.checklist_tareas enable row level security;

create table if not exists public.checklist_asignaciones (
  id            bigserial       primary key,
  checklist_id  bigint          not null references public.checklists(id) on delete cascade,
  empleado_id   bigint          not null references public.empleados(id) on delete cascade
);

create unique index if not exists checklist_asignaciones_unica
  on public.checklist_asignaciones (checklist_id, empleado_id);

alter table public.checklist_asignaciones enable row level security;

-- ── Ejecuciones y respuestas del día ─────────────────────────────────────
create table if not exists public.checklist_ejecuciones (
  id             bigserial       primary key,
  cliente        text            not null,
  local_id       bigint          not null references public.locales(id),
  checklist_id   bigint          not null references public.checklists(id),
  fecha          date            not null,
  empleado_id    bigint          references public.empleados(id),   -- null hasta que alguien lo abre
  estado         text            not null default 'pendiente'
                 check (estado in ('pendiente', 'en_curso', 'completado', 'incompleto')),
  iniciado_at    timestamptz,
  completado_at  timestamptz,
  created_at     timestamptz     not null default now()
);

-- Una ejecución por checklist y día — también es lo que hace idempotente a
-- la generación diaria (cron 05:00) y a la generación bajo demanda si el
-- cron aún no ha corrido: intentar crear dos veces la misma no hace nada.
create unique index if not exists checklist_ejecuciones_unica
  on public.checklist_ejecuciones (checklist_id, fecha);

create index if not exists checklist_ejecuciones_cliente_fecha_idx
  on public.checklist_ejecuciones (cliente, fecha);

alter table public.checklist_ejecuciones enable row level security;

create table if not exists public.checklist_respuestas (
  id                 bigserial       primary key,
  ejecucion_id       bigint          not null references public.checklist_ejecuciones(id) on delete cascade,
  tarea_id           bigint          not null references public.checklist_tareas(id),
  empleado_id        bigint          not null references public.empleados(id),
  hecho              boolean         not null default false,
  valor              numeric(10, 2),
  foto_drive_id      text,
  foto_tomada_at     timestamptz,
  -- { coincide: bool, motivo: text, confianza: 'alta'|'media'|'baja', foto_antigua: bool }
  foto_verificacion  jsonb,
  fuera_rango        boolean         not null default false,
  respondido_at      timestamptz     not null default now()
);

-- Una respuesta por tarea y ejecución: volver a responder actualiza, no
-- duplica (mismo espíritu que el turno único de fichajes).
create unique index if not exists checklist_respuestas_unica
  on public.checklist_respuestas (ejecucion_id, tarea_id);

create index if not exists checklist_respuestas_ejecucion_idx
  on public.checklist_respuestas (ejecucion_id);

alter table public.checklist_respuestas enable row level security;

create table if not exists public.checklist_avisos (
  id            bigserial       primary key,
  ejecucion_id  bigint          not null references public.checklist_ejecuciones(id) on delete cascade,
  tarea_id      bigint          not null references public.checklist_tareas(id),
  enviado_at    timestamptz     not null default now(),
  -- 'pendiente' además de whatsapp/email: mientras notifications.js no
  -- tenga un canal WhatsApp/GHL real, el aviso se registra igual (para no
  -- volver a intentarlo) marcado como pendiente de envío real.
  canal         text            not null check (canal in ('whatsapp', 'email', 'pendiente')),
  destinatario  text
);

-- Un aviso por tarea y ejecución (= por tarea y día): nunca se repite.
create unique index if not exists checklist_avisos_unica
  on public.checklist_avisos (ejecucion_id, tarea_id);

alter table public.checklist_avisos enable row level security;

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Deny-by-default, igual que fichaje (039): datos ligados a empleados
-- concretos (respuestas, fotos, avisos) y a la operativa interna del
-- local. Todo el acceso pasa por el backend con la service role key; RLS
-- habilitado sin ninguna política es defensa en profundidad, no la
-- barrera real.
