-- o2madhub — remove Group A: SALES invoices issued BY an O2MAD group company to an
-- EXTERNAL client (hotels/restaurants/etc.). These are revenue, not expenses, and should
-- never have been ingested as supplier invoices. The extraction prompt now excludes them
-- (see backend/lib/claude.js), this migration cleans up the 30 historical rows.
--
-- Group B (intra-group charges where Apper Street is the payer) is intentionally KEPT —
-- those are real expenses for Apper.
--
-- Deletes exactly 30 rows by their unique referencia. Safe to re-run (no-op if already gone).

delete from public.facturas
where referencia in (
  'R00000029',
  '0000 00000394',
  '0000 00000402',
  '00000248',
  '00000745',
  '00000593',
  '00000525',
  '00000541',
  '00000233',
  '00000229',
  '00000230',
  '00000482',
  '00000197',
  '0000 00000391',
  '00000181',
  '0000 00000393',
  'F260053',
  '00000555',
  '00000063',
  '00000761',
  '00000750',
  '00000310',
  '00000220',
  '0000 00000404',
  '0000 00000400',
  '0000 00000399',
  '0038',
  '0013',
  '00000632',
  '00000180'
);
