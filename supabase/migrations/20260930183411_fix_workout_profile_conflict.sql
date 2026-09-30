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
	if auth.uid() is null or (select auth.jwt() ->> 'is_anonymous') = 'true' then
		raise exception 'A registered account is required to join a group';
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

	insert into public.workout_profiles (user_id, group_id, display_name)
	values (auth.uid(), normalized_group_id, clean_display_name)
	on conflict on constraint workout_profiles_pkey
	do update set display_name = excluded.display_name, updated_at = now();

	return query select normalized_group_id, clean_display_name;
end;
$$;
