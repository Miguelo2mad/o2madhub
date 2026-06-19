-- o2madhub — multi-account support
-- Tags each invoice with the mailbox/account it was ingested from.
-- Run in the Supabase SQL editor. Safe to re-run.

alter table public.facturas
  add column if not exists source_account text;

comment on column public.facturas.source_account is
  'Origin mailbox/account the invoice was ingested from (e.g. o2mad, apper, gulliver).';

-- Existing rows predate multi-account support → they came from the primary o2mad mailbox.
update public.facturas
  set source_account = 'o2mad'
  where source_account is null;

create index if not exists idx_facturas_source_account
  on public.facturas (source_account);
