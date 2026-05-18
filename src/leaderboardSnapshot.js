import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore'
import { db } from './firebase'

export function formatLocalYMD(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function getYesterdayYMD() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return formatLocalYMD(d)
}

function lastUpdatedToDate(ts) {
  if (!ts) return null
  if (typeof ts.toDate === 'function') return ts.toDate()
  if (ts instanceof Date) return ts
  return null
}

function parseHistoryFromFirestore(h) {
  if (!Array.isArray(h)) return []
  return h
    .map((e) => {
      if (!e || typeof e.date !== 'string') return null
      return { date: e.date, count: Math.max(0, Math.floor(Number(e.count) || 0)) }
    })
    .filter(Boolean)
}

/** Best-effort score for a calendar day (handles pre-reset dailyCount + archived history). */
export function getScoreForDate(userData, dateYMD) {
  const last = lastUpdatedToDate(userData?.lastUpdated)
  if (last && formatLocalYMD(last) === dateYMD) {
    return Math.max(0, Math.floor(Number(userData.dailyCount) || 0))
  }
  const hist = parseHistoryFromFirestore(userData?.history)
  const entry = hist.find((h) => h.date === dateYMD)
  return entry ? entry.count : 0
}

export function parsePodiums(data) {
  const p = data?.podiums
  return {
    first: Math.max(0, Math.floor(Number(p?.first) || 0)),
    second: Math.max(0, Math.floor(Number(p?.second) || 0)),
    third: Math.max(0, Math.floor(Number(p?.third) || 0)),
  }
}

export const DEFAULT_PODIUMS = { first: 0, second: 0, third: 0 }

function normalizeRankingRow(r, index) {
  if (!r || typeof r !== 'object') return null
  const name =
    typeof r.name === 'string'
      ? r.name.trim()
      : typeof r.displayName === 'string'
        ? r.displayName.trim()
        : ''
  if (!name) return null
  const score = Math.max(0, Math.floor(Number(r.score ?? r.count ?? r.reps ?? r.total) || 0))
  const rankRaw = Number(r.rank ?? r.place ?? r.position)
  const rank = Number.isFinite(rankRaw) && rankRaw >= 1 ? Math.floor(rankRaw) : index + 1
  return { name, score, rank }
}

export function parseRankingsFromSnapshot(data) {
  if (!data) return []
  let raw = data.rankings
  if (!Array.isArray(raw) && Array.isArray(data.entries)) raw = data.entries
  if (!Array.isArray(raw) && Array.isArray(data.results)) raw = data.results
  if (!Array.isArray(raw)) return []
  return raw
    .map((r, i) => normalizeRankingRow(r, i))
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || b.score - a.score || a.name.localeCompare(b.name))
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidArchiveDateYMD(ymd) {
  return typeof ymd === 'string' && YMD_RE.test(ymd)
}

function scoreForCrewMember(member, dateYMD) {
  const hist = Array.isArray(member?.history) ? member.history : []
  const entry = hist.find((h) => h?.date === dateYMD)
  if (entry) return Math.max(0, Math.floor(Number(entry.count) || 0))
  const last = lastUpdatedToDate(member?.lastUpdated)
  if (last && formatLocalYMD(last) === dateYMD) {
    return Math.max(0, Math.floor(Number(member.today) || 0))
  }
  return 0
}

/** Build standings for a day from loaded crew rows (history + today). */
export function buildRankingsFromCrewMembers(members, dateYMD) {
  if (!isValidArchiveDateYMD(dateYMD)) return []
  const entries = []
  for (const m of members) {
    const score = scoreForCrewMember(m, dateYMD)
    if (score <= 0) continue
    const name = typeof m?.name === 'string' && m.name.trim() ? m.name.trim() : 'Unknown'
    entries.push({ name, score })
  }
  return assignCompetitionRanks(entries).map(({ name, score, rank }) => ({ name, score, rank }))
}

/** Full crew for one day — everyone appears, including 0-rep days (yesterday standings). */
export function buildFullGroupRankingsForDate(members, dateYMD, snapshotRankings = []) {
  if (!isValidArchiveDateYMD(dateYMD)) return []
  const scoreByName = new Map(
    snapshotRankings.map((r) => [
      r.name.trim().toLowerCase(),
      Math.max(0, Math.floor(Number(r.score) || 0)),
    ]),
  )
  const entries = []
  for (const m of members) {
    const name = typeof m?.name === 'string' && m.name.trim() ? m.name.trim() : 'Unknown'
    const key = name.toLowerCase()
    const score = scoreByName.has(key) ? scoreByName.get(key) : scoreForCrewMember(m, dateYMD)
    entries.push({ name, score })
  }
  return assignCompetitionRanks(entries).map(({ name, score, rank }) => ({ name, score, rank }))
}

/** Union of Firestore snapshot doc ids and dates found in crew history. */
/** History picker: archived days only (excludes today and yesterday). */
export function filterLeaderboardHistoryDates(dates, yesterdayYMD) {
  if (!yesterdayYMD) {
    return dates.filter(isValidArchiveDateYMD)
  }
  return dates.filter((d) => isValidArchiveDateYMD(d) && d < yesterdayYMD)
}

export function discoverGroupArchiveDates(firestoreDateIds, crewMembers) {
  const dates = new Set(firestoreDateIds.filter(isValidArchiveDateYMD))
  for (const m of crewMembers) {
    for (const h of m.history ?? []) {
      if (h?.date && isValidArchiveDateYMD(h.date) && (h.count ?? 0) > 0) {
        dates.add(h.date)
      }
    }
    const last = lastUpdatedToDate(m?.lastUpdated)
    if (last && (m.today ?? 0) > 0) {
      const d = formatLocalYMD(last)
      if (isValidArchiveDateYMD(d)) dates.add(d)
    }
  }
  return [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
}

/** Competition ranking: tied scores share the same rank. */
export function assignCompetitionRanks(entries) {
  const sorted = [...entries].sort(
    (a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)),
  )
  const out = []
  let rank = 0
  let prevScore = null
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]
    if (prevScore === null || e.score < prevScore) rank = i + 1
    prevScore = e.score
    out.push({ ...e, rank })
  }
  return out
}

function snapshotRef(groupId, dateYMD) {
  return doc(db, 'groups', groupId, 'dailyLeaderboards', dateYMD)
}

function collectScoreDatesFromUserData(data) {
  const dates = new Set()
  for (const h of parseHistoryFromFirestore(data?.history)) {
    if (h.count > 0) dates.add(h.date)
  }
  const last = lastUpdatedToDate(data?.lastUpdated)
  if (last) {
    const d = formatLocalYMD(last)
    if (getScoreForDate(data, d) > 0) dates.add(d)
  }
  return dates
}

/** All calendar days with scores across a group's user documents. */
export function collectGroupArchiveDatesFromUsers(userDocs) {
  const dates = new Set()
  for (const { data } of userDocs) {
    for (const d of collectScoreDatesFromUserData(data)) {
      if (isValidArchiveDateYMD(d)) dates.add(d)
    }
  }
  return [...dates].sort((a, b) => a.localeCompare(b))
}

async function loadGroupUserDocs(groupId) {
  const gid = groupId.trim().toLowerCase()
  if (!gid) return []
  const usersSnap = await getDocs(query(collection(db, 'users'), where('groupId', '==', gid)))
  return usersSnap.docs.map((d) => ({ id: d.id, data: d.data() }))
}

function buildRankedEntriesForDate(userDocs, dateYMD, options = {}) {
  const { includeZeroScores = false } = options
  const entries = []
  for (const { id, data } of userDocs) {
    const score = getScoreForDate(data, dateYMD)
    if (score <= 0 && !includeZeroScores) continue
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : id
    entries.push({ userId: id, name, score })
  }
  const ranked = assignCompetitionRanks(entries)
  return {
    ranked,
    publicRankings: ranked.map(({ name, score, rank }) => ({ name, score, rank })),
  }
}

/**
 * Creates a group daily leaderboard snapshot for one date if missing.
 * @returns {{ status: 'invalid'|'exists'|'empty'|'created', rankings: Array }}
 */
export async function ensureGroupSnapshotForDate(groupId, dateYMD, options = {}) {
  const { awardPodiums = false, includeZeroScores = false } = options
  const gid = groupId.trim().toLowerCase()
  if (!gid || !isValidArchiveDateYMD(dateYMD)) {
    return { status: 'invalid', rankings: [] }
  }

  const snapRef = snapshotRef(gid, dateYMD)
  const existing = await getDoc(snapRef)
  if (existing.exists()) {
    return { status: 'exists', rankings: parseRankingsFromSnapshot(existing.data()) }
  }

  const userDocs = await loadGroupUserDocs(gid)
  const { ranked, publicRankings } = buildRankedEntriesForDate(userDocs, dateYMD, {
    includeZeroScores,
  })
  if (publicRankings.length === 0) {
    return { status: 'empty', rankings: [] }
  }

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(snapRef)
    if (snap.exists()) return

    const podiumEntries = awardPodiums ? ranked.filter((r) => r.rank <= 3) : []
    const userRefs = podiumEntries.map((r) => doc(db, 'users', r.userId))
    const userSnaps =
      podiumEntries.length > 0
        ? await Promise.all(userRefs.map((ref) => transaction.get(ref)))
        : []

    transaction.set(snapRef, {
      date: dateYMD,
      rankings: publicRankings,
      createdAt: serverTimestamp(),
    })

    if (!awardPodiums) return

    for (let i = 0; i < podiumEntries.length; i++) {
      const { userId, rank } = podiumEntries[i]
      const userSnap = userSnaps[i]
      if (!userSnap.exists()) continue

      const field =
        rank === 1 ? 'podiums.first' : rank === 2 ? 'podiums.second' : 'podiums.third'
      transaction.update(doc(db, 'users', userId), {
        [field]: increment(1),
      })
    }
  })

  const after = await getDoc(snapRef)
  return { status: 'created', rankings: parseRankingsFromSnapshot(after.data()) }
}

/**
 * Rebuilds one day's group snapshot from current user documents (overwrites rankings).
 */
export async function rebuildGroupSnapshotForDate(groupId, dateYMD, options = {}) {
  const { includeZeroScores = true } = options
  const gid = groupId.trim().toLowerCase()
  if (!gid || !isValidArchiveDateYMD(dateYMD)) {
    return { status: 'invalid', rankings: [] }
  }

  const userDocs = await loadGroupUserDocs(gid)
  const { publicRankings } = buildRankedEntriesForDate(userDocs, dateYMD, { includeZeroScores })
  const snapRef = snapshotRef(gid, dateYMD)

  if (publicRankings.length === 0) {
    return { status: 'empty', rankings: [] }
  }

  await setDoc(
    snapRef,
    {
      date: dateYMD,
      rankings: publicRankings,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )

  return { status: 'updated', rankings: publicRankings }
}

/**
 * Writes missing `dailyLeaderboards` docs from crew history (retroactive).
 * Does not award podiums by default — avoids inflating counts for past days.
 */
export async function backfillGroupDailyLeaderboards(groupId, options = {}) {
  const { awardPodiums = false, onProgress } = options
  const gid = groupId.trim().toLowerCase()
  if (!gid) {
    return { dates: [], created: [], skipped: [], empty: [], failed: [] }
  }

  const userDocs = await loadGroupUserDocs(gid)
  const dates = collectGroupArchiveDatesFromUsers(userDocs)
  const summary = { dates, created: [], skipped: [], empty: [], failed: [] }

  for (const dateYMD of dates) {
    onProgress?.(dateYMD)
    try {
      const result = await ensureGroupSnapshotForDate(gid, dateYMD, { awardPodiums })
      if (result.status === 'created') summary.created.push(dateYMD)
      else if (result.status === 'exists') summary.skipped.push(dateYMD)
      else if (result.status === 'empty') summary.empty.push(dateYMD)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      summary.failed.push({ date: dateYMD, message })
    }
  }

  return summary
}

/**
 * Creates yesterday's group snapshot if missing. Run before per-user lazy reset.
 * Returns parsed rankings (public fields only).
 */
export async function ensureYesterdayGroupSnapshot(groupId) {
  const yesterday = getYesterdayYMD()
  const result = await ensureGroupSnapshotForDate(groupId, yesterday, {
    awardPodiums: true,
    includeZeroScores: true,
  })
  return result.rankings
}

export function ymdToDisplayLabel(ymd) {
  const parts = ymd.split('-').map((x) => Number.parseInt(x, 10))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return ymd
  const [y, m, d] = parts
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}
