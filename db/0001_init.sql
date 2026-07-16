-- Manual dialer platform: full schema, RLS, grants
-- Apply on self-hosted Supabase:
--   psql "postgres://postgres:<pw>@<host>:5432/postgres" -f db/0001_init.sql

create type public.app_role as enum ('admin', 'agent');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role public.app_role not null,
  unique (user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create policy "read own roles" on public.user_roles for select to authenticated using (user_id = auth.uid());
create policy "admin reads all roles" on public.user_roles for select to authenticated using (public.has_role(auth.uid(),'admin'));
create policy "admin writes roles" on public.user_roles for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;
create policy "read own profile" on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "update own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy "admin manages profiles" on public.profiles for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name) values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.sip_endpoints (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sip_username text unique not null,
  sip_password_encrypted text not null,
  extension text unique not null,
  created_at timestamptz not null default now()
);
grant select on public.sip_endpoints to authenticated;
grant all on public.sip_endpoints to service_role;
alter table public.sip_endpoints enable row level security;
create policy "agent reads own sip" on public.sip_endpoints for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.customers (phone);
grant select, insert, update on public.customers to authenticated;
grant all on public.customers to service_role;
alter table public.customers enable row level security;
create policy "auth reads customers" on public.customers for select to authenticated using (true);
create policy "auth inserts customers" on public.customers for insert to authenticated with check (created_by = auth.uid());
create policy "creator or admin updates" on public.customers for update to authenticated
  using (created_by = auth.uid() or public.has_role(auth.uid(),'admin'))
  with check (created_by = auth.uid() or public.has_role(auth.uid(),'admin'));

create type public.crm_field_type as enum ('text','textarea','number','select','date','checkbox');
create table public.crm_field_defs (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  label text not null,
  type public.crm_field_type not null default 'text',
  options jsonb,
  sort_order int not null default 0,
  required boolean not null default false,
  created_at timestamptz not null default now()
);
grant select on public.crm_field_defs to authenticated;
grant all on public.crm_field_defs to service_role;
alter table public.crm_field_defs enable row level security;
create policy "auth reads field defs" on public.crm_field_defs for select to authenticated using (true);
create policy "admin manages field defs" on public.crm_field_defs for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

create type public.call_status as enum ('ringing','answered','ended','failed');
create table public.calls (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references auth.users(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  customer_phone text not null,
  direction text not null default 'outbound',
  status public.call_status not null default 'ringing',
  disposition text,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration int,
  recording_url text,
  asterisk_channel_id text,
  asterisk_linkedid text unique,
  created_at timestamptz not null default now()
);
create index on public.calls (agent_id, started_at desc);
create index on public.calls (asterisk_channel_id);
grant select, insert, update on public.calls to authenticated;
grant all on public.calls to service_role;
alter table public.calls enable row level security;
alter table public.calls replica identity full;
create policy "agent reads own calls" on public.calls for select to authenticated
  using (agent_id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "agent inserts own call" on public.calls for insert to authenticated with check (agent_id = auth.uid());
create policy "agent updates own call" on public.calls for update to authenticated
  using (agent_id = auth.uid() or public.has_role(auth.uid(),'admin'))
  with check (agent_id = auth.uid() or public.has_role(auth.uid(),'admin'));

create table public.crm_entries (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references public.calls(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete cascade,
  agent_id uuid references auth.users(id) on delete set null,
  values jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.crm_entries (call_id);
create index on public.crm_entries (customer_id);
grant select, insert, update, delete on public.crm_entries to authenticated;
grant all on public.crm_entries to service_role;
alter table public.crm_entries enable row level security;
create policy "agent reads own entries" on public.crm_entries for select to authenticated
  using (agent_id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "agent writes own entries" on public.crm_entries for all to authenticated
  using (agent_id = auth.uid() or public.has_role(auth.uid(),'admin'))
  with check (agent_id = auth.uid() or public.has_role(auth.uid(),'admin'));

create type public.agent_state as enum ('offline','available','on_call');
create table public.agent_status (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state public.agent_state not null default 'offline',
  current_call_id uuid references public.calls(id) on delete set null,
  updated_at timestamptz not null default now()
);
grant select, insert, update on public.agent_status to authenticated;
grant all on public.agent_status to service_role;
alter table public.agent_status enable row level security;
alter table public.agent_status replica identity full;
create policy "read status (own or admin)" on public.agent_status for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "agent upserts own status" on public.agent_status for insert to authenticated with check (user_id = auth.uid());
create policy "agent updates own status" on public.agent_status for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Enable realtime for live admin view
alter publication supabase_realtime add table public.calls;
alter publication supabase_realtime add table public.agent_status;
