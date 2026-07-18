-- Contacts, inbound routing, presence polish.
-- Apply on self-hosted Supabase:
--   psql "postgres://postgres:<pw>@<host>:5432/postgres" -f db/0002_live_contacts_inbound.sql

-- ============ Contacts ============
create table if not exists public.contact_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
grant select on public.contact_lists to authenticated;
grant all on public.contact_lists to service_role;
alter table public.contact_lists enable row level security;
create policy "auth reads lists" on public.contact_lists for select to authenticated using (true);
create policy "admin writes lists" on public.contact_lists for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  list_id uuid references public.contact_lists(id) on delete cascade,
  phone text not null,
  first_name text,
  last_name text,
  email text,
  notes text,
  custom jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists contacts_list_idx on public.contacts (list_id, created_at desc);
create index if not exists contacts_phone_idx on public.contacts (phone);
grant select on public.contacts to authenticated;
grant all on public.contacts to service_role;
alter table public.contacts enable row level security;
create policy "auth reads contacts" on public.contacts for select to authenticated using (true);
create policy "admin writes contacts" on public.contacts for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

-- ============ Inbound routing ============
create type inbound_strategy as enum ('direct','roundrobin');

create table if not exists public.inbound_routes (
  id uuid primary key default gen_random_uuid(),
  did text unique not null,
  strategy inbound_strategy not null default 'direct',
  target_user_id uuid references auth.users(id) on delete set null,
  ring_group jsonb not null default '[]'::jsonb,   -- array of user_ids for roundrobin
  ring_seconds int not null default 20,
  fallback_extension text,                         -- e.g. voicemail extension
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select on public.inbound_routes to authenticated;
grant all on public.inbound_routes to service_role;
alter table public.inbound_routes enable row level security;
create policy "auth reads routes" on public.inbound_routes for select to authenticated using (true);
create policy "admin writes routes" on public.inbound_routes for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

create table if not exists public.inbound_state (
  did text primary key references public.inbound_routes(did) on delete cascade,
  last_agent_index int not null default -1,
  updated_at timestamptz not null default now()
);
grant select on public.inbound_state to authenticated;
grant all on public.inbound_state to service_role;
alter table public.inbound_state enable row level security;
create policy "admin reads state" on public.inbound_state for select to authenticated
  using (public.has_role(auth.uid(),'admin'));
