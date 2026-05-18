/**
 * One-off: create missing group dailyLeaderboards from user history.
 *
 * Usage (from project root, with .env.local configured):
 *   npm run backfill:group -- ketty789
 */
import { backfillGroupDailyLeaderboards } from '../src/leaderboardSnapshot.js'

const groupId = process.argv[2]?.trim().toLowerCase()

if (!groupId) {
  console.error('Usage: npm run backfill:group -- <group-id>')
  console.error('Example: npm run backfill:group -- ketty789')
  process.exit(1)
}

console.log(`Backfilling dailyLeaderboards for group "${groupId}"…`)
console.log('(Podium counts are not updated for past days.)\n')

const summary = await backfillGroupDailyLeaderboards(groupId, {
  awardPodiums: false,
  onProgress: (dateYMD) => console.log(`  ${dateYMD}`),
})

console.log('\nDone.')
console.log(`  Dates scanned: ${summary.dates.length}`)
console.log(`  Created:       ${summary.created.length}`, summary.created)
console.log(`  Already exist: ${summary.skipped.length}`)
console.log(`  Empty (no scores): ${summary.empty.length}`)
if (summary.failed.length > 0) {
  console.log(`  Failed:        ${summary.failed.length}`)
  for (const f of summary.failed) console.log(`    ${f.date}: ${f.message}`)
}

process.exit(summary.failed.length > 0 ? 1 : 0)
