-- timbol_facturas: evita duplicados por reintentos de subida (mismo
-- proveedor+número+importe+fecha). Ejecutar SOLO después de limpiar las
-- duplicadas ya existentes — si quedan filas repetidas, este ALTER falla.

alter table public.timbol_facturas
  drop constraint if exists timbol_facturas_dedupe_unique;
alter table public.timbol_facturas
  add constraint timbol_facturas_dedupe_unique
  unique (proveedor, numero_factura, importe_total, fecha_factura);
