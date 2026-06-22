-- o2madhub — migration 014: normalize proveedor names from drive-sandra ingests. Safe to re-run.

update public.facturas set proveedor = 'Webempresa Europa SL' where proveedor in ('Webempresa Europa S.L.U.');

update public.facturas set proveedor = 'Refineria Web, SL' where proveedor in ('Refineria Web, S.L.');

update public.facturas set proveedor = 'B2B Hosting' where proveedor in ('B2B Hosting, S.L.');

update public.facturas set proveedor = 'Canva Pty Ltd' where proveedor in ('Canva Pty. Ltd.');

update public.facturas set proveedor = 'Elfsight' where proveedor in ('Elfsight (Paddle.com Market Ltd)', 'Elfsight (via Paddle.com Market Ltd)');

update public.facturas set proveedor = 'D Esencia Lab' where proveedor in ('D ESENCIA LAB', 'D ESENCIA LAB - ANDREA RIUTORT REINA', 'D ESENCIA LAB (Andrea Riutort Reina)');

update public.facturas set proveedor = 'ADL Internet Group SLU (Pagetoday)' where proveedor in ('Pagetoday (ADL Internet Group SLU)');
