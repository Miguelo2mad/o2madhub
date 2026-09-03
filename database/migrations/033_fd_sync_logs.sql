create table if not exists fd_sync_logs (
  id              uuid          primary key default gen_random_uuid(),
  entity          text          not null,
  status          text          not null,
  records_synced  int           not null default 0,
  error_message   text,
  started_at      timestamptz   not null default now(),
  finished_at     timestamptz
);
