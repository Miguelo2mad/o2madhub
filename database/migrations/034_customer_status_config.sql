create table if not exists customer_status_config (
  id smallint primary key default 1,
  new_max_days int not null default 90,
  active_max_days int not null default 90,
  at_risk_max_days int not null default 180,
  inactive_max_days int not null default 365,
  dormant_max_days int not null default 730,
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);
insert into customer_status_config (id) values (1) on conflict (id) do nothing;
