-- o2madhub — migration 011: BSB a->s reverification + normalize newly-ingested proveedores. Safe to re-run.

-- (ninguna BSB de a resultó ser B57944829; todas se mantienen en a)

update public.facturas set proveedor = 'BSB La Teva Assessoria' where proveedor in ('BSB LA TEVA ASSESSORIA, S.L.');

update public.facturas set proveedor = 'B2B Hosting' where proveedor in ('B2B Hosting, S.L.');

update public.facturas set proveedor = 'Refineria Web, SL' where proveedor in ('Refineria Web, S.L.');
