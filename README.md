# PushApp

Mobile-friendly pushup tracker for crews. Log daily reps, hit personal goals, and compete on group leaderboards — all backed by Firebase Firestore with live sync.

## Features

### Dashboard
- Log pushups for today
- Progress ring toward your daily goal (editable)
- Live **Crew · today** ranking

### History
- Personal stats in one row: **all-time total**, **daily average** (includes 0-rep rest days), **goal streak**
- Last-sessions chart (area graph)
- **By day** timeline with goal reference per entry

### Leaderboard
- **Your podiums** — lifetime 1st / 2nd / 3rd place counts in the group
- **All-time total** — top 3 by lifetime reps (with best single-day count)
- **Yesterday’s standings** — podium + full list (includes 0-rep members)
- **Leaderboard history** — pick any archived day (two or more days ago)

Day rollover archives yesterday’s count into `history`, syncs the group snapshot, and awards podium medals when appropriate.

## Tech stack

- [React](https://react.dev/) 19 + [Vite](https://vite.dev/)
- [Tailwind CSS](https://tailwindcss.com/) 4
- [Firebase](https://firebase.google.com/) Firestore (client SDK)
- [Recharts](https://recharts.org/) for history charts

## Getting started

### Prerequisites

- Node.js 18+
- A Firebase project with Firestore enabled

### Install

```bash
npm install
```

### Environment

Create `.env.local` in the project root (gitignored):

```env
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

Values come from Firebase Console → Project settings → Your apps → Web app config.

### Run locally

```bash
npm run dev
```

Other scripts:

| Command | Description |
|--------|-------------|
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Preview production build |
| `npm run lint` | ESLint |

## Joining a group

On first visit, enter a **display name** and **group invite code** (e.g. `ketty789`). The app stores your session in `localStorage` and creates or updates a user document:

`users/{groupId}::{displayName}` (lowercase group id and name)

The same display name in different groups is a **different** user document.

## Firestore data model

### `users/{userId}`

| Field | Description |
|-------|-------------|
| `name` | Display name |
| `groupId` | Normalized group code |
| `dailyCount` | Reps logged today (local calendar day) |
| `dailyGoal` | Personal daily goal (default 50) |
| `totalCount` | Lifetime reps |
| `history` | `[{ date, count, goalMet, goalAtDayEnd? }]` per archived day |
| `podiums` | `{ first, second, third }` — place finishes in the group |
| `lastUpdated` | Server timestamp of last log |

### `groups/{groupId}`

Optional metadata (e.g. `groupName` for display).

### `groups/{groupId}/dailyLeaderboards/{YYYY-MM-DD}`

| Field | Description |
|-------|-------------|
| `date` | `YYYY-MM-DD` |
| `rankings` | `[{ name, score, rank }]` |
| `podiumsAwarded` | `true` after medals were granted for that day |
| `createdAt` / `updatedAt` | Timestamps |

The app prefers **live user `history`** for display when available; snapshots fill gaps and stay synced via `syncGroupSnapshotForDate`.

### Firestore rules

Clients need read/write on `users` (by `groupId`), read on `groups`, and create/read/update on `groups/{id}/dailyLeaderboards/{date}` (including `podiums.*` increments on users). Tighten rules for your deployment as needed.

## Admin scripts

Both scripts use `.env.local` and run via `vite-node`.

### Backfill missing group snapshots

Creates `dailyLeaderboards` docs from crew `history` for dates that have scores but no snapshot yet. Does **not** award retro podiums by default.

```bash
npm run backfill:group -- <group-id>
```

Example:

```bash
npm run backfill:group -- ketty789
```

### Add or fix one retro day

Writes one `history` entry for a member and rebuilds that day’s group snapshot.

```bash
npm run retro:day -- <group-id> <display-name> <date> <count> <goal>
```

Examples:

```bash
npm run retro:day -- ketty789 אלמוג 16-5 120 100
npm run retro:day -- ketty789 אלמוג 2026-05-16 120 100 --dry-run
```

Date formats: `YYYY-MM-DD`, `DD-MM`, or `DD/MM` (year defaults to current year).

## Project structure

```
pushapp/
├── public/              # Static assets, PWA manifest
├── scripts/
│   ├── backfill-group.mjs
│   └── retro-day.mjs
├── src/
│   ├── App.jsx              # UI, tabs, Firestore listeners
│   ├── firebase.js          # Firebase init
│   ├── leaderboardSnapshot.js  # Rankings, snapshots, sync, podiums
│   ├── retroHistory.js      # Retro day upsert helper
│   ├── main.jsx
│   └── index.css
├── index.html
└── vite.config.js
```

## How standings stay in sync

1. **Lazy midnight reset** — When you open the app on a new local day, yesterday’s `dailyCount` is archived into `history`.
2. **Yesterday sync** — `ensureYesterdayGroupSnapshot` rebuilds yesterday’s `dailyLeaderboards` from current user data and awards podiums once (`podiumsAwarded`).
3. **Live crew data** — Leaderboard UI ranks from user `history` / today when present, not stale snapshot scores.
4. **Debounced re-sync** — When any group member’s data changes, yesterday’s snapshot is checked again.

Open the **Leaderboard** tab after retro edits or backfill so snapshots and medals can catch up.

## License

Private project — see repository owner for usage terms.
