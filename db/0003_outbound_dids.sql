-- Outbound DIDs (Caller IDs) selectable by agents when placing calls.
-- Apply on self-hosted Supabase:
--   psql "postgres://postgres:<pw>@<host>:5432/postgres" -f db/0003_outbound_dids.sql

create table if not exists public.outbound_dids (
  id uuid primary key default gen_random_uuid(),
  phone_number text unique not null,          -- E.164, e.g. +14155551234
  label text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
grant select on public.outbound_dids to authenticated;
grant all on public.outbound_dids to service_role;
alter table public.outbound_dids enable row level security;

create policy "auth reads dids" on public.outbound_dids for select to authenticated using (true);
create policy "admin writes dids" on public.outbound_dids for all to authenticated
  using (public.has_role(auth.uid(),'admin'))
  with check (public.has_role(auth.uid(),'admin'));

-- Only one default at a time
create unique index if not exists outbound_dids_one_default
  on public.outbound_dids ((true)) where is_default;
