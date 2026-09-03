create table if not exists customer_metrics (
  id                            uuid primary key default gen_random_uuid(),
  fd_contact_id                 text not null unique references fd_contacts(fd_contact_id),

  first_invoice_date            date,
  last_invoice_date             date,
  days_since_last_invoice       int,

  invoice_count                 int not null default 0,
  invoice_count_12m             int not null default 0,

  revenue_total                 numeric(14,2) not null default 0,
  revenue_12m                   numeric(14,2) not null default 0,
  revenue_previous_12m          numeric(14,2) not null default 0,

  average_invoice               numeric(12,2),
  average_days_between_invoices numeric(8,1),
  frequency_deviation_ratio     numeric(8,2),

  services_count                int,
  services_used                 text[],

  activity_score                numeric(5,2),
  value_score                   numeric(5,2),
  reactivation_score            numeric(5,2),

  customer_status               text not null default 'NEW',
  calculated_at                 timestamptz not null default now()
);
create index if not exists idx_customer_metrics_status on customer_metrics(customer_status);
create index if not exists idx_customer_metrics_score  on customer_metrics(reactivation_score desc);
