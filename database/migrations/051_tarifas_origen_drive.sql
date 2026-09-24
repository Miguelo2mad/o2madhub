-- Trazabilidad del archivo de origen de una tarifa importada.
-- origen_archivo (el nombre) ya existía desde 041 pero nunca se subía el
-- archivo en sí a Drive; aquí se añade el id de Drive (para enlazar al
-- documento real) y el tipo de archivo. Nullable a propósito: las tarifas
-- importadas antes de este cambio no tienen ni id ni tipo — el frontend
-- las muestra como "Origen no registrado", no se rellenan a mano.
-- Safe to re-run.
alter table public.tarifas
  add column if not exists origen_drive_id text,
  add column if not exists origen_tipo text;

alter table public.tarifas
  drop constraint if exists tarifas_origen_tipo_check;
alter table public.tarifas
  add constraint tarifas_origen_tipo_check
  check (origen_tipo is null or origen_tipo in ('xlsx', 'csv', 'pdf', 'imagen'));
