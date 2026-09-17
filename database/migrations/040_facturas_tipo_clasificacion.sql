-- Clasificación automática de documentos (factura / albarán / ticket) en el
-- pipeline de facturas de Timbol y Comarea. El default 'factura' preserva el
-- comportamiento actual hasta que corra el script de migración de datos
-- (clasificar_facturas_existentes.js), que aplica la regla determinista sobre
-- los importes ya guardados. Safe to re-run.

alter table public.timbol_facturas
  add column if not exists tipo              text  not null default 'factura',
  add column if not exists tipo_evidencia     text,
  add column if not exists tipo_confianza     text,
  add column if not exists numero_albaranes   jsonb not null default '[]';

alter table public.timbol_facturas
  drop constraint if exists timbol_facturas_tipo_check;
alter table public.timbol_facturas
  add constraint timbol_facturas_tipo_check
  check (tipo in ('factura', 'albaran', 'ticket', 'revisar'));

alter table public.comarea_facturas
  add column if not exists tipo              text  not null default 'factura',
  add column if not exists tipo_evidencia     text,
  add column if not exists tipo_confianza     text,
  add column if not exists numero_albaranes   jsonb not null default '[]';

alter table public.comarea_facturas
  drop constraint if exists comarea_facturas_tipo_check;
alter table public.comarea_facturas
  add constraint comarea_facturas_tipo_check
  check (tipo in ('factura', 'albaran', 'ticket', 'revisar'));

create index if not exists idx_timbol_facturas_tipo   on public.timbol_facturas(tipo);
create index if not exists idx_comarea_facturas_tipo  on public.comarea_facturas(tipo);
