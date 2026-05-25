/**
 * Add or update one retro day for a crew member (user history + group snapshot).
 *
 * Usage (from project root, with .env.local):
 *   npm run retro:day -- <group-id> <display-name> <date> <count> [goal]
 *
 * Goal is optional — defaults to the user's current dailyGoal in Firestore.
 *
 * Examples:
 *   npm run retro:day -- ketty789 אלמוג 16-5 120 100
 *   npm run retro:day -- ketty789 Nadav 24-5 475
 *   npm run retro:day -- ketty789 אלמוג 16-5 120 100 --dry-run
 */
import { rebuildGroupSnapshotForDate } from '../src/leaderboardSnapshot.js'
import { parseRetroDateInput, upsertUserHistoryDay } from '../src/retroHistory.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const positional = args.filter((a) => a !== '--dry-run')

const [groupId, displayName, dateInput, countStr, goalStr] = positional

if (!groupId || !displayName || !dateInput || countStr === undefined) {
  console.error(
    'Usage: npm run retro:day -- <group-id> <display-name> <date> <count> [goal] [--dry-run]',
  )
  console.error('Example: npm run retro:day -- ketty789 Nadav 24-5 475')
  process.exit(1)
}

let dateYMD
try {
  dateYMD = parseRetroDateInput(dateInput)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

const count = Number.parseInt(countStr, 10)
if (!Number.isFinite(count) || count < 0) {
  console.error('count must be a non-negative integer')
  process.exit(1)
}

let goal
if (goalStr !== undefined) {
  goal = Number.parseInt(goalStr, 10)
  if (!Number.isFinite(goal) || goal < 1) {
    console.error('goal must be a positive integer when provided')
    process.exit(1)
  }
}

console.log(
  dryRun ? '[dry-run] ' : '',
  `Retro day for "${displayName}" in group "${groupId}"`,
)
console.log(`  Date:  ${dateYMD} (from "${dateInput}")`)
console.log(`  Reps:  ${count}`)
console.log(`  Goal:  ${goal !== undefined ? goal : '(current dailyGoal from profile)'}\n`)

try {
  const userResult = await upsertUserHistoryDay({
    groupId,
    displayName,
    dateYMD,
    count,
    goal,
    dryRun,
  })

  console.log('User history:')
  console.log(`  Document: users/${userResult.userDocId}`)
  if (userResult.previousCount > 0) {
    console.log(`  Was:      ${userResult.previousCount} reps`)
  }
  console.log(`  Now:      ${userResult.count} reps (goal ${userResult.goal}, met: ${userResult.count >= userResult.goal})`)
  if (userResult.totalDelta) {
    console.log(`  totalCount: ${userResult.totalCount} (${userResult.totalDelta > 0 ? '+' : ''}${userResult.totalDelta})`)
  } else {
    console.log(`  totalCount: ${userResult.totalCount} (unchanged — restoring missing history only)`)
  }

  if (dryRun) {
    console.log('\n[dry-run] Skipped Firestore writes.')
    process.exit(0)
  }

  const snap = await rebuildGroupSnapshotForDate(groupId, dateYMD)
  console.log('\nGroup dailyLeaderboards:')
  if (snap.status === 'updated') {
    console.log(`  Updated groups/${groupId.trim().toLowerCase()}/dailyLeaderboards/${dateYMD}`)
    for (const r of snap.rankings) {
      console.log(`    #${r.rank} ${r.name} — ${r.score}`)
    }
  } else {
    console.log(`  Status: ${snap.status} (no snapshot written)`)
  }

  console.log('\nDone.')
} catch (err) {
  console.error('\nFailed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
}
