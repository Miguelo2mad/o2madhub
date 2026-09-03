create table if not exists google_ads_acciones_log (
  id uuid primary key default gen_random_uuid(),
  customer_id text not null references google_ads_clientes(customer_id),
  campana_id text,
  tipo_accion text not null,
  valor_anterior jsonb,
  valor_nuevo jsonb,
  origen text not null default 'manual',
  ejecutado_en timestamptz not null default now()
);

create index if not exists idx_acciones_customer on google_ads_acciones_log(customer_id, ejecutado_en desc);
