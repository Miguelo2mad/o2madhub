-- Leads: importaciones, calidad, embudo (oportunidades de GHL) y velocidad de respuesta.
-- 0. importado: contactos que entraron en una importación masiva (alta de la
--    subcuenta con su base de datos previa: Nadal 6.477 el 10-sep-2025,
--    Capilar 250 el 19-sep-2025). No son leads de ese día y se excluyen de
--    todo el módulo. Criterio: ≥30 altas en ±5 min (las altas reales nunca
--    pasan de ~6/min). Lo calcula el sync (leads-extras.js → marcarImportados).
-- 1. Calidad: es_duplicado / duplicado_de (mismo teléfono normalizado o email
--    dentro de la subcuenta; el primero por fecha es el original) y
--    sin_contacto (ni teléfono ni email). Los calcula el sync tras cada
--    subcuenta (backend/jobs/leads-sync.js → marcarDuplicados).
-- 2. leads_diarios excluye los importados y gana la columna "unicos" (no
--    duplicados), al final para poder hacer create or replace.
-- 3. ghl_pipelines (etapas tal cual en GHL, en su orden) y oportunidades
--    (una fila por oportunidad, enlazada al lead por contact_id).
-- 4. leads_respuesta: primer mensaje/llamada saliente tras el alta del lead
--    (cualquier origen y, aparte, el primero que no es de un workflow).
-- Solo backend (service role): RLS activado sin políticas.
-- Safe to re-run.

alter table public.leads
  add column if not exists importado boolean not null default false,
  add column if not exists es_duplicado boolean not null default false,
  add column if not exists duplicado_de text,
  add column if not exists sin_contacto boolean not null default false;

create or replace view public.leads_diarios
with (security_invoker = true) as
select
  location_id,
  (fecha_creacion at time zone 'Europe/Madrid')::date as dia,
  canal,
  count(*)::int as total,
  (count(*) filter (where not es_duplicado))::int as unicos
from public.leads
where not importado
group by 1, 2, 3;

create table if not exists public.ghl_pipelines (
  id          text primary key,
  location_id text not null references public.clientes_ghl(location_id) on delete cascade,
  nombre      text not null,
  etapas      jsonb not null default '[]',  -- [{ id, nombre, posicion }] en el orden de GHL
  synced_at   timestamptz not null default now()
);

create table if not exists public.oportunidades (
  id                    text primary key,          -- id de la oportunidad en GHL
  location_id           text not null references public.clientes_ghl(location_id) on delete cascade,
  contact_id            text,                      -- = leads.ghl_contact_id
  pipeline_id           text,
  etapa_id              text,
  estado                text,                      -- open | won | lost | abandoned
  valor                 numeric,
  nombre                text,
  fuente                text,
  creada_at             timestamptz,
  actualizada_at        timestamptz,
  cambio_estado_at      timestamptz,
  cambio_etapa_at       timestamptz,
  raw                   jsonb not null,
  synced_at             timestamptz not null default now()
);

create index if not exists idx_oportunidades_location_contact on public.oportunidades(location_id, contact_id);
create index if not exists idx_oportunidades_estado on public.oportunidades(location_id, estado);

create table if not exists public.leads_respuesta (
  ghl_contact_id     text primary key references public.leads(ghl_contact_id) on delete cascade,
  location_id        text not null,
  conversaciones     int not null default 0,     -- 0 = el contacto no tiene conversación en GHL
  primera_at         timestamptz,                -- primer saliente (mensaje o llamada), cualquier origen
  primera_tipo       text,                       -- TYPE_WHATSAPP, TYPE_SMS, TYPE_CALL, TYPE_EMAIL…
  primera_origen     text,                       -- app, workflow, mobile_app…
  primera_manual_at  timestamptz,                -- primer saliente que NO es de un workflow/campaña
  revisado_at        timestamptz not null default now()
);

create index if not exists idx_leads_respuesta_location on public.leads_respuesta(location_id);

alter table public.ghl_pipelines   enable row level security;
alter table public.oportunidades   enable row level security;
alter table public.leads_respuesta enable row level security;
