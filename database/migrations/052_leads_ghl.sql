-- Módulo Leads: contactos de todas las subcuentas (locations) de GoHighLevel.
-- clientes_ghl = una fila por subcuenta, mapeable a un cliente del hub
-- (crm_empresas). leads = un contacto de GHL con su atribución completa
-- (UTMs + raw) para cruzarlo más adelante con Meta Ads. Todas las fechas en
-- UTC; la agregación por día se hace en Europe/Madrid (vista leads_diarios).
-- Solo el backend (service role) lee/escribe estas tablas: RLS activado sin
-- políticas, y la vista con security_invoker para que no se salte el RLS.
-- Safe to re-run.

create table if not exists public.clientes_ghl (
  id            uuid primary key default gen_random_uuid(),
  location_id   text not null unique,
  nombre        text not null,
  cliente_id    uuid references public.crm_empresas(id) on delete set null,
  activo        boolean not null default true,
  token_privado text,
  ultima_sync   timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists public.leads (
  id             uuid primary key default gen_random_uuid(),
  ghl_contact_id text not null unique,
  location_id    text not null references public.clientes_ghl(location_id) on delete cascade,
  nombre         text,
  email          text,
  telefono       text,
  fuente         text,
  canal          text not null default 'otro',
  utm_source     text,
  utm_medium     text,
  utm_campaign   text,
  utm_content    text,
  tags           text[] not null default '{}',
  fecha_creacion timestamptz not null,
  raw            jsonb not null,
  synced_at      timestamptz not null default now()
);

alter table public.leads drop constraint if exists leads_canal_check;
alter table public.leads
  add constraint leads_canal_check
  check (canal in ('meta', 'google', 'organico', 'manual', 'otro'));

create index if not exists idx_leads_location_fecha on public.leads(location_id, fecha_creacion);
create index if not exists idx_leads_canal          on public.leads(canal);
create index if not exists idx_leads_utm_campaign   on public.leads(utm_campaign);

create table if not exists public.leads_sync_log (
  id                 uuid primary key default gen_random_uuid(),
  location_id        text,
  inicio             timestamptz not null,
  fin                timestamptz,
  leads_nuevos       int not null default 0,
  leads_actualizados int not null default 0,
  error              text
);

create index if not exists idx_leads_sync_log_inicio on public.leads_sync_log(inicio desc);

alter table public.clientes_ghl   enable row level security;
alter table public.leads          enable row level security;
alter table public.leads_sync_log enable row level security;

create or replace view public.leads_diarios
with (security_invoker = true) as
select
  location_id,
  (fecha_creacion at time zone 'Europe/Madrid')::date as dia,
  canal,
  count(*)::int as total
from public.leads
group by 1, 2, 3;
