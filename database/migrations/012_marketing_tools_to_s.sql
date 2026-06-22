-- o2madhub — migration 012: move no-PDF marketing/advertising tools to s (O2 Marketing
-- and Design). Only rows WITHOUT a PDF (no CIF to trust); PDF-backed HighLevel/Meta in a
-- are kept (their CIF = B57856825 Apper). Safe to re-run.

update public.facturas set sociedad_codigo = 's' where referencia in (
  '5565012680',
  '5589682669',
  '1416-7856',
  'MEE-2604-7658',
  '5565796799'
);
