-- comarea_facturas: comentario opcional que el usuario puede añadir al subir
-- la factura (p.ej. contexto de por qué se pagó, a qué evento corresponde...).
alter table public.comarea_facturas
  add column if not exists comentario text;
