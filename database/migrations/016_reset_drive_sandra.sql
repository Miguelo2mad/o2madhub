-- o2madhub — migration 016: reset Drive ingest before strict CIF-only re-scan.
-- Deletes all rows from the previous (folder-fallback) Drive scan; they will be
-- re-inserted by drive-scan-agent.js under strict CIF-only rules. Safe to re-run.

delete from public.facturas where source_account = 'drive-sandra';
