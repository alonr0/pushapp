/**
 * Fill goalAtDayEnd / goalMet on all history entries in a group.
 *
 * Usage:
 *   npm run enrich:history -- <group-id> [--dry-run]
 */
import { enrichGroupHistoryGoals } from '../src/retroHistory.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const groupId = args.find((a) => a !== '--dry-run')?.trim()

if (!groupId) {
  console.error('Usage: npm run enrich:history -- <group-id> [--dry-run]')
  process.exit(1)
}

const result = await enrichGroupHistoryGoals(groupId, { dryRun })

console.log(dryRun ? '[dry-run] ' : '', `Group "${result.groupId}"`)
console.log(`  Updated: ${result.updated.length}`)
for (const u of result.updated) {
  console.log(`    ${u.name} — ${u.days} days (fallback goal ${u.goalUsed})`)
}
console.log(`  Skipped: ${result.skipped.length}`)
for (const s of result.skipped) {
  console.log(`    ${s.name} — ${s.reason}`)
}
