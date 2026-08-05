-- comarea_facturas: evita duplicados por reintentos de subida (mismo
-- proveedor+número+importe+fecha). Ejecutar SOLO después de limpiar las
-- duplicadas ya existentes — si quedan filas repetidas, este ALTER falla.

alter table public.comarea_facturas
  drop constraint if exists comarea_facturas_dedupe_unique;
alter table public.comarea_facturas
  add constraint comarea_facturas_dedupe_unique
  unique (proveedor, numero_factura, importe_total, fecha_factura);
