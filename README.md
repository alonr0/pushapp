# PushApp

Mobile friendly pushup tracker for crews. Members log daily reps, set goals, and see live group leaderboards. Data and anonymous sessions are stored in Supabase.

## Requirements

- Node.js 20.19+ (Vite 8)
- A Supabase project with the schema in `supabase/migrations/202609240001_initial_schema.sql` applied
- Anonymous sign-ins enabled in Supabase Auth
- `users` and `daily_leaderboards` enabled in the `supabase_realtime` publication

## Local setup

```sh
npm install
npm run dev
```

Create `.env.local` with the public client configuration:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
NEXT_PUBLIC_ONESIGNAL_APP_ID=your-onesignal-app-id
```

`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and the legacy anon-key names are also accepted. Never put a secret or service role key in a browser-exposed variable.

## Supabase setup

Apply the SQL migration in the Supabase SQL editor or through the Supabase CLI. It creates the tables, membership policies, and `join_group` RPC. Enable anonymous sign-ins in **Authentication → Providers → Anonymous** and add `users` and `daily_leaderboards` to the `supabase_realtime` publication.

The app creates an anonymous Supabase identity, calls `join_group` for the entered group code and display name, and uses RLS to scope all reads and writes to groups joined by that identity. Anonymous accounts are tied to their browser session; clearing browser storage loses access to that identity.

## Commands

- `npm run dev` — start the Vite development server
- `npm run build` — produce the production build in `dist/`
- `npm run preview` — preview the production build
- `npm run lint` — lint source files
- `npm run retro:day -- ...` — add or correct a historical day
- `npm run enrich:history -- ...` — fill missing goal fields in history
- `npm run backfill:group -- ...` — backfill daily leaderboard snapshots
- `npm run recalc:podiums -- ...` — recalculate podium totals

Administrative scripts use the Supabase URL and publishable key in `.env.local` and require a joined anonymous session with access to the target group.

## Vercel environment

Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `NEXT_PUBLIC_ONESIGNAL_APP_ID` for the client build. The `/api/send-push` function also needs `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ONESIGNAL_APP_ID`, and `ONESIGNAL_REST_API_KEY`. Keep the OneSignal REST key server-only. The function checks the caller's Supabase session and group membership before sending a notification.
