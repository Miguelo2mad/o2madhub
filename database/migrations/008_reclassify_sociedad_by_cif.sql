-- o2madhub — migration 008: reclassify sociedad_codigo by DESTINATARIO CIF.
-- Generated from reclassify-sociedad.js (reads each Drive PDF, extracts the recipient CIF,
-- maps CIF -> sociedad; context only used to improve an unclassified row). 37 rows.
-- Already applied via: node reclassify-sociedad.js --apply. Safe to re-run.

-- → d = O2DOSMAD Design & Strategy SL (B55405195)  (3)
update public.facturas set sociedad_codigo = 'd' where referencia in (
  'VBNOSV7E-0001',
  'VBNOSV7E-0003',
  'VBNOSV7E-0002'
);

-- → s = O2 Marketing and Design SL (B57944829)  (32)
update public.facturas set sociedad_codigo = 's' where referencia in (
  'F26-54756',
  'F26-53852',
  'F25-137411',
  '8934C5CD-0025',
  '1570636',
  '1561148',
  '1567259',
  '8934C5CD-0023',
  'DR2604-00780',
  '8934C5CD-0021',
  '8934C5CD-0020',
  'F26-73369',
  '2252-8804',
  '2630126',
  'F26-68556',
  'F25-134804',
  '8934C5CD-0024',
  '2223-3373',
  '2680-8720',
  '2122-2571',
  '2610-2052',
  'F26-66736',
  'F26-66735',
  'F26-66734',
  'F25-134810',
  'F26-69285',
  '26-00000100',
  'DR2605-00745',
  '1563393',
  '01-26-002941',
  '8934C5CD-0022',
  '1551530'
);

-- → g = Gulliver Ventures SL (B26829291)  (2)
update public.facturas set sociedad_codigo = 'g' where referencia in (
  '2026-WRF18917',
  '2026-WRF18915'
);
