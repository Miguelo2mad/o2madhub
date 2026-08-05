-- facturas: guarda el id de Drive (no solo la URL) para poder borrar el archivo
-- de forma limpia desde el módulo de subida manual (backend/api/grupo.js), igual
-- que ya hacen comarea_facturas/timbol_facturas con su propio drive_file_id.
alter table public.facturas
  add column if not exists drive_file_id text;
