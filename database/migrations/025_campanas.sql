create table if not exists google_ads_clientes (
  id uuid primary key default gen_random_uuid(),
  nombre_cliente text not null,
  customer_id text not null unique,
  objetivo_cpl numeric,
  objetivo_roas numeric,
  activo boolean not null default true,
  created_at timestamptz default now()
);

create table if not exists google_ads_stats_diarias (
  id uuid primary key default gen_random_uuid(),
  customer_id text not null references google_ads_clientes(customer_id),
  fecha date not null,
  campana_id text not null,
  campana_nombre text not null,
  impresiones int not null default 0,
  clics int not null default 0,
  coste numeric not null default 0,
  conversiones numeric not null default 0,
  valor_conversiones numeric not null default 0,
  created_at timestamptz default now(),
  unique(customer_id, fecha, campana_id)
);

create table if not exists google_ads_recomendaciones (
  id uuid primary key default gen_random_uuid(),
  customer_id text not null references google_ads_clientes(customer_id),
  fecha timestamptz not null default now(),
  texto text not null,
  metricas_snapshot jsonb not null
);

create index if not exists idx_stats_customer_fecha on google_ads_stats_diarias(customer_id, fecha);
