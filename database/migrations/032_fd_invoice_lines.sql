create table if not exists fd_invoice_lines (
  id              uuid          primary key default gen_random_uuid(),
  fd_invoice_id   text          not null references fd_invoices(fd_invoice_id),
  description     text,
  quantity        numeric(10,3),
  unit_price      numeric(12,2),
  line_total      numeric(12,2),
  tax_rate        numeric(5,2),
  service_category text,
  raw             jsonb,
  created_at      timestamptz   not null default now()
);
create index if not exists idx_fd_lines_invoice on fd_invoice_lines(fd_invoice_id);
