-- o2madhub — migration 013: fixed proveedor rules for facturas without confirmed CIF,
-- plus removal of sales invoices we issued. Mirrors the permanent rules added to
-- backend/lib/claude.js. Safe to re-run.

-- 1. Macaque Consulting → d (O2DOSMAD B55405195), wherever it currently is.
update public.facturas set sociedad_codigo = 'd' where proveedor ilike '%macaque%';

-- 2. Pedro Béjar / Agesbal (asesoría fiscal) → d.
update public.facturas set sociedad_codigo = 'd'
  where proveedor ilike '%béjar%' or proveedor ilike '%bejar%' or proveedor ilike '%agesbal%';

-- 3. Google One → s (O2 Marketing and Design B57944829).
update public.facturas set sociedad_codigo = 's' where concepto ilike '%google one%';

-- 4. Delete invoices WE issued to clients (revenue, not expenses).
delete from public.facturas where referencia in ('00000598', '00000198', '00000159');
