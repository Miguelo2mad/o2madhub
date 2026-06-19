-- o2madhub — backfill legacy invoices missing a source_account.
-- These rows predate (or were written by) code that didn't set source_account; they all
-- originated from the primary o2mad mailbox. Safe to re-run.

update public.facturas
  set source_account = 'o2mad'
  where source_account is null;
