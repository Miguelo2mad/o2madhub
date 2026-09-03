create table if not exists fd_contacts (
  id              uuid          primary key default gen_random_uuid(),
  fd_contact_id   text          not null unique,
  name            text          not null,
  fiscal_id       text,
  email           text,
  phone           text,
  is_client       boolean       not null default true,
  raw             jsonb,
  last_synced_at  timestamptz,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);
create index if not exists idx_fd_contacts_fd_id on fd_contacts(fd_contact_id);
