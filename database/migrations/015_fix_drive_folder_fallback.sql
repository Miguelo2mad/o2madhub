-- o2madhub — migration 015: fix drive-sandra rows misassigned by the (swapped) folder fallback.
-- Re-read CIF; folders map O2 Strategy->d, O2 Design->s. Safe to re-run.

update public.facturas set sociedad_codigo='d' where referencia in ('G157299298', 'G151385912', 'ES-TI2500887224', 'ES-TI2600201320', 'ES-TI2600112116', 'ES-TI2500806447', 'ES-TI2600030063', 'INV2602040590', 'AC12F632-0023', 'C6399396-0002');

update public.facturas set sociedad_codigo='s' where referencia in ('457-170062', '04801-67056868', 'INV-7771535', 'INV-4994193', 'INV-4150233', '457-128761', '457-86509', '04829-62062753', '04770-62572755', '04890-39129889');
