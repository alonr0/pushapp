import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  query,
  runTransaction,
  serverTimestamp,
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

/**
 * Creates yesterday's group snapshot if missing. Run before per-user lazy reset.
 * Returns parsed rankings (public fields only).
 */
export async function ensureYesterdayGroupSnapshot(groupId) {
  const gid = groupId.trim().toLowerCase()
  if (!gid) return []

  const yesterday = getYesterdayYMD()
  const snapRef = snapshotRef(gid, yesterday)

  const existing = await getDoc(snapRef)
  if (existing.exists()) {
    return parseRankingsFromSnapshot(existing.data())
  }

  const usersSnap = await getDocs(
    query(collection(db, 'users'), where('groupId', '==', gid)),
  )

  const entries = []
  for (const userDoc of usersSnap.docs) {
    const data = userDoc.data()
    const score = getScoreForDate(data, yesterday)
    if (score <= 0) continue
    const name =
      typeof data.name === 'string' && data.name.trim() ? data.name.trim() : userDoc.id
    entries.push({ userId: userDoc.id, name, score })
  }

  const ranked = assignCompetitionRanks(entries)
  const publicRankings = ranked.map(({ name, score, rank }) => ({ name, score, rank }))

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(snapRef)
    if (snap.exists()) return

    const podiumEntries = ranked.filter((r) => r.rank <= 3)
    const userRefs = podiumEntries.map((r) => doc(db, 'users', r.userId))
    const userSnaps = await Promise.all(userRefs.map((ref) => transaction.get(ref)))

    transaction.set(snapRef, {
      date: yesterday,
      rankings: publicRankings,
      createdAt: serverTimestamp(),
    })

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
  return parseRankingsFromSnapshot(after.data())
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
