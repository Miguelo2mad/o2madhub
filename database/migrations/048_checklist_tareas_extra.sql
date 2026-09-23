-- Tareas extraordinarias: una tarea de una sola vez, para un día concreto,
-- sin pasar por ningún checklist. Vive en las mismas tablas que las tareas
-- de rutina (checklist_ejecuciones/checklist_tareas), distinguida por
-- `origen`. Safe to re-run.
--
-- checklist_id pasa a nullable en ambas tablas: una ejecución/tarea
-- 'extra' no pertenece a ningún checklist. checklist_tareas gana
-- ejecucion_extra_id, que apunta a SU ejecución (a diferencia de una tarea
-- de rutina, que se comparte entre todas las ejecuciones diarias de su
-- checklist). El check de abajo obliga a que sea lo uno o lo otro, nunca
-- ambos ni ninguno.
--
-- El unique(checklist_id, fecha) de checklist_ejecuciones (047) sigue
-- funcionando sin tocarlo: Postgres no considera duplicados dos NULL, así
-- que puede haber varias ejecuciones 'extra' (checklist_id null) el mismo
-- día sin chocar con esa restricción — solo protege contra dos ejecuciones
-- 'rutina' del mismo checklist el mismo día, que es lo que siempre protegió.

alter table public.checklist_ejecuciones
  alter column checklist_id drop not null,
  add column if not exists origen text not null default 'rutina',
  add column if not exists turno  text;   -- solo para origen='extra'; una 'rutina' lo saca de su checklist

alter table public.checklist_ejecuciones
  drop constraint if exists checklist_ejecuciones_origen_check;
alter table public.checklist_ejecuciones
  add constraint checklist_ejecuciones_origen_check
  check (origen in ('rutina', 'extra'));

alter table public.checklist_tareas
  alter column checklist_id drop not null,
  add column if not exists ejecucion_extra_id bigint references public.checklist_ejecuciones(id) on delete cascade;

alter table public.checklist_tareas
  drop constraint if exists checklist_tareas_origen_check;
alter table public.checklist_tareas
  add constraint checklist_tareas_origen_check
  check (
    (checklist_id is not null and ejecucion_extra_id is null)
    or
    (checklist_id is null and ejecucion_extra_id is not null)
  );
