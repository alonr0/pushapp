/**
 * Read-only: verify each user's totalCount matches history (+ unarchived today).
 *
 * Usage:
 *   npm run check:totals -- <group-id>
 */
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../src/firebase.js'
import { formatLocalYMD, lastUpdatedToDate } from '../src/leaderboardSnapshot.js'

const groupId = process.argv[2]?.trim().toLowerCase()
if (!groupId) {
  console.error('Usage: npm run check:totals -- <group-id>')
  process.exit(1)
}

const todayYMD = formatLocalYMD(new Date())

function parseHistory(h) {
  if (!Array.isArray(h)) return []
  return h
    .map((e) => {
      if (!e || typeof e.date !== 'string') return null
      return { date: e.date, count: Math.max(0, Math.floor(Number(e.count) || 0)) }
    })
    .filter(Boolean)
}

const usersSnap = await getDocs(query(collection(db, 'users'), where('groupId', '==', groupId)))
if (usersSnap.empty) {
  console.error(`No users in group "${groupId}"`)
  process.exit(1)
}

console.log(`Group: ${groupId}`)
console.log(`Today: ${todayYMD}\n`)

let ok = 0
let mismatch = 0

const rows = usersSnap.docs.map((d) => {
  const data = d.data()
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : d.id
  const totalCount = Math.max(0, Math.floor(Number(data.totalCount) || 0))
  const history = parseHistory(data.history)
  const historySum = history.reduce((s, e) => s + e.count, 0)
  const last = lastUpdatedToDate(data.lastUpdated)
  const lastYMD = last ? formatLocalYMD(last) : null
  const dailyCount = Math.max(0, Math.floor(Number(data.dailyCount) || 0))
  const todayInHistory = history.some((e) => e.date === todayYMD)

  let unarchivedToday = 0
  let staleDaily = 0
  if (!todayInHistory && lastYMD === todayYMD) {
    unarchivedToday = dailyCount
  } else if (lastYMD && lastYMD !== todayYMD && dailyCount > 0) {
    staleDaily = dailyCount
  }

  const expected = historySum + unarchivedToday
  const delta = totalCount - expected
  const historyOnlyDelta = totalCount - historySum

  return {
    name,
    totalCount,
    historySum,
    unarchivedToday,
    staleDaily,
    expected,
    delta,
    historyOnlyDelta,
    days: history.length,
  }
})

rows.sort((a, b) => a.name.localeCompare(b.name))

for (const r of rows) {
  const match = r.delta === 0
  if (match) ok++
  else mismatch++

  const status = match ? 'OK' : 'MISMATCH'
  console.log(`${status}  ${r.name}`)
  console.log(`      totalCount:     ${r.totalCount}`)
  console.log(`      sum(history):   ${r.historySum}  (${r.days} days)`)
  if (r.unarchivedToday > 0) {
    console.log(`      + today (live): ${r.unarchivedToday}`)
  }
  if (r.staleDaily > 0) {
    console.log(`      ⚠ stale dailyCount (not in history): ${r.staleDaily}  (last active ${r.lastYMD ?? '?'})`)
  }
  if (!match) {
    console.log(`      expected:       ${r.expected}`)
    console.log(`      delta:          ${r.delta > 0 ? '+' : ''}${r.delta}`)
    if (r.historyOnlyDelta !== r.delta) {
      console.log(`      (history-only gap: ${r.historyOnlyDelta > 0 ? '+' : ''}${r.historyOnlyDelta})`)
    }
  }
  console.log('')
}

console.log(`Summary: ${ok} OK, ${mismatch} mismatch(es)`)
process.exit(mismatch > 0 ? 1 : 0)
