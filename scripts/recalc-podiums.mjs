/**
 * Rebuild podium counts from closed dailyLeaderboards only (excludes today).
 *
 * Usage (from project root, with .env.local):
 *   npm run recalc:podiums -- ketty789
 *   npm run recalc:podiums -- ketty789 --dry-run
 */
import { recalcGroupPodiumsFromSnapshots } from '../src/leaderboardSnapshot.js'

const args = process.argv.slice(2).filter((a) => a !== '--dry-run')
const dryRun = process.argv.includes('--dry-run')
const groupId = args[0]?.trim().toLowerCase()

if (!groupId) {
  console.error('Usage: npm run recalc:podiums -- <group-id> [--dry-run]')
  console.error('Example: npm run recalc:podiums -- ketty789 --dry-run')
  process.exit(1)
}

console.log(
  dryRun ? `[dry-run] Recalculating podiums for "${groupId}"…` : `Recalculating podiums for "${groupId}"…`,
)
console.log('(Uses finished days only — today is excluded.)\n')

const summary = await recalcGroupPodiumsFromSnapshots(groupId, {
  dryRun,
  onProgress: (msg) => console.log(`  ${msg}`),
})

console.log('\nDone.')
console.log(`  Users:       ${summary.users}`)
console.log(`  Closed days: ${summary.closedDays.length}`, summary.closedDays)
if (summary.skippedOpen.length > 0) {
  console.log(`  Skipped:     ${summary.skippedOpen.length} (open days, e.g. today)`, summary.skippedOpen)
}
if (summary.unmatched.length > 0) {
  console.log(`  Unmatched:   ${summary.unmatched.length}`)
  for (const u of summary.unmatched) console.log(`    ${u.date} #${u.rank} ${u.name}`)
}
console.log('\n  Podium totals:')
for (const u of summary.podiumsByUser) {
  const { first, second, third } = u.podiums
  if (first === 0 && second === 0 && third === 0) continue
  console.log(`    ${u.name}: 🥇${first} 🥈${second} 🥉${third}`)
}

if (dryRun) console.log('\n[dry-run] No Firestore writes.')
process.exit(0)
