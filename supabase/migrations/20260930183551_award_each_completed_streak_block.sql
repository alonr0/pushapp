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
	on conflict on constraint workout_daily_scores_pkey
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

		if streak_length > 0 then
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
			insert into public.workout_streak_rewards (user_id, group_id, milestone_date)
			select current_user_id, requested_group_id, streak.activity_date
			from streak_days as streak
			where mod(streak.run_length, 7) = 0
			on conflict on constraint workout_streak_rewards_pkey do nothing;
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
