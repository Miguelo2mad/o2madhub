-- Precio de carta del plato, para el margen del escandallo asistido
-- (backend/lib/escandallo.js). platos existe desde 042; RLS y políticas
-- (authenticated read/insert, admin update/delete) ya se dieron de alta
-- ahí, no hace falta tocarlas. Safe to re-run.
alter table public.platos
  add column if not exists precio_carta numeric(10, 2);

-- Ya existe desde 042, pero el ON CONFLICT (cliente, nombre_norm) de
-- confirmar_escandallo() necesita esta unique constraint para funcionar —
-- se repite aquí (idempotente) para que esta migración sea autocontenida.
create unique index if not exists platos_cliente_nombre_norm_idx
  on public.platos (cliente, nombre_norm);

-- Upsert de un plato + reemplazo completo de sus líneas de escandallo en
-- UNA transacción real: el cliente Supabase-JS del backend no tiene
-- transacciones multi-tabla, así que esto vive en una función de Postgres
-- (todo el cuerpo corre en la transacción implícita de la llamada). Sin
-- lógica de negocio aquí a propósito — normalizarTextoProducto()/
-- normalizarUnidad() (backend/lib/tarifas.js) ya se aplican en JS antes de
-- llamar, esta función solo hace el guardado mecánico.
create or replace function public.confirmar_escandallo(
  p_cliente        text,
  p_nombre         text,
  p_nombre_norm    text,
  p_precio_carta   numeric,
  p_ingredientes   jsonb
) returns bigint
language plpgsql
as $$
declare
  v_plato_id bigint;
begin
  insert into public.platos (cliente, nombre, nombre_norm, precio_carta, activo)
  values (p_cliente, p_nombre, p_nombre_norm, p_precio_carta, true)
  on conflict (cliente, nombre_norm)
  do update set nombre = excluded.nombre, precio_carta = excluded.precio_carta, activo = true
  returning id into v_plato_id;

  delete from public.escandallo where plato_id = v_plato_id;

  insert into public.escandallo (plato_id, ingrediente, ingrediente_norm, cantidad, unidad)
  select
    v_plato_id,
    (ing->>'ingrediente')::text,
    (ing->>'ingrediente_norm')::text,
    (ing->>'cantidad')::numeric,
    (ing->>'unidad')::text
  from jsonb_array_elements(p_ingredientes) as ing;

  return v_plato_id;
end;
$$;
