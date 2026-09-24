-- PushApp's initial Supabase schema.
-- The browser will use Supabase anonymous sign-in behind the existing
-- display-name + group-code screen. A group code is an identifier in the
-- current app, not a private credential; access is scoped to joined groups.

create table public.groups (
  id text primary key,
  group_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint groups_id_normalized check (id = lower(btrim(id)) and id <> '')
);

-- Links an anonymous Supabase identity to the groups it has joined.
create table public.group_memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id text not null references public.groups(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, group_id),
  constraint group_memberships_display_name_not_empty check (btrim(display_name) <> '')
);

create index group_memberships_group_id_idx
  on public.group_memberships (group_id);

-- The stable group/name key also keeps repeated joins on another device tied
-- to the same crew profile.
create table public.users (
  id text primary key,
  group_id text not null references public.groups(id) on delete cascade,
  name text not null,
  daily_count integer not null default 0 check (daily_count >= 0),
  daily_goal integer not null default 50 check (daily_goal > 0),
  total_count bigint not null default 0 check (total_count >= 0),
  history jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  podiums jsonb not null default '{"first":0,"second":0,"third":0}'::jsonb
    check (jsonb_typeof(podiums) = 'object'),
  last_updated timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_name_not_empty check (btrim(name) <> '')
);

create index users_group_id_idx on public.users (group_id);
create unique index users_group_name_ci_idx
  on public.users (group_id, lower(name));

-- Rankings stay JSONB to preserve the snapshot format used by the app.
create table public.daily_leaderboards (
  group_id text not null references public.groups(id) on delete cascade,
  date date not null,
  rankings jsonb not null default '[]'::jsonb check (jsonb_typeof(rankings) = 'array'),
  podiums_awarded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_id, date)
);

-- RLS helper. SECURITY DEFINER avoids recursive membership-table policies.
create or replace function public.is_group_member(target_group_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_memberships membership
    where membership.user_id = (select auth.uid())
      and membership.group_id = target_group_id
  );
$$;

revoke all on function public.is_group_member(text) from public, anon;
grant execute on function public.is_group_member(text) to authenticated;

-- The current app treats the entered group code as the group identifier and
-- allows a new group to be created on first join. Preserve that behavior while
-- binding each browser session to its joined groups through Supabase Auth.
create or replace function public.join_group(
  requested_group_id text,
  requested_display_name text
)
returns table (group_id text, display_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_group_id text := lower(btrim(requested_group_id));
  clean_display_name text := btrim(requested_display_name);
begin
  if auth.uid() is null then
    raise exception 'Sign in is required to join a group';
  end if;
  if normalized_group_id = '' or clean_display_name = '' then
    raise exception 'Group code and display name are required';
  end if;

  insert into public.groups (id)
  values (normalized_group_id)
  on conflict (id) do nothing;

  insert into public.group_memberships (user_id, group_id, display_name)
  values (auth.uid(), normalized_group_id, clean_display_name)
  on conflict on constraint group_memberships_pkey
  do update set display_name = excluded.display_name;

  return query select normalized_group_id, clean_display_name;
end;
$$;

revoke all on function public.join_group(text, text) from public, anon;
grant execute on function public.join_group(text, text) to authenticated;

alter table public.groups enable row level security;
alter table public.group_memberships enable row level security;
alter table public.users enable row level security;
alter table public.daily_leaderboards enable row level security;

create policy "Members can read their groups"
  on public.groups for select to authenticated
  using (public.is_group_member(id));

create policy "Members can read memberships in their groups"
  on public.group_memberships for select to authenticated
  using (public.is_group_member(group_id));

create policy "Members can read users in their groups"
  on public.users for select to authenticated
  using (public.is_group_member(group_id));

create policy "Members can add users to their groups"
  on public.users for insert to authenticated
  with check (public.is_group_member(group_id));

create policy "Members can update users in their groups"
  on public.users for update to authenticated
  using (public.is_group_member(group_id))
  with check (public.is_group_member(group_id));

create policy "Members can read leaderboards in their groups"
  on public.daily_leaderboards for select to authenticated
  using (public.is_group_member(group_id));

create policy "Members can add leaderboards to their groups"
  on public.daily_leaderboards for insert to authenticated
  with check (public.is_group_member(group_id));

create policy "Members can update leaderboards in their groups"
  on public.daily_leaderboards for update to authenticated
  using (public.is_group_member(group_id))
  with check (public.is_group_member(group_id));

grant usage on schema public to authenticated;
grant select on public.groups, public.group_memberships to authenticated;
grant select, insert, update on public.users, public.daily_leaderboards to authenticated;

-- Enable the two tables used by the live app in Supabase Realtime. Guard each
-- addition so the migration can be applied when a table is already published.
do $$
declare
  table_name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach table_name in array array['users', 'daily_leaderboards'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = table_name
      ) then
        execute format('alter publication supabase_realtime add table public.%I', table_name);
      end if;
    end loop;
  end if;
end;
$$;
