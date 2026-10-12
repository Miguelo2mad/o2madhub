-- Leads: atribución más fina y gasto publicitario por subcuenta.
-- 1. Canal 'directo': "Direct traffic" de GHL ya no se cuenta como orgánico
--    (en Capilar Mora eran ~250 leads web sin origen conocido).
-- 2. campaign_id / ad_id del lead (Meta: campaignId/adId; Google: gad_campaignid
--    de la url) para cruzar con las plataformas de anuncios.
-- 3. cuentas_publicidad: qué cuenta de anuncios (y, opcionalmente, qué
--    campañas por nombre, ILIKE) pertenece a cada subcuenta GHL. Una cuenta de
--    Google Ads puede repartirse entre varias subcuentas (p. ej. Inner Hotels).
-- 4. Vista gasto_diario (fuente, location_id, fecha, gasto, impresiones, clics):
--    hoy solo Google Ads (google_ads_stats_diarias). Meta Ads entrará con un
--    UNION ALL más en la vista, sin tocar la API ni el panel.
-- Safe to re-run.

alter table public.leads
  add column if not exists campaign_id text,
  add column if not exists ad_id text;

alter table public.leads drop constraint if exists leads_canal_check;
alter table public.leads
  add constraint leads_canal_check
  check (canal in ('meta', 'google', 'organico', 'directo', 'manual', 'otro'));

create index if not exists idx_leads_campaign_id on public.leads(campaign_id);

create table if not exists public.cuentas_publicidad (
  id             uuid primary key default gen_random_uuid(),
  fuente         text not null check (fuente in ('google', 'meta')),
  cuenta_id      text not null,
  location_id    text not null references public.clientes_ghl(location_id) on delete cascade,
  campana_filtro text,
  created_at     timestamptz not null default now(),
  unique (fuente, cuenta_id, location_id)
);

alter table public.cuentas_publicidad enable row level security;

create or replace view public.gasto_diario
with (security_invoker = true) as
select
  'google'::text          as fuente,
  m.location_id,
  s.fecha,
  sum(s.coste)::numeric   as gasto,
  sum(s.impresiones)::int as impresiones,
  sum(s.clics)::int       as clics
from public.google_ads_stats_diarias s
join public.cuentas_publicidad m
  on m.fuente = 'google'
 and m.cuenta_id = s.customer_id
 and (m.campana_filtro is null or s.campana_nombre ilike m.campana_filtro)
group by m.location_id, s.fecha;
