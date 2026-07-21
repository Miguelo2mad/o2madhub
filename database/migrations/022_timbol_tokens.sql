-- timbol_token_usage: tracking de consumo de Claude API por operación.
-- Safe to re-run.

create table if not exists public.timbol_token_usage (
  id            bigserial    primary key,
  created_at    timestamptz  not null default now(),
  operacion     text         not null,
  input_tokens  int          not null default 0,
  output_tokens int          not null default 0,
  coste_euros   numeric(8,6) not null default 0,
  usuario       text
);

alter table public.timbol_token_usage enable row level security;

-- Solo admins pueden leer. El backend usa service role y no necesita política.
drop policy if exists "timbol_token_usage: admin read" on public.timbol_token_usage;
create policy "timbol_token_usage: admin read" on public.timbol_token_usage
  for select to authenticated
  using (public.auth_role() = 'admin');
