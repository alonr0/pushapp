import { supabase } from './store'

export async function listWorkoutProfiles(userId) {
  const { data, error } = await supabase
    .from('workout_profiles')
    .select('user_id, group_id, display_name')
    .eq('user_id', userId)
    .order('display_name')
  if (error) throw error
  return data ?? []
}

export async function joinWorkoutGroup(groupId, displayName) {
  const { error } = await supabase.rpc('join_group', {
    requested_group_id: groupId.trim().toLowerCase(),
    requested_display_name: displayName.trim(),
  })
  if (error) throw error
}

export async function readWorkoutGroup(groupId) {
  const [profilesResult, scoresResult, rewardsResult] = await Promise.all([
    supabase
      .from('workout_profiles')
      .select('user_id, group_id, display_name')
      .eq('group_id', groupId)
      .order('display_name'),
    supabase
      .from('workout_daily_scores')
      .select('*')
      .eq('group_id', groupId)
      .order('activity_date', { ascending: false }),
    supabase
      .from('workout_streak_rewards')
      .select('user_id, group_id, milestone_date, bonus_points')
      .eq('group_id', groupId),
  ])

  for (const result of [profilesResult, scoresResult, rewardsResult]) {
    if (result.error) throw result.error
  }
  return {
    profiles: profilesResult.data ?? [],
    scores: scoresResult.data ?? [],
    rewards: rewardsResult.data ?? [],
  }
}

export async function logWorkoutReps(groupId, exerciseId, reps) {
  const { data, error } = await supabase.rpc('log_workout_reps', {
    requested_group_id: groupId,
    requested_exercise_id: exerciseId,
    requested_reps: reps,
  })
  if (error) throw error
  return Array.isArray(data) ? data[0] : data
}

export function subscribeToWorkoutGroup(groupId, onChange, onError = console.error) {
  const channel = supabase
    .channel(`workouts:${groupId}:${crypto.randomUUID()}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'workout_daily_scores',
        filter: `group_id=eq.${groupId}`,
      },
      onChange,
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'workout_profiles',
        filter: `group_id=eq.${groupId}`,
      },
      onChange,
    )
    .subscribe((status, error) => {
      if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && error) onError(error)
    })

  return () => void supabase.removeChannel(channel)
}