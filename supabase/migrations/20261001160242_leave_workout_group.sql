create or replace function public.leave_group(requested_group_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	normalized_group_id text := lower(btrim(requested_group_id));
begin
	if auth.uid() is null or (select auth.jwt() ->> 'is_anonymous') = 'true' then
		raise exception 'A registered account is required to leave a group';
	end if;
	if normalized_group_id = '' then
		raise exception 'Group code is required';
	end if;

	delete from public.group_memberships
	where user_id = auth.uid() and group_id = normalized_group_id;

	if not found then
		raise exception 'You are not a member of this group';
	end if;
end;
$$;

revoke all on function public.leave_group(text) from public, anon;
grant execute on function public.leave_group(text) to authenticated;
