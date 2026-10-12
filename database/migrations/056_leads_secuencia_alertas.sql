-- Leads: secuencia de seguimiento (pasos del workflow de GHL) y alertas.
-- 1. leads_secuencia: un paso del workflow de seguimiento enviado a un lead.
--    Lo alimenta el webhook POST /api/leads/secuencia/webhook?secret=…
--    (LEADS_WEBHOOK_SECRET), que el workflow de GHL llama en cada paso. Un
--    mismo paso se registra una vez por lead; si llega de nuevo solo se
--    actualiza el resultado.
-- 2. leads_alertas: alertas ya enviadas (no repetir el email por el mismo
--    lead). Tipo 'sin_saliente_30min': lead de Meta con 30 min sin ningún
--    mensaje saliente (backend/jobs/leads-alertas.js, cada 5 min).
-- Solo backend (service role): RLS activado sin políticas.
-- Safe to re-run.

create table if not exists public.leads_secuencia (
  id              bigserial primary key,
  location_id     text not null references public.clientes_ghl(location_id) on delete cascade,
  ghl_contact_id  text not null,
  paso            text not null,              -- nombre del paso tal cual lo manda GHL (p. ej. "whatsapp_2h", "llamada_ia")
  enviado_at      timestamptz not null default now(),
  resultado       text,                       -- opcional: lo que GHL sepa del paso (p. ej. "contesto", "buzon", "reservo")
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (location_id, ghl_contact_id, paso)
);

create index if not exists idx_leads_secuencia_location on public.leads_secuencia(location_id, enviado_at);

create table if not exists public.leads_alertas (
  location_id     text not null references public.clientes_ghl(location_id) on delete cascade,
  ghl_contact_id  text not null,
  tipo            text not null,
  enviada_at      timestamptz not null default now(),
  primary key (ghl_contact_id, tipo)
);

alter table public.leads_secuencia enable row level security;
alter table public.leads_alertas   enable row level security;
