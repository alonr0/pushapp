import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  collection,
  doc,
  getDoc,
  increment,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore'
import { db } from './firebase'
import {
  assignCompetitionRanks,
  buildFullGroupRankingsForDate,
  DEFAULT_PODIUMS,
  discoverGroupArchiveDates,
  filterLeaderboardHistoryDates,
  ensureYesterdayGroupSnapshot,
  formatLocalYMD,
  getYesterdayYMD,
  lastUpdatedToDate,
  parsePodiums,
  parseRankingsFromSnapshot,
  ymdToDisplayLabel,
} from './leaderboardSnapshot'
import {
  formatYesterdayShareText,
  shareStandingsImage,
  shareTextMessage,
} from './shareStandings'

const LOGO_SRC = '/logo.png'

const DEFAULT_DAILY_GOAL = 50
const USERNAME_STORAGE_KEY = 'username'
const GROUP_ID_STORAGE_KEY = 'pushapp_groupId'
const EMPTY_HISTORY = []

function readStoredSession() {
  try {
    const username = localStorage.getItem(USERNAME_STORAGE_KEY)?.trim() ?? ''
    const rawGroup = localStorage.getItem(GROUP_ID_STORAGE_KEY)?.trim() ?? ''
    const groupId = rawGroup ? normalizeGroupCode(rawGroup) : ''
    return { username, groupId }
  } catch {
    return { username: '', groupId: '' }
  }
}

function normalizeGroupCode(code) {
  return code.trim().toLowerCase()
}

function toUserDocId(displayName) {
  return displayName.trim().toLowerCase()
}

/** Per-group profile id — same display name in different groups = different documents. */
function toUserDocumentId(displayName, groupId) {
  const g = normalizeGroupCode(groupId).replace(/[/:]/g, '-')
  const n = toUserDocId(displayName).replace(/[/:]/g, '-')
  return `${g}::${n}`
}

function isSameLocalCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function getDailyGoal(data) {
  const g = Number(data?.dailyGoal)
  if (Number.isFinite(g) && g > 0) return Math.min(Math.floor(g), 99_999)
  return DEFAULT_DAILY_GOAL
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
        : count >= DEFAULT_DAILY_GOAL
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

function sortHistoryChronological(history) {
  return [...history].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

function shiftYMD(ymd, days) {
  const parts = ymd.split('-').map((x) => Number.parseInt(x, 10))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return ymd
  const [y, m, d] = parts
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0)
  dt.setDate(dt.getDate() + days)
  return formatLocalYMD(dt)
}

/** Insert 0-rep days from first log through yesterday (chart + average only). */
function fillHistoryGapsForAnalytics(history, defaultGoal) {
  const sorted = sortHistoryChronological(history)
  if (sorted.length === 0) return []

  const start = sorted[0].date
  const yesterday = getYesterdayYMD()
  const rangeEnd = yesterday >= start ? yesterday : sorted[sorted.length - 1].date
  const goal = defaultGoal > 0 ? defaultGoal : DEFAULT_DAILY_GOAL
  const byDate = new Map(sorted.map((e) => [e.date, e]))
  const out = []

  let cursor = start
  while (cursor <= rangeEnd) {
    const existing = byDate.get(cursor)
    out.push(
      existing ?? {
        date: cursor,
        count: 0,
        goalMet: false,
        goalAtDayEnd: goal,
      },
    )
    cursor = shiftYMD(cursor, 1)
  }
  return out
}

function ymdToChartLabel(ymd) {
  const parts = ymd.split('-').map((x) => Number.parseInt(x, 10))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return ymd
  const [y, m, d] = parts
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function computeDayStreaks(sortedAsc) {
  let totalGoalDays = 0
  for (const e of sortedAsc) {
    if (e.goalMet) totalGoalDays++
  }
  let currentStreak = 0
  for (let i = sortedAsc.length - 1; i >= 0; i--) {
    if (sortedAsc[i].goalMet) currentStreak++
    else break
  }
  return { currentStreak, totalGoalDays }
}

function sortDatesDesc(dates) {
  return [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
}

function enrichRankingsWithPodiums(rankings, members) {
  const byName = new Map(
    members.map((m) => [m.name.trim().toLowerCase(), m.podiums ?? DEFAULT_PODIUMS]),
  )
  return rankings.map((r) => ({
    ...r,
    podiums: byName.get(r.name.trim().toLowerCase()) ?? DEFAULT_PODIUMS,
  }))
}

/** Stored dailyCount only counts for "today" in the user's local calendar. */
function effectiveDailyCount(data) {
  const raw = Number(data?.dailyCount) || 0
  const last = lastUpdatedToDate(data?.lastUpdated)
  if (!last) return raw
  const now = new Date()
  if (!isSameLocalCalendarDay(last, now)) return 0
  return raw
}

/** Today's reps from Firestore user doc (same rules as effectiveDailyCount). */
function todayDailyFromUserDoc(data) {
  return Math.max(0, Math.floor(effectiveDailyCount(data)))
}

/** Highest reps logged on a single day (archived history + today). */
function bestDailyCountForMember(member) {
  let best = Math.max(0, Math.floor(Number(member?.today) || 0))
  for (const h of member?.history ?? []) {
    const c = Math.max(0, Math.floor(Number(h?.count) || 0))
    if (c > best) best = c
  }
  return best
}

/**
 * Archives previous calendar day when lastUpdated is not today and dailyCount > 0.
 */
async function applyLazyMidnightResetIfNeeded(userId) {
  const ref = doc(db, 'users', userId)
  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(ref)
    if (!snap.exists()) return

    const data = snap.data()
    const last = lastUpdatedToDate(data.lastUpdated)
    const now = new Date()
    if (!last || isSameLocalCalendarDay(last, now)) return

    const daily = Math.max(0, Math.floor(Number(data.dailyCount) || 0))
    const goal = getDailyGoal(data)
    const history = parseHistoryFromFirestore(data.history)
    const archivedDate = formatLocalYMD(last)

    if (daily > 0) {
      const entry = {
        date: archivedDate,
        count: daily,
        goalMet: daily >= goal,
        goalAtDayEnd: goal,
      }
      transaction.update(ref, {
        dailyCount: 0,
        history: [...history, entry],
        lastUpdated: serverTimestamp(),
      })
    } else {
      transaction.update(ref, {
        lastUpdated: serverTimestamp(),
      })
    }
  })
}

function getInitials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

const welcomeInputClass =
  'w-full rounded-2xl border border-slate-800 bg-slate-900/90 px-4 py-3.5 text-[15px] text-white placeholder:text-slate-600 transition focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/40'

const panelInputClass =
  'w-full rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-base text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30'

function WelcomeScreen({
  nameInput,
  setNameInput,
  inviteInput,
  setInviteInput,
  onJoin,
  welcomeError,
  isJoining,
}) {
  return (
    <div className="relative min-h-dvh overflow-hidden bg-slate-950 font-sans text-slate-100 antialiased">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_45%_at_50%_-15%,rgba(16,185,129,0.12),transparent_55%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-0 left-1/2 h-[42vh] w-[140%] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.06),transparent_70%)]"
        aria-hidden
      />

      <div className="relative mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-12 pt-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))]">
        <div className="mb-10">
          <div className="flex items-center gap-2.5">
            <img src={LOGO_SRC} alt="" className="h-10 w-10 shrink-0 rounded-xl object-contain" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-emerald-400/80">
              PushApp
            </p>
          </div>
          <h1 className="mt-3 text-4xl font-bold tracking-tight text-white">Join your crew</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-slate-500">
            Two taps. No passwords. Your stats sync live with the group.
          </p>
        </div>

        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            onJoin()
          }}
        >
          {welcomeError && (
            <div
              className="rounded-2xl border border-red-500/35 bg-red-950/35 px-4 py-3 text-[13px] leading-snug text-red-200/95"
              role="alert"
              aria-live="polite"
            >
              {welcomeError}
            </div>
          )}

          <div>
            <label htmlFor="welcome-name" className="mb-2 block text-xs font-medium text-slate-400">
              Your name
            </label>
            <input
              id="welcome-name"
              name="username"
              type="text"
              autoComplete="nickname"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              className={welcomeInputClass}
              placeholder="Alex"
              required
              disabled={isJoining}
            />
          </div>

          <div>
            <label htmlFor="welcome-invite" className="mb-2 block text-xs font-medium text-slate-400">
              Group invite code
            </label>
            <input
              id="welcome-invite"
              name="invite"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value)}
              className={welcomeInputClass}
              placeholder="••••••••"
              required
              disabled={isJoining}
            />
          </div>

          <button
            type="submit"
            disabled={isJoining}
            className="w-full rounded-2xl bg-emerald-500 py-4 text-[15px] font-semibold tracking-wide text-slate-950 shadow-[0_0_32px_-4px_rgba(16,185,129,0.45)] transition hover:bg-emerald-400 active:scale-[0.99] focus-visible:outline focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:pointer-events-none disabled:opacity-60"
          >
            {isJoining ? 'Joining…' : 'Join the Crew'}
          </button>
        </form>

        <p className="mt-10 text-center text-[11px] leading-relaxed text-slate-600">
          Name + group together make your profile id. Leave the group anytime from the dashboard.
        </p>
      </div>
    </div>
  )
}

const QUICK_ADD_AMOUNTS = [5, 10, 20, 50]

function progressPercent(current, goal) {
  const safeGoal = Math.max(goal, 1)
  return Math.round((current / safeGoal) * 100)
}

function ProgressRing({ current, goal }) {
  const pctLabel = progressPercent(current, goal)
  const ringFill = Math.min(pctLabel / 100, 1)
  const radius = 44
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - ringFill)
  const gradId = useId().replace(/:/g, '')

  return (
    <div className="flex flex-col items-center gap-2.5">
      <div className="relative flex h-44 w-44 shrink-0 items-center justify-center sm:h-48 sm:w-48">
        <svg className="h-full w-full -rotate-90" viewBox="0 0 100 100" aria-hidden>
          <defs>
            <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="100%" stopColor="#3b82f6" />
            </linearGradient>
          </defs>
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="7"
            className="text-slate-800/90"
          />
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke={`url(#${gradId})`}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="transition-[stroke-dashoffset] duration-500 ease-out"
          />
        </svg>
        <div
          className="absolute inset-0 flex flex-col items-center justify-center px-3 text-center"
          aria-label={`${current} of ${goal} goal, ${pctLabel} percent`}
        >
          <span className="text-4xl font-bold tabular-nums tracking-tight text-white sm:text-5xl">
            {current}
          </span>
          <span className="mt-1 text-[11px] font-medium tabular-nums text-slate-500 sm:text-xs">
            <span className="text-slate-600">/</span> {goal} <span className="text-slate-600">goal</span>
          </span>
        </div>
      </div>
      <p className="text-sm font-semibold tabular-nums text-blue-400/95">{pctLabel}%</p>
    </div>
  )
}

function EditPencilButton({ onClick, label, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-800/80 hover:text-slate-300 disabled:pointer-events-none disabled:opacity-40"
      aria-label={label}
    >
      <IconPencil className="h-3.5 w-3.5" />
    </button>
  )
}

function DashboardProgressHub({
  todayCount,
  dailyGoal,
  hydrated,
  busy,
  logError,
  logInput,
  onLogInputChange,
  onLogSubmit,
  onQuickAdd,
  onEditReps,
  onEditGoal,
}) {
  const goal = hydrated ? dailyGoal : DEFAULT_DAILY_GOAL
  const current = hydrated ? todayCount : 0
  const pctLabel = progressPercent(current, goal)
  const goalMet = hydrated && current >= goal
  const remaining = Math.max(0, goal - current)

  return (
    <section
      className={`relative overflow-hidden rounded-2xl border border-slate-800/60 bg-slate-900/40 shadow-xl shadow-slate-950/40 backdrop-blur-md ${
        !hydrated ? 'opacity-90' : ''
      } ${goalMet ? 'ring-1 ring-blue-500/30' : ''}`}
      aria-labelledby="progress-heading"
    >
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-blue-950/15 via-transparent to-slate-950/50"
        aria-hidden
      />

      <div className="relative border-b border-slate-800/60 px-5 py-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-blue-400/85">Today</p>
        <h2 id="progress-heading" className="mt-1 text-sm font-semibold tracking-tight text-slate-200">
          Daily progress
        </h2>
        <p className="mt-1 text-xs text-slate-500">Track today&apos;s reps and hit your personal goal.</p>
      </div>

      <div className="relative flex flex-col items-center gap-6 px-5 py-7">
        <ProgressRing current={current} goal={goal} />

        <div className="flex w-full max-w-xs flex-col gap-3 rounded-xl border border-slate-800/50 bg-slate-950/30 px-4 py-3 backdrop-blur-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-500">Today&apos;s reps</span>
            <span className="flex items-center gap-1.5">
              <span className="text-lg font-bold tabular-nums text-white">{hydrated ? current : '—'}</span>
              <EditPencilButton
                onClick={onEditReps}
                disabled={!hydrated || busy}
                label={`Edit today's reps, currently ${current}`}
              />
            </span>
          </div>
          <div className="h-px bg-slate-800/80" />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-500">Daily goal</span>
            <span className="flex items-center gap-1.5">
              <span className="text-lg font-bold tabular-nums text-blue-400/95">{hydrated ? goal : '—'}</span>
              <EditPencilButton
                onClick={onEditGoal}
                disabled={!hydrated || busy}
                label={`Edit daily goal, currently ${goal}`}
              />
            </span>
          </div>
        </div>

        <div className="w-full max-w-sm">
          <p className="mb-2.5 text-center text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            Quick add
          </p>
          <div className="flex flex-wrap justify-center gap-2" role="group" aria-label="Quick add pushups">
            {QUICK_ADD_AMOUNTS.map((amount) => (
              <button
                key={amount}
                type="button"
                onClick={() => onQuickAdd(amount)}
                disabled={!hydrated || busy}
                className="min-w-[3.25rem] rounded-full border border-slate-700/80 bg-slate-800/40 px-4 py-2 text-sm font-semibold tabular-nums text-slate-200 backdrop-blur-sm transition hover:border-blue-500/45 hover:bg-blue-500/10 hover:text-blue-300 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
              >
                +{amount}
              </button>
            ))}
          </div>
        </div>

        <div className="w-full max-w-sm border-t border-slate-800/60 pt-5">
          <label htmlFor="pushup-count" className="text-xs font-medium text-slate-400">
            Custom amount
          </label>
          {logError && (
            <p className="mt-2 text-xs text-red-400" role="alert">
              {logError}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <input
              id="pushup-count"
              type="number"
              inputMode="numeric"
              min={1}
              placeholder="e.g. 15"
              value={logInput}
              onChange={onLogInputChange}
              onKeyDown={(e) => e.key === 'Enter' && !busy && onLogSubmit()}
              disabled={busy || !hydrated}
              className="min-h-11 flex-1 rounded-xl border border-slate-700/80 bg-slate-950/50 px-3.5 py-2.5 text-base text-white placeholder:text-slate-600 focus:border-blue-500/60 focus:outline-none focus:ring-2 focus:ring-blue-500/25 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={onLogSubmit}
              disabled={busy || !hydrated}
              className="min-h-11 shrink-0 rounded-xl bg-emerald-500 px-5 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/25 transition hover:bg-emerald-400 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
            >
              {busy ? '…' : 'Add'}
            </button>
          </div>
        </div>

        {goalMet && (
          <div
            className="relative w-full max-w-sm overflow-hidden rounded-xl border border-emerald-400/35 bg-gradient-to-r from-emerald-500/20 via-emerald-500/10 to-emerald-600/15 px-4 py-4 text-center shadow-[0_0_28px_-8px_rgba(16,185,129,0.45)]"
            role="status"
          >
            <div
              className="pointer-events-none absolute inset-0 animate-pulse bg-gradient-to-r from-emerald-400/10 via-emerald-500/5 to-emerald-400/10"
              aria-hidden
            />
            <p className="relative text-sm font-bold uppercase tracking-[0.18em] text-emerald-300">
              Goal crushed
            </p>
            <p className="relative mt-1.5 text-xs font-medium text-emerald-400/95">
              {pctLabel}% complete — you&apos;re on fire today.
            </p>
          </div>
        )}

        {hydrated && !goalMet && (
          <p className="text-center text-xs text-slate-500">
            <span className="font-semibold tabular-nums text-blue-400/90">{remaining}</span> pushups to hit your goal
          </p>
        )}
        {!hydrated && (
          <p className="text-center text-xs text-slate-500">Loading your stats…</p>
        )}
      </div>
    </section>
  )
}

function IconPencil({ className }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125"
      />
    </svg>
  )
}

function IconCheckBadge({ className }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      />
    </svg>
  )
}

function MicroModal({ title, description, children, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/75 p-4 pt-12 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="micro-modal-title"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close dialog overlay"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-slate-800/60 bg-slate-900/90 p-5 shadow-2xl shadow-slate-950/50 backdrop-blur-md">
        <h3 id="micro-modal-title" className="text-base font-semibold text-white">
          {title}
        </h3>
        {description && <p className="mt-2 text-sm text-slate-500">{description}</p>}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  )
}

function HistoryTimeRail({ history, currentGoal }) {
  const sorted = useMemo(() => {
    return [...history].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  }, [history])

  if (sorted.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 py-14 text-center">
        <p className="text-sm text-slate-500">No completed days yet.</p>
        <p className="mt-2 text-xs text-slate-600">After midnight, yesterday rolls in here automatically.</p>
      </div>
    )
  }

  return (
    <ul className="relative space-y-0 pr-1 pl-2">
      <div className="absolute bottom-6 left-[0.6rem] top-6 w-px bg-gradient-to-b from-emerald-500/50 via-slate-700/90 to-transparent" aria-hidden />
      {sorted.map((row, i) => {
        const met =
          typeof row.goalMet === 'boolean'
            ? row.goalMet
            : row.goalAtDayEnd != null
              ? row.count >= row.goalAtDayEnd
              : row.count >= currentGoal
        return (
          <li key={`${row.date}-${i}`} className="relative flex gap-4 py-3 pl-6">
            <span
              className={`absolute left-0 top-1/2 flex h-3 w-3 -translate-y-1/2 rounded-full ring-4 ring-slate-950 ${
                met ? 'bg-emerald-400' : 'bg-slate-600'
              }`}
              aria-hidden
            />
            <div className="min-w-0 flex-1 rounded-xl border border-slate-800/90 bg-slate-800/35 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-white">{row.date}</p>
                {met ? (
                  <span className="flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-300">
                    <IconCheckBadge className="h-4 w-4" />
                    Goal
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full border border-slate-700 bg-slate-800/80 px-2.5 py-0.5 text-[11px] font-medium text-slate-500">
                    Under goal
                  </span>
                )}
              </div>
              <p className="mt-1.5 tabular-nums text-2xl font-bold tracking-tight text-slate-100">{row.count}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {row.goalAtDayEnd != null ? `Goal · ${row.goalAtDayEnd}` : `Goal · ${currentGoal}`} (reference)
              </p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function HistoryAnalyticsView({ history, totalCount, hydrated }) {
  const sortedAsc = useMemo(() => sortHistoryChronological(history), [history])

  const chartRows = useMemo(() => {
    return sortedAsc
      .map((e) => ({
        dateKey: e.date,
        label: ymdToChartLabel(e.date),
        count: e.count,
      }))
      .slice(-7)
  }, [sortedAsc])

  const stats = useMemo(() => {
    const { currentStreak, totalGoalDays } = computeDayStreaks(sortedAsc)
    const n = sortedAsc.length
    const sum = sortedAsc.reduce((s, e) => s + e.count, 0)
    const dailyAvg = n > 0 ? Math.round((sum / n) * 10) / 10 : null
    return {
      allTime: Math.max(0, Math.floor(Number(totalCount) || 0)),
      dailyAvg,
      currentStreak,
      totalGoalDays,
    }
  }, [sortedAsc, totalCount])

  if (!hydrated) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-10 text-center text-sm text-slate-500">
        Loading…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <section
        className="overflow-hidden rounded-2xl border border-slate-800/90 bg-gradient-to-br from-slate-900/90 to-slate-950/80 shadow-inner shadow-slate-950/50"
        aria-label="Personal stats"
      >
        <div className="grid grid-cols-3 divide-x divide-slate-800/90">
          <div className="min-w-0 px-2 py-3 text-center sm:px-4 sm:py-4">
            <p className="text-[9px] font-semibold uppercase leading-tight tracking-wide text-slate-500 sm:text-[10px] sm:tracking-[0.14em]">
              <span className="sm:hidden">All-time</span>
              <span className="hidden sm:inline">All-time total</span>
            </p>
            <p className="mt-1.5 text-xl font-bold tabular-nums tracking-tight text-white sm:mt-2 sm:text-3xl">
              {stats.allTime}
            </p>
          </div>
          <div className="min-w-0 px-2 py-3 text-center sm:px-4 sm:py-4">
            <p className="text-[9px] font-semibold uppercase leading-tight tracking-wide text-slate-500 sm:text-[10px] sm:tracking-[0.14em]">
              <span className="sm:hidden">Daily avg</span>
              <span className="hidden sm:inline">Daily average</span>
            </p>
            <p className="mt-1.5 text-xl font-bold tabular-nums tracking-tight text-emerald-400/95 sm:mt-2 sm:text-3xl">
              {stats.dailyAvg == null ? '—' : stats.dailyAvg}
            </p>
          </div>
          <div className="min-w-0 px-2 py-3 text-center sm:px-4 sm:py-4">
            <p className="text-[9px] font-semibold uppercase leading-tight tracking-wide text-slate-500 sm:text-[10px] sm:tracking-[0.14em]">
              <span className="sm:hidden">Streak</span>
              <span className="hidden sm:inline">Goal streak</span>
            </p>
            <p className="mt-1.5 text-xl font-bold tabular-nums tracking-tight text-blue-400/95 sm:mt-2 sm:text-3xl">
              {stats.currentStreak}
            </p>
          </div>
        </div>
        <p className="border-t border-slate-800/90 px-3 py-2 text-center text-[10px] leading-snug text-slate-600 sm:text-[11px]">
          Daily avg includes rest days (0 reps) · {stats.totalGoalDays} day
          {stats.totalGoalDays === 1 ? '' : 's'} hit goal total
        </p>
      </section>

      <div className="rounded-2xl border border-slate-800/80 bg-slate-900/50 p-4 backdrop-blur-sm sm:p-5">
        <p className="text-xs font-medium text-slate-400">Last sessions</p>
        {sortedAsc.length === 0 ? (
          <div className="mt-10 flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-950/40 py-14 text-center">
            <p className="max-w-[240px] text-sm leading-relaxed text-slate-500">
              No workouts logged yet. Smash some reps to see your graph!
            </p>
          </div>
        ) : (
          <div className="mt-4 h-[240px] w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartRows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                <defs>
                  <linearGradient id="pushAreaFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#34d399" stopOpacity={0.5} />
                    <stop offset="55%" stopColor="#3b82f6" stopOpacity={0.12} />
                    <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 6" stroke="#1e293b" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  axisLine={{ stroke: '#334155' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  tickMargin={4}
                />
                <Tooltip
                  cursor={{ stroke: '#475569', strokeWidth: 1 }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const data = payload[0]?.payload
                    if (!data) return null
                    return (
                      <div className="rounded-xl border border-slate-700/90 bg-slate-900/95 px-3.5 py-2.5 shadow-xl shadow-emerald-950/20 backdrop-blur-md">
                        <p className="text-[11px] font-medium text-slate-400">{data.label}</p>
                        <p className="mt-0.5 text-lg font-bold tabular-nums text-emerald-300">
                          {data.count} reps
                        </p>
                      </div>
                    )
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="#34d399"
                  strokeWidth={2.5}
                  fill="url(#pushAreaFill)"
                  dot={{ fill: '#10b981', stroke: '#0f172a', strokeWidth: 2, r: 4 }}
                  activeDot={{ r: 6, fill: '#34d399', stroke: '#fff', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  )
}

/** Shared with Dashboard bento icon (Heroicons 24 outline weight). */
const NAV_ICON_STROKE = {
  fill: 'none',
  viewBox: '0 0 24 24',
  strokeWidth: 1.5,
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

function NavIconSvg({ className, children }) {
  return (
    <svg className={className} aria-hidden {...NAV_ICON_STROKE}>
      {children}
    </svg>
  )
}

/** 4-tile bento / activity grid */
function NavIconDashboard({ className }) {
  return (
    <NavIconSvg className={className}>
      <path d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75A2.25 2.25 0 0115.75 18h2.25A2.25 2.25 0 0120.25 15.75v-2.25A2.25 2.25 0 0118 11.25h-2.25a2.25 2.25 0 01-2.25 2.25v2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25z" />
    </NavIconSvg>
  )
}

/** Activity ring + minimal athletic profile */
function NavIconMyStats({ className }) {
  return (
    <NavIconSvg className={className}>
      <circle cx="12" cy="12" r="7.25" />
      <circle cx="12" cy="10.5" r="2" />
      <path d="M9 16.75c.75-2 1.75-3.25 3-3.25s2.25 1.25 3 3.25" />
    </NavIconSvg>
  )
}

/** Minimal 3-tier podium (2nd · 1st · 3rd) */
function NavIconRankings({ className }) {
  return (
    <NavIconSvg className={className}>
      <path d="M4 19.25h16" />
      <path d="M6.5 19.25V13.25" />
      <path d="M11.5 19.25V8.25" />
      <path d="M16.5 19.25v-4.5" />
    </NavIconSvg>
  )
}

function LeaderboardSkeleton({ rows = 5 }) {
  return (
    <ul className="mt-4 space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <li
          key={`sk-${i}`}
          className="flex items-center justify-between rounded-xl border border-slate-800/60 bg-slate-800/20 px-3 py-2.5"
        >
          <div className="flex items-center gap-3">
            <span className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-slate-800" />
            <span className="h-4 w-28 animate-pulse rounded bg-slate-800" />
          </div>
          <span className="h-4 w-8 animate-pulse rounded bg-slate-800" />
        </li>
      ))}
    </ul>
  )
}

function PodiumBadges({ podiums }) {
  const { first, second, third } = podiums ?? DEFAULT_PODIUMS
  if (first === 0 && second === 0 && third === 0) return null
  return (
    <span className="inline-flex shrink-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-[10px] text-slate-500">
      {first > 0 && <span className="tabular-nums">🥇×{first}</span>}
      {second > 0 && <span className="tabular-nums">🥈×{second}</span>}
      {third > 0 && <span className="tabular-nums">🥉×{third}</span>}
    </span>
  )
}

/** Display name with lifetime podium counts to the right (consistent across leaderboards). */
function YourPodiumsDisplay({ podiums }) {
  const { first, second, third } = podiums ?? DEFAULT_PODIUMS
  if (first === 0 && second === 0 && third === 0) {
    return <p className="mt-4 text-center text-sm text-slate-500">No podium finishes yet.</p>
  }
  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-8 sm:gap-10">
      {first > 0 && (
        <span className="text-2xl font-bold tabular-nums tracking-tight text-yellow-300 sm:text-3xl">
          🥇 {first}
        </span>
      )}
      {second > 0 && (
        <span className="text-2xl font-bold tabular-nums tracking-tight text-zinc-200 sm:text-3xl">
          🥈 {second}
        </span>
      )}
      {third > 0 && (
        <span className="text-2xl font-bold tabular-nums tracking-tight text-amber-300 sm:text-3xl">
          🥉 {third}
        </span>
      )}
    </div>
  )
}

function yesterdayPodiumRowStyles(rank) {
  if (rank === 1) {
    return {
      row: 'border-yellow-400/55 bg-gradient-to-r from-yellow-400/28 via-amber-400/14 to-slate-900/80',
      name: 'text-yellow-50',
      score: 'text-yellow-200',
    }
  }
  if (rank === 2) {
    return {
      row: 'border-zinc-200/55 bg-gradient-to-r from-zinc-200/24 via-slate-200/12 to-slate-900/80',
      name: 'text-zinc-50',
      score: 'text-zinc-100',
    }
  }
  if (rank === 3) {
    return {
      row: 'border-amber-500/50 bg-gradient-to-r from-amber-500/22 via-yellow-600/12 to-slate-900/80',
      name: 'text-amber-50',
      score: 'text-amber-200',
    }
  }
  return {
    row: 'border-slate-800/90 bg-slate-900/60',
    name: 'text-slate-200',
    score: 'text-white',
  }
}

function NameWithPodiumBadges({ name, podiums, nameClassName = 'min-w-0 truncate font-medium text-slate-200' }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className={nameClassName}>{name}</span>
      <PodiumBadges podiums={podiums} />
    </span>
  )
}

function rankMedal(rank) {
  if (rank === 1) return '🥇'
  if (rank === 2) return '🥈'
  if (rank === 3) return '🥉'
  return ''
}

/** Top 3 medal rows + rest list + zero scorers (yesterday / all-time / today). */
function MedalStandingsList({ rankings, showBestDay = false, alltimeLosers = false, dividerClass = 'border-amber-500/15' }) {
  const top = rankings.filter((r) => r.rank <= 3)
  const restScored = rankings.filter((r) => r.rank > 3 && r.score > 0)
  const zeroScorers = rankings.filter((r) => r.score === 0 && r.rank > 3)

  return (
    <>
      <ul className="space-y-2.5">
        {top.map((row) => {
          const styles = yesterdayPodiumRowStyles(row.rank)
          return (
            <li
              key={`top-${row.name}-${row.rank}`}
              className={`flex items-center justify-between rounded-xl border px-4 py-3 ${styles.row}`}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <span className="shrink-0 text-lg" aria-hidden>
                  {rankMedal(row.rank)}
                </span>
                <NameWithPodiumBadges
                  name={row.name}
                  podiums={row.podiums}
                  nameClassName={`min-w-0 truncate font-semibold ${styles.name}`}
                />
              </span>
              <span className="shrink-0 text-right">
                <span className={`block tabular-nums text-lg font-bold ${styles.score}`}>{row.score}</span>
                {showBestDay && row.bestDay > 0 && (
                  <span className="mt-0.5 block text-[11px] tabular-nums text-slate-500">
                    best day {row.bestDay}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>

      {restScored.length > 0 && (
        <>
          <div className={`my-4 border-t ${dividerClass}`} />
          <ul className="space-y-2">
            {restScored.map((row) => (
              <li
                key={`rest-${row.name}-${row.rank}`}
                className="flex items-center justify-between rounded-xl border border-slate-800/90 bg-slate-900/50 px-3 py-2.5"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-xs font-bold text-slate-400">
                    {row.rank}
                  </span>
                  <NameWithPodiumBadges name={row.name} podiums={row.podiums} />
                </div>
                <span className="shrink-0 text-right">
                  <span className="block tabular-nums text-sm font-semibold text-white">{row.score}</span>
                  {showBestDay && row.bestDay > 0 && (
                    <span className="mt-0.5 block text-[10px] tabular-nums text-slate-500">
                      best {row.bestDay}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {zeroScorers.length > 0 && (
        <>
          <div className={`my-4 border-t ${alltimeLosers ? 'border-red-500/20' : dividerClass}`} />
          <p
            className={`mb-3 text-center text-[10px] font-semibold uppercase tracking-[0.18em] ${
              alltimeLosers ? 'text-red-400/95' : 'text-slate-500'
            }`}
          >
            {alltimeLosers ? 'All-time losers' : 'LOSERS:'}
          </p>
          <ul className="space-y-2">
            {zeroScorers.map((row) => (
              <li
                key={`zero-${row.name}-${row.rank}`}
                className={
                  alltimeLosers
                    ? 'flex items-center justify-between rounded-xl border border-red-500/40 bg-gradient-to-r from-red-950/45 to-slate-900/80 px-4 py-3'
                    : 'flex items-center justify-between rounded-xl border border-slate-800/90 bg-slate-900/50 px-3 py-2.5'
                }
              >
                {alltimeLosers ? (
                  <>
                    <span className="flex min-w-0 flex-1 items-center gap-2.5">
                      <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-red-500/35 bg-red-950/60 text-base font-bold tabular-nums text-red-400"
                        aria-hidden
                      >
                        {row.rank}
                      </span>
                      <NameWithPodiumBadges
                        name={row.name}
                        podiums={row.podiums}
                        nameClassName="min-w-0 truncate font-semibold text-red-200"
                      />
                    </span>
                    <span className="shrink-0 tabular-nums text-lg font-bold text-red-400">0</span>
                  </>
                ) : (
                  <>
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-xs font-bold text-slate-400">
                        {row.rank}
                      </span>
                      <NameWithPodiumBadges name={row.name} podiums={row.podiums} />
                    </div>
                    <span className="shrink-0 tabular-nums text-sm font-semibold text-slate-500">0</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

function AllTimeTotalPodiumCard({ rankings, groupName, hydrated }) {
  if (!hydrated) {
    return (
      <div className="animate-pulse rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
        <div className="h-4 w-40 rounded bg-slate-800" />
      </div>
    )
  }

  if (rankings.length === 0) {
    return (
      <section className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-6 text-center">
        <p className="text-sm text-slate-500">No crew members yet.</p>
      </section>
    )
  }

  return (
    <section
      className="overflow-hidden rounded-2xl border border-violet-500/25 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 p-5 shadow-[0_0_40px_-12px_rgba(139,92,246,0.22)]"
      aria-label="All-time rankings"
    >
      <div className="text-center">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-violet-400/90">
          All-time rankings
        </p>
        <p className="mt-1 text-xs text-slate-500">Lifetime standings in the crew</p>
        {groupName && (
          <p className="mt-0.5 truncate text-sm font-semibold text-emerald-400/95">{groupName}</p>
        )}
      </div>
      <div className="mt-5">
        <MedalStandingsList rankings={rankings} showBestDay alltimeLosers dividerClass="border-violet-500/15" />
      </div>
    </section>
  )
}

function ShareIcon({ className }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.935-2.186 2.25 2.25 0 00-3.935 2.186z"
      />
    </svg>
  )
}

function YesterdayStandingsCard({ rankings, groupName, dateYMD, hydrated }) {
  const dateLabel = ymdToDisplayLabel(dateYMD)
  const captureRef = useRef(null)
  const [shareBusy, setShareBusy] = useState(null)
  const [shareFeedback, setShareFeedback] = useState('')

  const handleShareText = async () => {
    setShareBusy('text')
    setShareFeedback('')
    try {
      const text = formatYesterdayShareText({ rankings, groupName, dateLabel })
      const result = await shareTextMessage(text)
      if (result.method === 'cancelled') return
      if (result.method === 'whatsapp_clipboard') {
        setShareFeedback('WhatsApp opened — message copied to clipboard too.')
      } else if (result.method === 'whatsapp') {
        setShareFeedback('WhatsApp opened with your standings.')
      } else {
        setShareFeedback('Shared.')
      }
    } catch (e) {
      console.error(e)
      setShareFeedback('Could not share text. Try again.')
    } finally {
      setShareBusy(null)
    }
  }

  const handleShareImage = async () => {
    setShareBusy('image')
    setShareFeedback('')
    try {
      const safeDate = dateYMD || 'standings'
      const result = await shareStandingsImage(captureRef.current, `pushapp-${safeDate}.png`)
      if (result.method === 'cancelled') return
      if (result.method === 'download') {
        setShareFeedback('Image saved — attach it in WhatsApp (or use Share again on mobile).')
      } else {
        setShareFeedback('Image shared.')
      }
    } catch (e) {
      console.error(e)
      setShareFeedback('Could not create image. Try text share.')
    } finally {
      setShareBusy(null)
    }
  }

  if (!hydrated) {
    return (
      <div className="animate-pulse rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
        <div className="h-4 w-32 rounded bg-slate-800" />
      </div>
    )
  }

  if (rankings.length === 0) {
    return (
      <section className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-6 text-center">
        <p className="text-sm text-slate-500">No results for yesterday yet.</p>
      </section>
    )
  }

  const shareBtnClass =
    'inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-amber-500/40 hover:bg-slate-800 disabled:opacity-50'

  return (
    <section
      className="overflow-hidden rounded-2xl border border-amber-500/25 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 shadow-[0_0_40px_-12px_rgba(251,191,36,0.25)]"
      aria-label="Yesterday results"
    >
      <div ref={captureRef} className="bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 p-5">
        <div className="text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-400/90">
            Yesterday results
          </p>
          <p className="mt-1 text-xs text-slate-500">{dateLabel}</p>
          {groupName && (
            <p className="mt-0.5 truncate text-sm font-semibold text-emerald-400/95">{groupName}</p>
          )}
        </div>
        <div className="mt-5">
          <MedalStandingsList rankings={rankings} />
        </div>
      </div>

      <div className="border-t border-amber-500/15 bg-slate-950/80 px-4 py-3">
        <p className="mb-2 text-center text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Share
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className={shareBtnClass}
            disabled={Boolean(shareBusy)}
            onClick={handleShareText}
          >
            <ShareIcon className="h-4 w-4 shrink-0 text-amber-400/90" />
            {shareBusy === 'text' ? '…' : 'Text'}
          </button>
          <button
            type="button"
            className={shareBtnClass}
            disabled={Boolean(shareBusy)}
            onClick={handleShareImage}
          >
            <ShareIcon className="h-4 w-4 shrink-0 text-amber-400/90" />
            {shareBusy === 'image' ? '…' : 'Image'}
          </button>
        </div>
        {shareFeedback ? (
          <p className="mt-2 text-center text-[11px] leading-snug text-slate-500">{shareFeedback}</p>
        ) : (
          <p className="mt-2 text-center text-[10px] text-slate-600">
            Text opens WhatsApp with the list. Image uses your phone&apos;s share sheet when available.
          </p>
        )}
      </div>
    </section>
  )
}

function GroupHistoryLeaderboardPanel({
  dates,
  selectedDate,
  onSelectDate,
  rankings,
  groupName,
  hydrated,
  loading = false,
}) {
  if (!hydrated) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 text-center text-sm text-slate-500">
        Loading group history…
      </div>
    )
  }

  if (dates.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-6 text-center text-sm text-slate-500">
        No leaderboard history yet (from two or more days ago).
      </div>
    )
  }

  return (
    <section className="rounded-2xl border border-slate-800/80 bg-slate-900/50 p-4 backdrop-blur-sm sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="text-sm font-medium text-slate-300">Leaderboard history</h3>
          <p className="mt-1 text-xs text-slate-500">
            Daily results from two or more days ago for {groupName || 'your crew'}.
          </p>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-slate-500">Date</span>
          <select
            value={selectedDate && dates.includes(selectedDate) ? selectedDate : (dates[0] ?? '')}
            onChange={(e) => onSelectDate(e.target.value)}
            disabled={loading}
            className="relative z-10 rounded-xl border border-slate-700 bg-slate-800/90 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 disabled:opacity-60"
          >
            {dates.map((d) => (
              <option key={d} value={d}>
                {ymdToDisplayLabel(d)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading ? (
        <div className="mt-4">
          <LeaderboardSkeleton rows={5} />
        </div>
      ) : rankings.length === 0 ? (
        <p className="mt-6 text-center text-sm text-slate-500">No scores that day.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-800/30">
          {rankings.map((row) => (
            <li key={`${selectedDate}-${row.name}-${row.rank}`} className="flex items-center justify-between px-4 py-3">
              <span className="flex min-w-0 items-center gap-3 text-sm">
                <span className="w-6 shrink-0 tabular-nums text-slate-500">{row.rank}.</span>
                <NameWithPodiumBadges name={row.name} podiums={row.podiums} />
              </span>
              <span className="shrink-0 tabular-nums text-sm font-semibold text-blue-400">{row.score}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const NAV = [
  { id: 'dashboard', label: 'Dashboard', Icon: NavIconDashboard },
  { id: 'stats', label: 'My stats', Icon: NavIconMyStats },
  { id: 'leaderboard', label: 'Leaderboard', Icon: NavIconRankings },
]

async function ensureUserDocument(displayName, groupIdNorm) {
  const name = displayName.trim()
  const gid = groupIdNorm ? normalizeGroupCode(groupIdNorm) : ''
  if (!gid) throw new Error('Missing groupId')

  const userId = toUserDocumentId(name, gid)
  const ref = doc(db, 'users', userId)
  const snap = await getDoc(ref)
  if (!snap.exists()) {
    await setDoc(ref, {
      name,
      groupId: gid,
      dailyCount: 0,
      totalCount: 0,
      dailyGoal: DEFAULT_DAILY_GOAL,
      history: [],
      podiums: { ...DEFAULT_PODIUMS },
      lastUpdated: serverTimestamp(),
    })
  } else {
    const d = snap.data()
    const patch = {}
    if (d.dailyGoal === undefined || d.dailyGoal === null) patch.dailyGoal = DEFAULT_DAILY_GOAL
    if (!Array.isArray(d.history)) patch.history = []
    if (!d.podiums || typeof d.podiums !== 'object') patch.podiums = { ...DEFAULT_PODIUMS }
    if (d.groupId !== gid) patch.groupId = gid
    if (Object.keys(patch).length > 0) {
      await updateDoc(ref, patch)
    }
  }
}

function App() {
  const initialSession = readStoredSession()
  const [username, setUsername] = useState(initialSession.username)
  const [groupId, setGroupId] = useState(initialSession.groupId)
  const [groupDisplayName, setGroupDisplayName] = useState('')
  const [isAuthenticated, setIsAuthenticated] = useState(
    Boolean(initialSession.username && initialSession.groupId),
  )

  const [welcomeName, setWelcomeName] = useState('')
  const [welcomeInvite, setWelcomeInvite] = useState('')
  const [welcomeError, setWelcomeError] = useState('')
  const [isJoining, setIsJoining] = useState(false)

  const [logInput, setLogInput] = useState('')
  const [activeTab, setActiveTab] = useState('dashboard')
  const [isLoggingPushups, setIsLoggingPushups] = useState(false)
  const [logError, setLogError] = useState('')

  const [leaderboardRows, setLeaderboardRows] = useState([])
  const [leaderboardHydrated, setLeaderboardHydrated] = useState(false)
  const [syncError, setSyncError] = useState('')

  const [goalModalOpen, setGoalModalOpen] = useState(false)
  const [goalDraft, setGoalDraft] = useState(String(DEFAULT_DAILY_GOAL))
  const [goalSaving, setGoalSaving] = useState(false)

  const [fixModalOpen, setFixModalOpen] = useState(false)
  const [fixDraft, setFixDraft] = useState('0')
  const [fixSaving, setFixSaving] = useState(false)

  const yesterdayYMD = useMemo(() => getYesterdayYMD(), [])
  const [groupLeaderboardDates, setGroupLeaderboardDates] = useState([])
  const [selectedGroupHistoryDate, setSelectedGroupHistoryDate] = useState('')
  const [selectedGroupRankings, setSelectedGroupRankings] = useState([])
  const [groupRankingsLoadedForDate, setGroupRankingsLoadedForDate] = useState('')
  const [yesterdayRankings, setYesterdayRankings] = useState([])
  const [groupHistoryHydrated, setGroupHistoryHydrated] = useState(false)

  const userDocId = username.trim() && groupId ? toUserDocumentId(username, groupId) : ''

  const rankedFriends = useMemo(() => {
    return [...leaderboardRows].sort(
      (a, b) => b.today - a.today || String(a.name).localeCompare(String(b.name)),
    )
  }, [leaderboardRows])

  const displayTodayRankings = useMemo(() => {
    const entries = leaderboardRows.map((m) => ({
      name: m.name,
      score: m.today ?? 0,
      podiums: m.podiums ?? DEFAULT_PODIUMS,
      isYou: m.isYou,
    }))
    return assignCompetitionRanks(entries)
  }, [leaderboardRows])

  const discoveredArchiveDates = useMemo(
    () => discoverGroupArchiveDates(groupLeaderboardDates, leaderboardRows),
    [groupLeaderboardDates, leaderboardRows],
  )

  const historyPickerDates = useMemo(
    () => filterLeaderboardHistoryDates(sortDatesDesc(discoveredArchiveDates), yesterdayYMD),
    [discoveredArchiveDates, yesterdayYMD],
  )

  const activeGroupHistoryDate = useMemo(() => {
    if (selectedGroupHistoryDate && historyPickerDates.includes(selectedGroupHistoryDate)) {
      return selectedGroupHistoryDate
    }
    return historyPickerDates[0] ?? ''
  }, [selectedGroupHistoryDate, historyPickerDates])

  const displayYesterdayRankings = useMemo(() => {
    const rows = buildFullGroupRankingsForDate(leaderboardRows, yesterdayYMD, yesterdayRankings)
    return enrichRankingsWithPodiums(rows, leaderboardRows)
  }, [yesterdayRankings, leaderboardRows, yesterdayYMD])

  const allTimeTotalRankings = useMemo(() => {
    const entries = leaderboardRows.map((m) => ({
      name: m.name,
      score: m.totalCount ?? 0,
      bestDay: bestDailyCountForMember(m),
      podiums: m.podiums ?? DEFAULT_PODIUMS,
    }))
    return assignCompetitionRanks(entries)
  }, [leaderboardRows])

  const historyRankingsLoading =
    Boolean(activeGroupHistoryDate) &&
    groupLeaderboardDates.includes(activeGroupHistoryDate) &&
    groupRankingsLoadedForDate !== activeGroupHistoryDate

  const displaySelectedGroupRankings = useMemo(() => {
    const date = activeGroupHistoryDate
    if (!date) return []

    const snapshot =
      groupLeaderboardDates.includes(date) && groupRankingsLoadedForDate === date
        ? selectedGroupRankings
        : []
    const rows = buildFullGroupRankingsForDate(leaderboardRows, date, snapshot)

    return enrichRankingsWithPodiums(rows, leaderboardRows)
  }, [
    activeGroupHistoryDate,
    groupRankingsLoadedForDate,
    selectedGroupRankings,
    leaderboardRows,
    groupLeaderboardDates,
  ])

  const myRow = useMemo(() => rankedFriends.find((r) => r.isYou), [rankedFriends])

  const myPodiums = myRow?.podiums ?? DEFAULT_PODIUMS

  const myHistory = useMemo(
    () => (Array.isArray(myRow?.history) ? myRow.history : EMPTY_HISTORY),
    [myRow],
  )

  const todayCount = myRow?.today ?? 0
  const myDailyGoal = myRow?.dailyGoal ?? DEFAULT_DAILY_GOAL
  const myTotalCount = myRow?.totalCount ?? 0

  const myHistoryForAnalytics = useMemo(
    () => fillHistoryGapsForAnalytics(myHistory, myDailyGoal),
    [myHistory, myDailyGoal],
  )

  useEffect(() => {
    if (!isAuthenticated || !username.trim() || !groupId) return undefined

    let alive = true
    ;(async () => {
      try {
        await ensureUserDocument(username, groupId)
      } catch (e) {
        console.error(e)
        if (alive) setSyncError('Could not sync your profile. Check Firestore rules.')
      }
    })()

    return () => {
      alive = false
    }
  }, [isAuthenticated, username, groupId])

  useEffect(() => {
    if (!isAuthenticated || !userDocId || !groupId) return undefined

    let cancelled = false
    ;(async () => {
      try {
        await applyLazyMidnightResetIfNeeded(userDocId)
        await ensureYesterdayGroupSnapshot(groupId)
      } catch (e) {
        console.error(e)
        if (!cancelled) {
          setSyncError('Could not apply day rollover or sync standings. Check Firestore rules.')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isAuthenticated, userDocId, groupId, activeTab])

  /** Re-sync yesterday snapshot when any crew member's history changes (late resets, retro edits). */
  useEffect(() => {
    if (!isAuthenticated || !groupId || !leaderboardHydrated) return undefined

    const timer = setTimeout(async () => {
      try {
        await ensureYesterdayGroupSnapshot(groupId)
      } catch (e) {
        console.error(e)
      }
    }, 400)

    return () => clearTimeout(timer)
  }, [isAuthenticated, groupId, leaderboardHydrated, leaderboardRows, yesterdayYMD])

  useEffect(() => {
    if (!isAuthenticated || !groupId) return undefined

    const gRef = doc(db, 'groups', groupId)
    const unsub = onSnapshot(
      gRef,
      (snap) => {
        const raw = snap.data()?.groupName
        const label = typeof raw === 'string' && raw.trim() ? raw.trim() : groupId
        setGroupDisplayName(label)
      },
      (err) => {
        console.error(err)
        setGroupDisplayName(groupId)
      },
    )

    return () => unsub()
  }, [isAuthenticated, groupId])

  useEffect(() => {
    if (!isAuthenticated || !userDocId || !groupId) return undefined

    const usersQuery = query(collection(db, 'users'), where('groupId', '==', groupId))
    const unsub = onSnapshot(
      usersQuery,
      (snapshot) => {
        const next = snapshot.docs.map((d) => {
          const data = d.data()
          return {
            id: d.id,
            name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : d.id,
            today: effectiveDailyCount(data),
            isYou: d.id === userDocId,
            dailyGoal: getDailyGoal(data),
            history: parseHistoryFromFirestore(data.history),
            lastUpdated: data.lastUpdated ?? null,
            totalCount: Math.max(0, Math.floor(Number(data.totalCount) || 0)),
            podiums: parsePodiums(data),
          }
        })
        setLeaderboardRows(next)
        setLeaderboardHydrated(true)
        setSyncError('')
      },
      (err) => {
        console.error(err)
        setSyncError('Live sync lost. Refresh or check your connection and Firestore rules.')
        setLeaderboardHydrated(true)
      },
    )

    return () => unsub()
  }, [isAuthenticated, userDocId, groupId])

  useEffect(() => {
    if (!isAuthenticated || !groupId) return undefined

    const col = collection(db, 'groups', groupId, 'dailyLeaderboards')
    const unsub = onSnapshot(
      col,
      (snapshot) => {
        const dates = snapshot.docs.map((d) => d.id)
        setGroupLeaderboardDates(dates)
        setGroupHistoryHydrated(true)
        setSelectedGroupHistoryDate((prev) => {
          const merged = filterLeaderboardHistoryDates(sortDatesDesc(dates), yesterdayYMD)
          if (prev && merged.includes(prev)) return prev
          return merged[0] ?? ''
        })
      },
      (err) => {
        console.error(err)
        setSyncError(
          'Could not load group history dates. Check Firestore rules for dailyLeaderboards.',
        )
        setGroupHistoryHydrated(true)
      },
    )

    return () => unsub()
  }, [isAuthenticated, groupId, yesterdayYMD])

  useEffect(() => {
    if (!isAuthenticated || !groupId) return undefined

    const yRef = doc(db, 'groups', groupId, 'dailyLeaderboards', yesterdayYMD)
    const unsub = onSnapshot(
      yRef,
      (snap) => {
        setYesterdayRankings(snap.exists() ? parseRankingsFromSnapshot(snap.data()) : [])
      },
      (err) => {
        console.error(err)
        setYesterdayRankings([])
      },
    )

    return () => unsub()
  }, [isAuthenticated, groupId, yesterdayYMD])

  useEffect(() => {
    if (
      !isAuthenticated ||
      !groupId ||
      !activeGroupHistoryDate ||
      !historyPickerDates.includes(activeGroupHistoryDate)
    ) {
      return undefined
    }

    const dateAtSubscribe = activeGroupHistoryDate
    if (!groupLeaderboardDates.includes(dateAtSubscribe)) {
      return undefined
    }

    const dRef = doc(db, 'groups', groupId, 'dailyLeaderboards', dateAtSubscribe)
    const unsub = onSnapshot(
      dRef,
      (snap) => {
        const parsed = snap.exists() ? parseRankingsFromSnapshot(snap.data()) : []
        setSelectedGroupRankings(parsed)
        setGroupRankingsLoadedForDate(dateAtSubscribe)
      },
      (err) => {
        console.error(err)
        setSelectedGroupRankings([])
        setGroupRankingsLoadedForDate(dateAtSubscribe)
      },
    )

    return () => unsub()
  }, [isAuthenticated, groupId, activeGroupHistoryDate, historyPickerDates, groupLeaderboardDates])

  const handleJoinCrew = async () => {
    setWelcomeError('')
    const name = welcomeName.trim()
    const rawCode = welcomeInvite.trim()
    if (!name || !rawCode) return

    const normalizedGroupId = normalizeGroupCode(rawCode)

    setIsJoining(true)
    try {
      const groupRef = doc(db, 'groups', normalizedGroupId)
      const groupSnap = await getDoc(groupRef)
      if (!groupSnap.exists()) {
        setWelcomeError('Group code not found. Ask the developer for a valid key!')
        return
      }

      const groupNameRaw = groupSnap.data()?.groupName
      const squadLabel =
        typeof groupNameRaw === 'string' && groupNameRaw.trim()
          ? groupNameRaw.trim()
          : normalizedGroupId
      setGroupDisplayName(squadLabel)

      const userId = toUserDocumentId(name, normalizedGroupId)
      const ref = doc(db, 'users', userId)
      const snap = await getDoc(ref)
      if (!snap.exists()) {
        await setDoc(ref, {
          name,
          groupId: normalizedGroupId,
          dailyCount: 0,
          totalCount: 0,
          dailyGoal: DEFAULT_DAILY_GOAL,
          history: [],
          podiums: { ...DEFAULT_PODIUMS },
          lastUpdated: serverTimestamp(),
        })
      } else {
        await updateDoc(ref, { groupId: normalizedGroupId, name })
      }

      try {
        localStorage.setItem(USERNAME_STORAGE_KEY, name)
        localStorage.setItem(GROUP_ID_STORAGE_KEY, normalizedGroupId)
      } catch {
        setWelcomeError('Could not save on this device. Check browser storage settings.')
        return
      }

      setGroupId(normalizedGroupId)
      setUsername(name)
      setIsAuthenticated(true)
      setWelcomeName('')
      setWelcomeInvite('')
    } catch (e) {
      console.error(e)
      setWelcomeError('Could not reach Firestore. Check rules, network, and config.')
    } finally {
      setIsJoining(false)
    }
  }

  const handleLeaveGroup = () => {
    try {
      localStorage.removeItem(USERNAME_STORAGE_KEY)
      localStorage.removeItem(GROUP_ID_STORAGE_KEY)
    } catch {
      /* ignore */
    }
    setUsername('')
    setGroupId('')
    setGroupDisplayName('')
    setIsAuthenticated(false)
    setActiveTab('dashboard')
    setWelcomeName('')
    setWelcomeInvite('')
    setWelcomeError('')
    setLeaderboardRows([])
    setLeaderboardHydrated(false)
    setGroupLeaderboardDates([])
    setSelectedGroupHistoryDate('')
    setSelectedGroupRankings([])
    setGroupRankingsLoadedForDate('')
    setYesterdayRankings([])
    setGroupHistoryHydrated(false)
    setSyncError('')
    setGoalModalOpen(false)
    setFixModalOpen(false)
  }

  const saveDailyGoal = async () => {
    const n = Number.parseInt(goalDraft, 10)
    if (!Number.isFinite(n) || n < 1 || n > 99_999 || !userDocId) return
    setGoalSaving(true)
    try {
      await updateDoc(doc(db, 'users', userDocId), { dailyGoal: n })
      setGoalModalOpen(false)
    } catch (e) {
      console.error(e)
    } finally {
      setGoalSaving(false)
    }
  }

  const applyPushupDelta = async (n, { clearLogInput = false } = {}) => {
    if (!Number.isFinite(n) || n <= 0 || !userDocId) return

    setLogError('')
    setIsLoggingPushups(true)
    const ref = doc(db, 'users', userDocId)

    try {
      await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(ref)
        if (!snap.exists()) throw new Error('User document missing')
        const data = snap.data()
        const daily = todayDailyFromUserDoc(data)
        transaction.update(ref, {
          dailyCount: daily + n,
          totalCount: increment(n),
          lastUpdated: serverTimestamp(),
        })
      })
      if (clearLogInput) setLogInput('')
    } catch (e) {
      console.error(e)
      setLogError('Update failed. Try again.')
    } finally {
      setIsLoggingPushups(false)
    }
  }

  const saveFixedDaily = async () => {
    const newDaily = Number.parseInt(fixDraft, 10)
    if (!Number.isFinite(newDaily) || newDaily < 0 || !userDocId) return

    setFixSaving(true)
    const ref = doc(db, 'users', userDocId)
    try {
      await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(ref)
        if (!snap.exists()) throw new Error('User document missing')
        const data = snap.data()
        const currentDaily = todayDailyFromUserDoc(data)
        const delta = newDaily - currentDaily
        transaction.update(ref, {
          dailyCount: newDaily,
          totalCount: Math.max(0, Math.floor(Number(data.totalCount) || 0) + delta),
          lastUpdated: serverTimestamp(),
        })
      })
      setFixModalOpen(false)
    } catch (e) {
      console.error(e)
      setLogError('Could not update count. Try again.')
    } finally {
      setFixSaving(false)
    }
  }

  const logPushups = async () => {
    const n = Number.parseInt(logInput, 10)
    await applyPushupDelta(n, { clearLogInput: true })
  }

  const quickAddPushups = async (amount) => {
    await applyPushupDelta(amount)
  }

  if (!isAuthenticated) {
    return (
      <WelcomeScreen
        nameInput={welcomeName}
        setNameInput={(v) => {
          setWelcomeName(v)
          setWelcomeError('')
        }}
        inviteInput={welcomeInvite}
        setInviteInput={(v) => {
          setWelcomeInvite(v)
          setWelcomeError('')
        }}
        onJoin={handleJoinCrew}
        welcomeError={welcomeError}
        isJoining={isJoining}
      />
    )
  }

  return (
    <div className="min-h-dvh bg-slate-950 font-sans text-slate-100 antialiased">
      <div className="mx-auto flex min-h-dvh max-w-lg flex-col">
        {syncError && (
          <div
            className="mx-4 mt-3 rounded-xl border border-amber-500/35 bg-amber-950/40 px-3 py-2 text-center text-[12px] text-amber-100/95"
            role="status"
          >
            {syncError}
          </div>
        )}

        <header className="flex shrink-0 items-start justify-between gap-3 px-4 pb-2 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight text-white">
              <img src={LOGO_SRC} alt="" className="h-9 w-9 shrink-0 rounded-lg object-contain" />
              PushApp
            </h1>
            <p className="mt-0.5 truncate text-sm font-medium text-emerald-400/95">{username}</p>
            <p className="truncate text-xs font-semibold tracking-tight text-blue-400/90">
              {groupDisplayName || '\u00A0'}
            </p>
            <p className="text-xs text-slate-500">
              {activeTab === 'stats'
                ? 'Your data · history & podiums'
                : activeTab === 'leaderboard'
                  ? 'Standings & podiums'
                  : 'Today · live with your crew'}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button
              type="button"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-xs font-semibold text-emerald-400 ring-emerald-500/30 transition hover:border-slate-600 hover:bg-slate-800 focus-visible:outline focus-visible:ring-2 focus-visible:ring-emerald-500"
              aria-label={`Profile · ${username}`}
            >
              {getInitials(username)}
            </button>
            <button
              type="button"
              onClick={handleLeaveGroup}
              className="rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-slate-600 hover:bg-slate-800 hover:text-white focus-visible:outline focus-visible:ring-2 focus-visible:ring-emerald-500/50"
            >
              Leave Group
            </button>
          </div>
        </header>

        <main className="flex-1 space-y-5 overflow-y-auto px-4 pb-28">
          {activeTab === 'dashboard' && (
            <>
              <DashboardProgressHub
                todayCount={todayCount}
                dailyGoal={myDailyGoal}
                hydrated={leaderboardHydrated}
                busy={isLoggingPushups}
                logError={logError}
                logInput={logInput}
                onLogInputChange={(e) => setLogInput(e.target.value)}
                onLogSubmit={logPushups}
                onQuickAdd={quickAddPushups}
                onEditReps={() => {
                  setFixDraft(String(todayCount))
                  setFixModalOpen(true)
                }}
                onEditGoal={() => {
                  setGoalDraft(String(myDailyGoal))
                  setGoalModalOpen(true)
                }}
              />

              <section
                className="relative overflow-hidden rounded-2xl border border-slate-800/60 bg-slate-900/40 p-5 shadow-xl shadow-slate-950/40 backdrop-blur-md"
                aria-labelledby="friends-heading"
              >
                <div
                  className="pointer-events-none absolute inset-0 bg-gradient-to-b from-blue-950/15 via-transparent to-slate-950/50"
                  aria-hidden
                />
                <div className="relative">
                  <h2 id="friends-heading" className="text-sm font-medium text-slate-300">
                    Today <span className="text-red-500">·</span>{' '}
                    <span className="text-red-500">Live</span>
                  </h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Ranked by today&apos;s reps — updates as the crew logs.
                  </p>
                  {!leaderboardHydrated && <LeaderboardSkeleton />}
                  {leaderboardHydrated && displayTodayRankings.length === 0 && (
                    <p className="mt-6 text-center text-sm text-slate-500">No one here yet. Invite friends.</p>
                  )}
                  {leaderboardHydrated && displayTodayRankings.length > 0 && (
                    <div className="mt-4">
                      <MedalStandingsList rankings={displayTodayRankings} dividerClass="border-slate-800/60" />
                    </div>
                  )}
                </div>
              </section>
            </>
          )}

          {activeTab === 'stats' && (
            <div className="space-y-4">
              <section className="rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 via-slate-950/80 to-slate-950 p-5 backdrop-blur-sm">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-500/85">
                  My stats
                </p>
                <h2 className="mt-2 text-2xl font-bold tracking-tight text-white">Your progress</h2>
                <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
                  Personal totals, history, and group podium finishes.
                </p>
              </section>

              <section className="rounded-2xl border border-slate-800/80 bg-slate-900/50 p-4 backdrop-blur-sm sm:p-5">
                <h2 className="text-sm font-medium text-slate-300">Your podiums</h2>
                <p className="mt-1 text-xs text-slate-500">1st · 2nd · 3rd place finishes in the group.</p>
                <YourPodiumsDisplay podiums={myPodiums} />
              </section>

              <HistoryAnalyticsView
                history={myHistoryForAnalytics}
                totalCount={myTotalCount}
                hydrated={leaderboardHydrated}
              />

              {leaderboardHydrated && (
                <section className="rounded-2xl border border-slate-800/80 bg-slate-900/50 p-4 backdrop-blur-sm sm:p-5">
                  <h3 className="mb-1 text-sm font-medium text-slate-300">By day</h3>
                  <p className="mb-4 text-xs text-slate-500">Raw totals and goal badges.</p>
                  <HistoryTimeRail history={myHistory} currentGoal={myDailyGoal} />
                </section>
              )}
            </div>
          )}

          {activeTab === 'leaderboard' && (
            <div className="space-y-4">
              <section className="rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 via-slate-950/80 to-slate-950 p-5 backdrop-blur-sm">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-400/85">
                  Crew rankings
                </p>
                <h2 className="mt-2 text-2xl font-bold tracking-tight text-white">Leaderboard</h2>
                <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
                  Yesterday&apos;s results, all-time rankings, and past days.
                </p>
              </section>

              <YesterdayStandingsCard
                rankings={displayYesterdayRankings}
                groupName={groupDisplayName}
                dateYMD={yesterdayYMD}
                hydrated={groupHistoryHydrated}
              />

              <AllTimeTotalPodiumCard
                rankings={allTimeTotalRankings}
                groupName={groupDisplayName}
                hydrated={leaderboardHydrated}
              />

              <GroupHistoryLeaderboardPanel
                dates={historyPickerDates}
                selectedDate={activeGroupHistoryDate}
                onSelectDate={setSelectedGroupHistoryDate}
                rankings={displaySelectedGroupRankings}
                groupName={groupDisplayName}
                hydrated={groupHistoryHydrated}
                loading={historyRankingsLoading}
              />
            </div>
          )}
        </main>

        <nav
          className="fixed bottom-0 left-0 right-0 z-10 border-t border-slate-800/90 bg-slate-950/90 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-md"
          aria-label="Primary"
        >
          <div className="mx-auto grid max-w-lg grid-cols-3 gap-1">
            {NAV.map(({ id, label, Icon }) => {
              const active = activeTab === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex flex-col items-center justify-center gap-0.5 rounded-xl py-2 text-xs font-medium transition-colors duration-200 ${
                    active ? 'text-emerald-400' : 'text-slate-500 hover:text-slate-400'
                  }`}
                >
                  <span className="flex h-6 w-6 items-center justify-center">
                    <Icon
                      className={`h-6 w-6 shrink-0 transition-colors duration-200 ${
                        active ? 'text-emerald-400' : 'text-current'
                      }`}
                    />
                  </span>
                  <span className="leading-tight">{label}</span>
                </button>
              )
            })}
          </div>
        </nav>
      </div>

      {goalModalOpen && (
        <MicroModal
          title="Daily goal"
          description="Set how many pushups you want to hit each day."
          onClose={() => !goalSaving && setGoalModalOpen(false)}
        >
          <label htmlFor="goal-input" className="sr-only">
            Daily goal
          </label>
          <input
            id="goal-input"
            type="number"
            inputMode="numeric"
            min={1}
            value={goalDraft}
            onChange={(e) => setGoalDraft(e.target.value)}
            className={panelInputClass}
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setGoalModalOpen(false)}
              disabled={goalSaving}
              className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveDailyGoal}
              disabled={goalSaving}
              className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-400 disabled:opacity-50"
            >
              {goalSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </MicroModal>
      )}

      {fixModalOpen && (
        <MicroModal
          title="Today's reps"
          description="Fix a logging mistake. Your all-time total adjusts by the same amount automatically."
          onClose={() => !fixSaving && setFixModalOpen(false)}
        >
          <label htmlFor="fix-input" className="sr-only">
            Today count
          </label>
          <input
            id="fix-input"
            type="number"
            inputMode="numeric"
            min={0}
            value={fixDraft}
            onChange={(e) => setFixDraft(e.target.value)}
            className={panelInputClass}
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setFixModalOpen(false)}
              disabled={fixSaving}
              className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveFixedDaily}
              disabled={fixSaving}
              className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-400 disabled:opacity-50"
            >
              {fixSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </MicroModal>
      )}
    </div>
  )
}

export default App
