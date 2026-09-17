-- Facturas de varias páginas: si el modelo detecta una indicación de
-- paginación (Página X/Y, X de Y...) que no cuadra con las páginas
-- recibidas, la factura se guarda igual pero marcada como incompleta.
-- Safe to re-run.

alter table public.timbol_facturas
  add column if not exists pagina_parcial boolean not null default false,
  add column if not exists pagina_actual  integer,
  add column if not exists pagina_total   integer;

alter table public.comarea_facturas
  add column if not exists pagina_parcial boolean not null default false,
  add column if not exists pagina_actual  integer,
  add column if not exists pagina_total   integer;
