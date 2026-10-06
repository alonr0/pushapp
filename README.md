# PushApp

Mobile-friendly exercise tracker for crews. The active season scores push-ups, pull-ups, crunches, and squats. Existing push-up records and leaderboard snapshots remain separate legacy data for possible Hall-of-Fame use.

## Requirements

- Node.js 20.19+ (Vite 8)
- Supabase project with all migrations in `supabase/migrations/` applied in timestamp order
- Email Auth enabled; Google provider enabled with credentials
- Auth redirect URLs configured for local development and production
- A custom SMTP provider for dependable production confirmation, magic-link, and recovery email delivery

## Local setup

Install dependencies and start the local Supabase stack with Docker Desktop running:

```sh
npm install
npx supabase start
npx supabase migration up --local
```

For a local Vite session, create `.env.development.local` with the local API URL and publishable key shown by `npx supabase status`:

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Then start the app:

```sh
npm run dev
```

Keep hosted settings in `.env.local` if needed; Vite's development-specific `.env.development.local` overrides matching variables without replacing the hosted file. Both `.env.local` and `.env.development.local` are ignored by Git.

For hosted development instead, use the browser-safe settings:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_ONESIGNAL_APP_ID=your-onesignal-app-id
```

Never put a Supabase secret or service-role key in a browser-exposed variable. The API endpoint uses server-only `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ONESIGNAL_APP_ID`, and `ONESIGNAL_REST_API_KEY` environment variables when push notifications are enabled.

After a workout log is saved, subscribed members of that crew receive a push notification with the member's name, exercise, and reps. Notifications are localized for English and Hebrew devices.

## Supabase setup

Apply all files in `supabase/migrations/` in timestamp order. The initial migration remains the legacy baseline; later migrations add the active score model and forward fixes while preserving legacy tables and rows. Active scores start at zero. The database uses `Asia/Jerusalem` for activity dates and enforces caps, scoring, membership authorization, and RLS.

Enable email/password and email OTP in **Authentication → Providers**. Enable Google there and configure its credentials and callback URL. Add the app's local and production origins to **Authentication → URL Configuration → Redirect URLs**. Email reset links return to the app origin.

To use numeric email codes as well as magic links, customize the Magic Link email template to include `{{ .Token }}`. Without that template change, the app's link flow still works.

The CLI is pinned as a project dev dependency. Use `npx supabase --help` and `npx supabase migration --help` to discover commands. Local database checks require Docker Desktop. The frontend can also run against a configured hosted Supabase project without local Docker.

With Docker running, start the local services from the repository root:

```sh
npx supabase start
```

`npx supabase status` prints local connection settings. Use only the Project/API URL and Publishable key in `.env.development.local`; never copy a Secret, service-role, or JWT key into browser-visible env files. Local Vite does not serve the Vercel `/api/send-push` function, so local push notification requests return 404 unless run through a Vercel function runtime.

New accounts join a crew with a crew code and display name. Joining creates an active profile, but does not import or alter the legacy scores. Crew codes identify groups; they are not passwords or private credentials.

## Scoring

- Daily caps: push-ups 100, pull-ups 50, crunches 150, squats 150.
- Each exercise is worth up to 25 proportional base points. Category values round to one decimal point before summing.
- Reaching a category cap adds 2 points; maxing all four adds another 10. Daily maximum: 118 points.
- A log that exceeds the remaining category limit is rejected.
- A day qualifies for a streak at 60 base points. Each completed seven-day streak block awards 5 separate lifetime points.

## Commands

- `npm run dev` — start Vite
- `npm run build` — create the production bundle
- `npm run preview` — preview the bundle
- `npm run lint` — lint the workspace
- `npm test` — verify scoring and Israel-time boundary rules