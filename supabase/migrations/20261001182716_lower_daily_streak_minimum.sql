alter table public.workout_daily_scores
	drop column qualifies_for_streak;

alter table public.workout_daily_scores
	add column qualifies_for_streak boolean generated always as (
		pushups_reps >= 1 and
		pullups_reps >= 1 and
		crunches_reps >= 1 and
		squats_reps >= 1
	) stored;
