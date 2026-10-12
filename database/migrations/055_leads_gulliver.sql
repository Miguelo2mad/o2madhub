-- Leads: integración con Gulliver AI (atención por WhatsApp/voz y citas).
-- Gulliver (proyecto Supabase erulwscrixuvrtzirabz) expone en solo lectura
-- GET /api/v1/leads/contactos y /api/v1/leads/citas (auth x-gulliver-api-key,
-- variable GULLIVER_API_KEY del hub; URL en GULLIVER_API_URL).
-- 1. clientes_gulliver: subcuenta GHL ↔ hotel de Gulliver.
-- 2. leads_ia_contacto: un contacto (teléfono E.164) con conversación con la IA.
--    Las cifras son de todo su historial en Gulliver.
-- 3. leads_citas: citas de Gulliver (source gulliver = reservada por la IA,
--    calendar = importada de Google Calendar).
-- El cruce con leads (teléfono E.164 o ghl_contact_id) se hace al consultar,
-- así un lead que llega después de su conversación también casa.
-- Los rellena backend/jobs/leads-gulliver.js (cron horario, minuto 40).
-- Solo backend (service role): RLS activado sin políticas.
-- Safe to re-run.

create table if not exists public.clientes_gulliver (
  location_id     text primary key references public.clientes_ghl(location_id) on delete cascade,
  hotel_id        uuid not null,               -- hotels.id en Gulliver
  activo          boolean not null default true,
  ultimo_sync_at  timestamptz,
  error           text,
  created_at      timestamptz not null default now()
);

create table if not exists public.leads_ia_contacto (
  location_id              text not null references public.clientes_ghl(location_id) on delete cascade,
  telefono                 text not null,      -- E.164
  ghl_contact_id           text,               -- el que guarda Gulliver (puede faltar)
  primera_at               timestamptz not null,
  ultima_at                timestamptz not null,
  mensajes                 int not null default 0,  -- WhatsApp, usuario + IA
  mensajes_usuario         int not null default 0,
  llamadas                 int not null default 0,  -- llamadas de voz atendidas por la IA
  primera_respuesta_ia_at  timestamptz,        -- primer mensaje de la IA o inicio de la primera llamada
  canales                  text[] not null default '{}',
  synced_at                timestamptz not null default now(),
  primary key (location_id, telefono)
);

create index if not exists idx_leads_ia_contacto_cid on public.leads_ia_contacto(location_id, ghl_contact_id);

create table if not exists public.leads_citas (
  id              uuid primary key,            -- appointments.id en Gulliver
  location_id     text not null references public.clientes_ghl(location_id) on delete cascade,
  telefono        text,                        -- E.164
  ghl_contact_id  text,
  creada_at       timestamptz,
  starts_at       timestamptz not null,
  estado          text not null,               -- scheduled | confirmed | cancelled | no_show
  origen          text,                        -- gulliver | calendar
  canal           text,                        -- whatsapp | voice | web | calendar
  tratamiento     text,
  cancelada_at    timestamptz,
  synced_at       timestamptz not null default now()
);

create index if not exists idx_leads_citas_location_tel on public.leads_citas(location_id, telefono);
create index if not exists idx_leads_citas_location_cid on public.leads_citas(location_id, ghl_contact_id);

alter table public.clientes_gulliver enable row level security;
alter table public.leads_ia_contacto enable row level security;
alter table public.leads_citas       enable row level security;

-- Clínica Nadal (GHL LE1vSghDFOWgcgD0avjT ↔ Gulliver "Clinica Nadal").
insert into public.clientes_gulliver (location_id, hotel_id)
values ('LE1vSghDFOWgcgD0avjT', 'b2bf785a-cb40-40e2-948a-0925721ec2b3')
on conflict (location_id) do nothing;
