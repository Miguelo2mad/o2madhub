-- o2madhub — migration 009: normalize inconsistent proveedor names. Safe to re-run.

update public.facturas set proveedor = 'Macaque Consulting, SL'
  where proveedor in (
    'Macaque Consulting',
    'Macaque Consulting, S.L.'
  );

update public.facturas set proveedor = 'Refineria Web, SL'
  where proveedor in (
    'Refineria Web, S.L.'
  );

update public.facturas set proveedor = 'B2B Hosting'
  where proveedor in (
    'B2B Hosting, S.L.'
  );

update public.facturas set proveedor = 'Webempresa Europa SL'
  where proveedor in (
    'Webempresa',
    'Webempresa Europa S.L.U.'
  );

update public.facturas set proveedor = 'Elfsight'
  where proveedor in (
    'Elfsight (Paddle.com Market Ltd)',
    'Elfsight (Paddle)',
    'Paddle.com Market Ltd (Elfsight)'
  );

update public.facturas set proveedor = 'BSB La Teva Assessoria'
  where proveedor in (
    'BSB LA TEVA ASSESSORIA, S.L.'
  );
