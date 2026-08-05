-- facturas: comentario opcional que el usuario puede añadir al subir una
-- factura/ticket manualmente desde el módulo Grupo O2MAD (backend/api/grupo.js).
-- Null en las filas que vienen del pipeline automático (Gmail/Drive scan).
alter table public.facturas
  add column if not exists comentario text;
