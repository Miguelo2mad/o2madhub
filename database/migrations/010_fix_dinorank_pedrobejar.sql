-- o2madhub — migration 010: manual sociedad fixes. Safe to re-run.

-- DinoRANK FA-27127 (PDF ilegible) — same subscription as the other DinoRANK in s.
update public.facturas set sociedad_codigo = 's' where referencia = 'FA-27127';

-- Pedro Béjar — Agesbal (asesoría fiscal) belongs to O2DOSMAD (main operating entity).
update public.facturas set sociedad_codigo = 'd' where referencia in (
  'PED-MAY26',
  'PED-JUN26',
  'PED-ABR26',
  'PED-DIC25'
);
