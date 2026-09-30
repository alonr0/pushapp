-- Active scoring starts fresh. Legacy user rows and leaderboard snapshots stay
-- intact for future Hall-of-Fame use and become read-only to browser clients.

create or replace function public.workout_base_points(
	pushups integer,
	pullups integer,
	crunches integer,
	squats integer
)
returns numeric
language sql
immutable
set search_path = ''
as $$
	select round(pushups * 0.25, 1) + round(pullups * 0.5, 1)
		+ round(crunches / 6.0, 1) + round(squats / 6.0, 1)
$$;

revoke all on function public.workout_base_points(integer, integer, integer, integer) from public, anon;
grant execute on function public.workout_base_points(integer, integer, integer, integer) to authenticated;

create table public.workout_profiles (
	user_id uuid not null references auth.users(id) on delete cascade,
	group_id text not null references public.groups(id) on delete cascade,
	display_name text not null check (btrim(display_name) <> ''),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	primary key (user_id, group_id)
);

create unique index workout_profiles_group_name_idx
	on public.workout_profiles (group_id, lower(display_name));

create table public.workout_daily_scores (
	user_id uuid not null references auth.users(id) on delete cascade,
	group_id text not null references public.groups(id) on delete cascade,
	activity_date date not null default (timezone('Asia/Jerusalem', now()))::date,
	pushups_reps integer not null default 0 check (pushups_reps between 0 and 100),
	pullups_reps integer not null default 0 check (pullups_reps between 0 and 50),
	crunches_reps integer not null default 0 check (crunches_reps between 0 and 150),
	squats_reps integer not null default 0 check (squats_reps between 0 and 150),
	base_points numeric(5, 1) generated always as (
		public.workout_base_points(pushups_reps, pullups_reps, crunches_reps, squats_reps)
	) stored,
	completed_categories smallint generated always as (
		(case when pushups_reps = 100 then 1 else 0 end) +
		(case when pullups_reps = 50 then 1 else 0 end) +
		(case when crunches_reps = 150 then 1 else 0 end) +
		(case when squats_reps = 150 then 1 else 0 end)
	) stored,
	daily_bonus_points smallint generated always as (
		2 * (
			(case when pushups_reps = 100 then 1 else 0 end) +
			(case when pullups_reps = 50 then 1 else 0 end) +
			(case when crunches_reps = 150 then 1 else 0 end) +
			(case when squats_reps = 150 then 1 else 0 end)
		) +
		(case when pushups_reps = 100 and pullups_reps = 50
			and crunches_reps = 150 and squats_reps = 150 then 10 else 0 end)
	) stored,
	daily_points numeric(5, 1) generated always as (
		public.workout_base_points(pushups_reps, pullups_reps, crunches_reps, squats_reps) +
		2 * (
			(case when pushups_reps = 100 then 1 else 0 end) +
			(case when pullups_reps = 50 then 1 else 0 end) +
			(case when crunches_reps = 150 then 1 else 0 end) +
			(case when squats_reps = 150 then 1 else 0 end)
		) +
		(case when pushups_reps = 100 and pullups_reps = 50
			and crunches_reps = 150 and squats_reps = 150 then 10 else 0 end)
	) stored,
	qualifies_for_streak boolean generated always as (
		public.workout_base_points(pushups_reps, pullups_reps, crunches_reps, squats_reps) >= 60
	) stored,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	primary key (user_id, group_id, activity_date),
	foreign key (user_id, group_id)
		references public.workout_profiles(user_id, group_id) on delete cascade
);

create index workout_daily_scores_group_date_idx
	on public.workout_daily_scores (group_id, activity_date desc);

create table public.workout_streak_rewards (
	user_id uuid not null references auth.users(id) on delete cascade,
	group_id text not null references public.groups(id) on delete cascade,
	milestone_date date not null,
	bonus_points smallint not null default 5 check (bonus_points = 5),
	created_at timestamptz not null default now(),
	primary key (user_id, group_id, milestone_date)
);

alter table public.workout_profiles enable row level security;
alter table public.workout_daily_scores enable row level security;
alter table public.workout_streak_rewards enable row level security;

create policy "Group members can read workout profiles"
	on public.workout_profiles for select to authenticated
	using (public.is_group_member(group_id));

create policy "Group members can read daily workout scores"
	on public.workout_daily_scores for select to authenticated
	using (public.is_group_member(group_id));

create policy "Group members can read workout streak rewards"
	on public.workout_streak_rewards for select to authenticated
	using (public.is_group_member(group_id));

revoke all on table public.workout_profiles,
	public.workout_daily_scores,
	public.workout_streak_rewards from anon, authenticated;
grant select on table public.workout_profiles,
	public.workout_daily_scores,
	public.workout_streak_rewards to authenticated;

-- Keep historic records available for Hall-of-Fame reads only.
revoke insert, update, delete on table public.users, public.daily_leaderboards
	from anon, authenticated;
grant select on table public.users, public.daily_leaderboards to authenticated;

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
	on conflict (user_id, group_id)
	do update set display_name = excluded.display_name, updated_at = now();

	return query select normalized_group_id, clean_display_name;
end;
$$;

revoke all on function public.join_group(text, text) from public, anon;
grant execute on function public.join_group(text, text) to authenticated;

create or replace function public.log_workout_reps(
	requested_group_id text,
	requested_exercise_id text,
	requested_reps integer
)
returns table (
	saved_reps integer,
	activity_date date,
	base_points numeric,
	daily_points numeric,
	current_streak integer,
	lifetime_streak_points integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
	current_user_id uuid := auth.uid();
	israel_today date := (now() at time zone 'Asia/Jerusalem')::date;
	exercise_cap integer;
	new_reps integer;
	saved_score public.workout_daily_scores%rowtype;
	streak_length integer := 0;
	lifetime_bonus integer := 0;
begin
	if current_user_id is null or (select auth.jwt() ->> 'is_anonymous') = 'true' then
		raise exception 'A registered account is required to log exercise';
	end if;
	if not exists (
		select 1 from public.group_memberships as membership
		where membership.user_id = current_user_id and membership.group_id = requested_group_id
	) then
		raise exception 'You are not a member of this group';
	end if;
	if requested_reps is null or requested_reps < 1 then
		raise exception 'Repetitions must be a positive integer';
	end if;

	exercise_cap := case requested_exercise_id
		when 'pushups' then 100
		when 'pullups' then 50
		when 'crunches' then 150
		when 'squats' then 150
		else null
	end;
	if exercise_cap is null then raise exception 'Unknown exercise'; end if;

	insert into public.workout_daily_scores as existing (
		user_id, group_id, activity_date, pushups_reps, pullups_reps, crunches_reps, squats_reps
	) values (
		current_user_id, requested_group_id, israel_today,
		case when requested_exercise_id = 'pushups' then requested_reps else 0 end,
		case when requested_exercise_id = 'pullups' then requested_reps else 0 end,
		case when requested_exercise_id = 'crunches' then requested_reps else 0 end,
		case when requested_exercise_id = 'squats' then requested_reps else 0 end
	)
	on conflict (user_id, group_id, activity_date)
	do update set
		pushups_reps = existing.pushups_reps + case when requested_exercise_id = 'pushups' then requested_reps else 0 end,
		pullups_reps = existing.pullups_reps + case when requested_exercise_id = 'pullups' then requested_reps else 0 end,
		crunches_reps = existing.crunches_reps + case when requested_exercise_id = 'crunches' then requested_reps else 0 end,
		squats_reps = existing.squats_reps + case when requested_exercise_id = 'squats' then requested_reps else 0 end,
		updated_at = now()
	where
		(requested_exercise_id <> 'pushups' or existing.pushups_reps + requested_reps <= 100) and
		(requested_exercise_id <> 'pullups' or existing.pullups_reps + requested_reps <= 50) and
		(requested_exercise_id <> 'crunches' or existing.crunches_reps + requested_reps <= 150) and
		(requested_exercise_id <> 'squats' or existing.squats_reps + requested_reps <= 150)
	returning * into saved_score;

	if not found then
		raise exception 'That would exceed today''s limit of %', exercise_cap;
	end if;
	new_reps := case requested_exercise_id
		when 'pushups' then saved_score.pushups_reps
		when 'pullups' then saved_score.pullups_reps
		when 'crunches' then saved_score.crunches_reps
		else saved_score.squats_reps
	end;

	if saved_score.qualifies_for_streak then
		with recursive streak_days(activity_date, run_length) as (
			select israel_today, 1
			union all
			select streak.activity_date - 1, streak.run_length + 1
			from streak_days as streak
			where exists (
				select 1 from public.workout_daily_scores as previous_day
				where previous_day.user_id = current_user_id
					and previous_day.group_id = requested_group_id
					and previous_day.activity_date = streak.activity_date - 1
					and previous_day.qualifies_for_streak
			)
		)
		select coalesce(max(run_length), 0) into streak_length from streak_days;

		if streak_length > 0 and mod(streak_length, 7) = 0 then
			insert into public.workout_streak_rewards (user_id, group_id, milestone_date)
			values (current_user_id, requested_group_id, israel_today)
			on conflict (user_id, group_id, milestone_date) do nothing;
		end if;
	end if;

	select coalesce(sum(reward.bonus_points), 0)::integer
	into lifetime_bonus
	from public.workout_streak_rewards as reward
	where reward.user_id = current_user_id and reward.group_id = requested_group_id;

	return query select
		new_reps, israel_today, saved_score.base_points, saved_score.daily_points,
		streak_length, lifetime_bonus;
end;
$$;

revoke all on function public.log_workout_reps(text, text, integer) from public, anon;
grant execute on function public.log_workout_reps(text, text, integer) to authenticated;

do $$
declare
	table_name text;
begin
	if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
		foreach table_name in array array['workout_profiles', 'workout_daily_scores'] loop
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
