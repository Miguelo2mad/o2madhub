-- o2madhub — RLS, realtime, and role enforcement
-- Run in the Supabase SQL editor (top to bottom). Safe to re-run.
--
-- Model:
--   * profiles.role ∈ ('admin','gestor'); defaults to 'gestor' for every new user.
--   * facturas: any authenticated user can READ; only admins can WRITE.
--   * The backend agent uses the SERVICE ROLE key, which BYPASSES RLS — so these
--     policies do NOT affect the agent; they only constrain the frontend (anon key + user JWT).

-- ============================================================
-- 1. PROFILES TABLE (server-side role source of truth)
-- ============================================================
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null default 'gestor' check (role in ('admin', 'gestor')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Helper: current user's role. SECURITY DEFINER so it bypasses RLS when read from
-- inside a policy (prevents infinite recursion on the profiles policies).
create or replace function public.auth_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

grant execute on function public.auth_role() to authenticated, anon;

-- Auto-create a profile (role 'gestor') whenever a new auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'gestor')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for any users that already exist.
insert into public.profiles (id, email, role)
select id, email, 'gestor' from auth.users
on conflict (id) do nothing;

-- Profiles policies
drop policy if exists "profiles: read own or admin" on public.profiles;
create policy "profiles: read own or admin" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.auth_role() = 'admin');

-- Only admins may change roles / profiles (users cannot escalate their own role).
drop policy if exists "profiles: admin write" on public.profiles;
create policy "profiles: admin write" on public.profiles
  for all to authenticated
  using (public.auth_role() = 'admin')
  with check (public.auth_role() = 'admin');

-- ============================================================
-- 2. RLS ON FACTURAS
-- ============================================================
alter table public.facturas enable row level security;

-- READ: any authenticated user (admin or gestor). Anon (logged-out) gets nothing.
drop policy if exists "facturas: read (authenticated)" on public.facturas;
create policy "facturas: read (authenticated)" on public.facturas
  for select to authenticated
  using (true);

-- WRITE: admins only (the agent uses the service role and bypasses this anyway).
drop policy if exists "facturas: admin insert" on public.facturas;
create policy "facturas: admin insert" on public.facturas
  for insert to authenticated
  with check (public.auth_role() = 'admin');

drop policy if exists "facturas: admin update" on public.facturas;
create policy "facturas: admin update" on public.facturas
  for update to authenticated
  using (public.auth_role() = 'admin')
  with check (public.auth_role() = 'admin');

drop policy if exists "facturas: admin delete" on public.facturas;
create policy "facturas: admin delete" on public.facturas
  for delete to authenticated
  using (public.auth_role() = 'admin');

-- ============================================================
-- 3. REALTIME ON FACTURAS
-- ============================================================
-- Full row data on UPDATE/DELETE events (frontend re-fetches, but this is safer).
alter table public.facturas replica identity full;

-- Add facturas to the realtime publication (guarded so re-runs don't error).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'facturas'
  ) then
    alter publication supabase_realtime add table public.facturas;
  end if;
end
$$;

-- ============================================================
-- 4. PROMOTE ADMINS  (edit emails, then this is the only manual step)
-- ============================================================
-- update public.profiles set role = 'admin'
-- where email in ('o2mktmiguel@gmail.com');   -- <-- your admin emails here
