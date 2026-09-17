-- Detección de posibles duplicados en la subida manual de facturas
-- (Timbol y Comarea). El duplicado EXACTO (mismo cif_proveedor, importe,
-- fecha y número) se bloquea en el backend antes de llegar aquí — esta
-- columna es para el caso más laxo: mismo proveedor e importe pero
-- fecha o número distintos, que se guarda igual pero marcado para que
-- alguien lo revise. Safe to re-run.

alter table public.timbol_facturas
  add column if not exists posible_duplicado boolean not null default false;

alter table public.comarea_facturas
  add column if not exists posible_duplicado boolean not null default false;
