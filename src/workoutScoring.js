export const EXERCISES = [
  { id: 'pushups', limit: 100, label: { en: 'Push-ups', he: 'שכיבות סמיכה' } },
  { id: 'pullups', limit: 50, label: { en: 'Pull-ups', he: 'מתח' } },
  { id: 'crunches', limit: 150, label: { en: 'Crunches', he: 'כפיפות בטן' } },
  { id: 'squats', limit: 150, label: { en: 'Squats', he: 'סקוואטים' } },
]

export const BASE_POINTS_PER_EXERCISE = 25
export const CATEGORY_COMPLETION_BONUS = 2
export const ALL_CATEGORIES_BONUS = 10
export const STREAK_THRESHOLD = 60
export const STREAK_BLOCK_DAYS = 7
export const STREAK_BLOCK_POINTS = 5
export const ISRAEL_TIME_ZONE = 'Asia/Jerusalem'

export function scoreExercise(exerciseId, reps) {
  const exercise = EXERCISES.find((item) => item.id === exerciseId)
  if (!exercise) throw new Error('Unknown exercise')
  const safeReps = Number(reps)
  if (!Number.isInteger(safeReps) || safeReps < 0 || safeReps > exercise.limit) {
    throw new Error(`Reps must be an integer from 0 to ${exercise.limit}`)
  }
  return Math.round((BASE_POINTS_PER_EXERCISE * safeReps * 10) / exercise.limit) / 10
}

export function scoreDay(repsByExercise) {
  const reps = Object.fromEntries(
    EXERCISES.map(({ id }) => [id, Number(repsByExercise?.[id] ?? 0)]),
  )
  const basePoints = Math.round(
    EXERCISES.reduce((total, { id }) => total + scoreExercise(id, reps[id]), 0) * 10,
  ) / 10
  const completedCategories = EXERCISES.filter(
    ({ id, limit }) => reps[id] === limit,
  ).length
  const categoryBonus = completedCategories * CATEGORY_COMPLETION_BONUS
  const allCategoriesBonus = completedCategories === EXERCISES.length ? ALL_CATEGORIES_BONUS : 0

  return {
    reps,
    basePoints,
    completedCategories,
    categoryBonus,
    allCategoriesBonus,
    dailyPoints: basePoints + categoryBonus + allCategoriesBonus,
    qualifiesForStreak: basePoints >= STREAK_THRESHOLD,
  }
}

export function calculateStreakRewards(qualifyingDates) {
  const sorted = [...new Set(qualifyingDates)].sort()
  let currentRun = 0
  let totalBlocks = 0
  let previousDate = null

  for (const date of sorted) {
    const current = new Date(`${date}T12:00:00Z`)
    if (Number.isNaN(current.getTime())) throw new Error('Invalid activity date')
    if (previousDate) {
      const previous = new Date(`${previousDate}T12:00:00Z`)
      const difference = (current - previous) / 86_400_000
      if (difference !== 1) currentRun = 0
    }
    currentRun += 1
    if (currentRun % STREAK_BLOCK_DAYS === 0) totalBlocks += 1
    previousDate = date
  }

  return totalBlocks * STREAK_BLOCK_POINTS
}

export function getIsraelDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ISRAEL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${fields.year}-${fields.month}-${fields.day}`
}

export function currentStreakDays(dailyRows, userId, today = getIsraelDate()) {
  const qualifyingDates = new Set(
    dailyRows
      .filter((row) => row.user_id === userId && Number(row.base_points) >= STREAK_THRESHOLD)
      .map((row) => row.activity_date),
  )
  const cursor = new Date(`${today}T12:00:00Z`)
  if (!qualifyingDates.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1)

  let streak = 0
  while (qualifyingDates.has(cursor.toISOString().slice(0, 10))) {
    streak += 1
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return streak
}