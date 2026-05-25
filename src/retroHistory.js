import { collection, doc, getDoc, getDocs, query, updateDoc, where } from 'firebase/firestore'
import { db } from './firebase'
import { DEFAULT_DAILY_GOAL, formatLocalYMD, isValidArchiveDateYMD } from './leaderboardSnapshot'

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

export function toUserDocumentId(displayName, groupId) {
  const g = groupId.trim().toLowerCase().replace(/[/:]/g, '-')
  const n = displayName.trim().toLowerCase().replace(/[/:]/g, '-')
  return `${g}::${n}`
}

export function getUserDailyGoal(data) {
  const g = Number(data?.dailyGoal)
  if (Number.isFinite(g) && g > 0) return Math.min(Math.floor(g), 99_999)
  return DEFAULT_DAILY_GOAL
}

/** Full Firestore history row with goal fields (no undefined). */
export function buildHistoryEntry({ date, count, goalAtDayEnd }) {
  const goal = Math.max(1, Math.floor(Number(goalAtDayEnd) || DEFAULT_DAILY_GOAL))
  const c = Math.max(0, Math.floor(Number(count) || 0))
  return {
    date,
    count: c,
    goalAtDayEnd: goal,
    goalMet: c >= goal,
  }
}

/** Enrich one raw or parsed entry; uses fallbackGoal only when goalAtDayEnd is missing. */
export function enrichHistoryEntry(entry, fallbackGoal) {
  if (!entry || typeof entry.date !== 'string') return null
  const existingGoal = Number(entry.goalAtDayEnd)
  const goalAtDayEnd =
    Number.isFinite(existingGoal) && existingGoal > 0
      ? Math.floor(existingGoal)
      : Math.max(1, Math.floor(Number(fallbackGoal) || DEFAULT_DAILY_GOAL))
  return buildHistoryEntry({
    date: entry.date,
    count: entry.count,
    goalAtDayEnd,
  })
}

export function enrichHistoryArray(history, fallbackGoal) {
  if (!Array.isArray(history)) return []
  return history
    .map((e) => enrichHistoryEntry(e, fallbackGoal))
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

function historyNeedsEnrich(history) {
  if (!Array.isArray(history)) return true
  return history.some((e) => {
    if (!e || typeof e.date !== 'string') return true
    const g = Number(e.goalAtDayEnd)
    return !(Number.isFinite(g) && g > 0) || typeof e.goalMet !== 'boolean'
  })
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
 * @param {object} opts
 * @param {number} [opts.goal] — omit to use the user's current dailyGoal
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
  const userDocId = toUserDocumentId(name, gid)
  const ref = doc(db, 'users', userDocId)
  const snap = await getDoc(ref)

  if (!snap.exists()) {
    throw new Error(
      `User not found: users/${userDocId}. Check group id and display name (e.g. אלמוג).`,
    )
  }

  const data = snap.data()
  const fallbackGoal = getUserDailyGoal(data)
  const goalAtDayEnd =
    goal !== undefined && goal !== null && Number.isFinite(Number(goal)) && Number(goal) > 0
      ? Math.max(1, Math.floor(Number(goal)))
      : fallbackGoal

  const history = enrichHistoryArray(data.history, fallbackGoal)
  const prev = history.find((e) => e.date === dateYMD)
  const previousCount = prev?.count ?? 0
  const entry = buildHistoryEntry({ date: dateYMD, count: reps, goalAtDayEnd })
  const nextHistory = enrichHistoryArray(
    [...history.filter((e) => e.date !== dateYMD), entry],
    fallbackGoal,
  )

  const totalDelta = previousCount > 0 ? reps - previousCount : 0
  const totalCount = Math.max(0, (Number(data.totalCount) || 0) + totalDelta)

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
    totalDelta,
    dryRun,
  }
}

/**
 * Fill goalAtDayEnd / goalMet on every history entry in a group.
 * Missing goals use each member's current dailyGoal (update-time only).
 */
export async function enrichGroupHistoryGoals(groupId, options = {}) {
  const { dryRun = false } = options
  const gid = groupId.trim().toLowerCase()
  if (!gid) throw new Error('groupId is required')

  const usersSnap = await getDocs(query(collection(db, 'users'), where('groupId', '==', gid)))
  const updated = []
  const skipped = []

  for (const d of usersSnap.docs) {
    const data = d.data()
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : d.id
    const fallbackGoal = getUserDailyGoal(data)
    const nextHistory = enrichHistoryArray(data.history, fallbackGoal)

    if (nextHistory.length === 0) {
      skipped.push({ userId: d.id, name, reason: 'no history' })
      continue
    }
    if (!historyNeedsEnrich(data.history)) {
      skipped.push({ userId: d.id, name, reason: 'already complete' })
      continue
    }

    if (!dryRun) {
      await updateDoc(doc(db, 'users', d.id), { history: nextHistory })
    }
    updated.push({ userId: d.id, name, days: nextHistory.length, goalUsed: fallbackGoal })
  }

  return { groupId: gid, updated, skipped, dryRun }
}
