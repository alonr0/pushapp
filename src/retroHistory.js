import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'
import { formatLocalYMD, isValidArchiveDateYMD } from './leaderboardSnapshot'

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

function toUserDocumentId(displayName, groupId) {
  const g = groupId.trim().toLowerCase().replace(/[/:]/g, '-')
  const n = displayName.trim().toLowerCase().replace(/[/:]/g, '-')
  return `${g}::${n}`
}

function normalizeHistoryEntry(e) {
  if (!e || typeof e.date !== 'string') return null
  const count = Math.max(0, Math.floor(Number(e.count) || 0))
  const goalAtDayEnd = Number(e.goalAtDayEnd)
  const goalMet =
    typeof e.goalMet === 'boolean'
      ? e.goalMet
      : Number.isFinite(goalAtDayEnd) && goalAtDayEnd > 0
        ? count >= goalAtDayEnd
        : false
  return {
    date: e.date,
    count,
    goalMet,
    goalAtDayEnd: Number.isFinite(goalAtDayEnd) && goalAtDayEnd > 0 ? goalAtDayEnd : undefined,
  }
}

function parseHistoryFromFirestore(h) {
  if (!Array.isArray(h)) return []
  return h.map(normalizeHistoryEntry).filter(Boolean)
}

/** Accepts YYYY-MM-DD, DD-MM, DD/MM, DD-MM-YYYY, etc. */
export function parseRetroDateInput(input) {
  const s = String(input ?? '').trim()
  if (YMD_RE.test(s)) return s

  const m = s.match(/^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?$/)
  if (!m) throw new Error(`Invalid date "${input}" — use YYYY-MM-DD or DD-MM (e.g. 16-5)`)

  const day = Number.parseInt(m[1], 10)
  const month = Number.parseInt(m[2], 10)
  let year = m[3] ? Number.parseInt(m[3], 10) : new Date().getFullYear()
  if (year < 100) year += 2000

  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
    throw new Error(`Invalid date "${input}"`)
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid date "${input}"`)
  }

  const ymd = formatLocalYMD(new Date(year, month - 1, day, 12, 0, 0, 0))
  if (!isValidArchiveDateYMD(ymd)) throw new Error(`Invalid date "${input}"`)
  return ymd
}

/**
 * Add or replace one day in a user's history (Firestore).
 * @returns {{ userDocId, dateYMD, previousCount, count, goal, totalCount }}
 */
export async function upsertUserHistoryDay({
  groupId,
  displayName,
  dateYMD,
  count,
  goal,
  dryRun = false,
}) {
  const gid = groupId.trim().toLowerCase()
  const name = displayName.trim()
  if (!gid || !name) throw new Error('groupId and displayName are required')
  if (!isValidArchiveDateYMD(dateYMD)) throw new Error(`Invalid dateYMD: ${dateYMD}`)

  const reps = Math.max(0, Math.floor(Number(count) || 0))
  const goalAtDayEnd = Math.max(1, Math.floor(Number(goal) || 0))
  const userDocId = toUserDocumentId(name, gid)
  const ref = doc(db, 'users', userDocId)
  const snap = await getDoc(ref)

  if (!snap.exists()) {
    throw new Error(
      `User not found: users/${userDocId}. Check group id and display name (e.g. אלמוג).`,
    )
  }

  const data = snap.data()
  const history = parseHistoryFromFirestore(data.history)
  const prev = history.find((e) => e.date === dateYMD)
  const previousCount = prev?.count ?? 0
  const entry = {
    date: dateYMD,
    count: reps,
    goalMet: reps >= goalAtDayEnd,
    goalAtDayEnd,
  }
  const nextHistory = [...history.filter((e) => e.date !== dateYMD), entry].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  )
  const totalCount = Math.max(0, (Number(data.totalCount) || 0) + (reps - previousCount))

  if (!dryRun) {
    await updateDoc(ref, { history: nextHistory, totalCount })
  }

  return {
    userDocId,
    dateYMD,
    previousCount,
    count: reps,
    goal: goalAtDayEnd,
    totalCount,
    dryRun,
  }
}
