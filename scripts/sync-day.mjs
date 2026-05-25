/**
 * Rebuild one day's group snapshot (full crew, including 0s) and optionally award podiums.
 *
 * Usage:
 *   npm run sync:day -- <group-id> <date> [--award-podiums] [--dry-run]
 *
 * Example:
 *   npm run sync:day -- ketty789 21-5 --award-podiums
 */
import { parseRetroDateInput } from '../src/retroHistory.js'
import {
  isClosedCalendarDay,
  rebuildGroupSnapshotForDate,
  syncGroupSnapshotForDate,
} from '../src/leaderboardSnapshot.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const awardPodiums = args.includes('--award-podiums')
const positional = args.filter((a) => a !== '--dry-run' && a !== '--award-podiums')

const [groupId, dateInput] = positional
if (!groupId || !dateInput) {
  console.error('Usage: npm run sync:day -- <group-id> <date> [--award-podiums] [--dry-run]')
  process.exit(1)
}

let dateYMD
try {
  dateYMD = parseRetroDateInput(dateInput)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

console.log(`Group: ${groupId}`)
console.log(`Date:  ${dateYMD}`)
console.log(`Award podiums: ${awardPodiums}`)
if (!isClosedCalendarDay(dateYMD)) {
  console.warn('Warning: day is not closed yet — podiums will not be awarded.')
}

if (dryRun) {
  console.log('\n[dry-run] No writes.')
  process.exit(0)
}

const rebuilt = await rebuildGroupSnapshotForDate(groupId, dateYMD, { includeZeroScores: true })
console.log(`\nSnapshot rebuild: ${rebuilt.status}`)
for (const r of rebuilt.rankings) {
  console.log(`  #${r.rank} ${r.name} — ${r.score}`)
}

if (awardPodiums) {
  const synced = await syncGroupSnapshotForDate(groupId, dateYMD, {
    awardPodiums: true,
    includeZeroScores: true,
  })
  console.log(`\nPodium sync: ${synced.status}`)
}

console.log('\nDone. Run recalc:podiums if medal totals look wrong across all days.')
