create table if not exists fd_invoices (
  id              uuid          primary key default gen_random_uuid(),
  fd_invoice_id   text          not null unique,
  fd_contact_id   text          references fd_contacts(fd_contact_id),
  document_number text,
  invoice_date    date,
  due_date        date,
  state           text,
  subtotal        numeric(12,2),
  tax             numeric(12,2),
  total           numeric(12,2),
  currency        text          not null default 'EUR',
  raw             jsonb,
  last_synced_at  timestamptz,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);
create index if not exists idx_fd_invoices_contact on fd_invoices(fd_contact_id);
create index if not exists idx_fd_invoices_date    on fd_invoices(invoice_date);
