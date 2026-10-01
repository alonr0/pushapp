import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateStreakRewards,
  currentStreakDays,
  EXERCISES,
  getIsraelDate,
  scoreDay,
  scoreExercise,
} from './workoutScoring.js'

test('every exercise limit is worth 25 base points', () => {
  for (const exercise of EXERCISES) {
    assert.equal(scoreExercise(exercise.id, exercise.limit), 25)
  }
})

test('points scale with reps and round to one decimal place', () => {
  assert.equal(scoreExercise('pushups', 1), 0.3)
  assert.equal(scoreExercise('pullups', 1), 0.5)
  assert.equal(scoreExercise('crunches', 1), 0.2)
  assert.equal(scoreExercise('squats', 75), 12.5)
})

test('day score awards category and all-category bonuses up to 118', () => {
  const complete = scoreDay({ pushups: 100, pullups: 50, crunches: 150, squats: 150 })
  assert.equal(complete.basePoints, 100)
  assert.equal(complete.categoryBonus, 8)
  assert.equal(complete.allCategoriesBonus, 10)
  assert.equal(complete.dailyPoints, 118)

  const partial = scoreDay({ pushups: 100 })
  assert.equal(partial.dailyPoints, 27)
  assert.equal(partial.qualifiesForStreak, false)
})

test('streak qualification requires at least one rep in every exercise', () => {
  const oneRepEach = scoreDay({ pushups: 1, pullups: 1, crunches: 1, squats: 1 })
  const missingOneExercise = scoreDay({ pushups: 1, pullups: 1, crunches: 1 })
  assert.equal(oneRepEach.qualifiesForStreak, true)
  assert.equal(missingOneExercise.qualifiesForStreak, false)
})

test('invalid exercise counts are rejected instead of clipped', () => {
  assert.throws(() => scoreExercise('pushups', 101), /integer from 0 to 100/)
  assert.throws(() => scoreExercise('pullups', -1), /integer from 0 to 50/)
  assert.throws(() => scoreExercise('running', 1), /Unknown exercise/)
})

test('streak points accrue for every completed seven-day run block', () => {
  assert.equal(
    calculateStreakRewards([
      '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
      '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08',
      '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12',
      '2026-09-13', '2026-09-14', '2026-09-20',
    ]),
    10,
  )
})

test('current streak starts today or yesterday and uses all-exercise completion', () => {
  const rows = [
    { user_id: 'member', activity_date: '2026-09-27', pushups_reps: 1, pullups_reps: 1, crunches_reps: 1, squats_reps: 1 },
    { user_id: 'member', activity_date: '2026-09-28', pushups_reps: 1, pullups_reps: 1, crunches_reps: 0, squats_reps: 1 },
    { user_id: 'member', activity_date: '2026-09-29', pushups_reps: 1, pullups_reps: 1, crunches_reps: 1, squats_reps: 1 },
    { user_id: 'other', activity_date: '2026-09-29', pushups_reps: 1, pullups_reps: 1, crunches_reps: 1, squats_reps: 1 },
  ]
  assert.equal(currentStreakDays(rows, 'member', '2026-09-29'), 1)
  assert.equal(currentStreakDays(rows, 'member', '2026-09-30'), 1)
})

test('Israel calendar date follows Asia/Jerusalem rather than device timezone', () => {
  assert.equal(getIsraelDate(new Date('2026-01-01T21:59:00.000Z')), '2026-01-01')
  assert.equal(getIsraelDate(new Date('2026-01-01T22:00:00.000Z')), '2026-01-02')
  assert.equal(getIsraelDate(new Date('2026-03-26T21:59:00.000Z')), '2026-03-26')
  assert.equal(getIsraelDate(new Date('2026-03-26T22:00:00.000Z')), '2026-03-27')
  assert.equal(getIsraelDate(new Date('2026-03-27T00:00:00.000Z')), '2026-03-27')
  assert.equal(getIsraelDate(new Date('2026-10-24T20:59:00.000Z')), '2026-10-24')
  assert.equal(getIsraelDate(new Date('2026-10-24T21:00:00.000Z')), '2026-10-25')
})