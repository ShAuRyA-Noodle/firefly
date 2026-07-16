# Firefly — Operations Runbook

This is the on-call playbook for production. If you're reading this during an
incident, jump to "Incident playbook" first; everything else is reference.

---

## 1. Production bring-up (first deploy)

Order of operations matters — Convex must be configured before Vercel can
serve any authenticated route.

### 1.1 Provision Convex (production deployment)

```bash
npx convex login
npx convex deploy --prod
```

The first `--prod` deploy creates a brand-new prod Convex deployment and
prints two values you'll paste into Vercel later:

- `VITE_CONVEX_URL`        — points the browser at the websocket gateway
- `VITE_CONVEX_SITE_URL`   — used for OAuth callback URLs

### 1.2 Set Convex dashboard env vars

Open the Convex dashboard → your **prod** deployment → **Settings** →
**Environment Variables**. Set every server-side variable below. If you skip
one, the code path that needs it throws `EnvConfigError` with a hint at first
call site.

| Name                 | Required for                             | Source                                          |
|----------------------|------------------------------------------|-------------------------------------------------|
| `GROQ_API_KEY`       | Director, sub-agents, Whisper alignment, moderation | https://console.groq.com/keys           |
| `GROQ_MODEL_PRIMARY` | Override default Groq model              | optional, defaults `openai/gpt-oss-120b`        |
| `GROQ_MODEL_FALLBACK`| Director fallback                        | optional, defaults `llama-3.3-70b-versatile`    |
| `GROQ_WHISPER_MODEL` | Forced alignment                         | optional, defaults `whisper-large-v3`           |
| `SARVAM_API_KEY`     | TTS                                      | https://dashboard.sarvam.ai                     |
| `SARVAM_TTS_MODEL`   | Override TTS model                       | optional, defaults `bulbul:v2`                  |
| `SARVAM_VOICE`       | Default narration voice                  | optional, defaults `anushka`                    |
| `SARVAM_LANGUAGE`    | Default narration language               | optional, defaults `en-IN`                      |
| `AUTH_GOOGLE_ID`     | Google sign-in (optional)                | https://console.cloud.google.com/apis/credentials |
| `AUTH_GOOGLE_SECRET` | Google sign-in (optional)                | same as above                                   |
| `AUTH_RESEND_KEY`    | Password-reset OTP + cron review reminder | https://resend.com/api-keys                    |
| `SENTRY_DSN`         | Server-side error reporting (optional)   | https://sentry.io                               |
| `SITE_URL`           | Outbound email links                     | `https://firefly.example.com`                   |

`CONVEX_SITE_URL` is auto-provisioned by Convex itself on `--prod` deploy —
do not set manually.

### 1.3 Set Vercel env vars

Vercel → Project → **Settings** → **Environment Variables**. These are read
at browser/SSR time and must NOT be the same set as Convex.

| Name                     | Where used      | Source                            |
|--------------------------|-----------------|-----------------------------------|
| `VITE_CONVEX_URL`        | client + SSR    | from `convex deploy --prod` output |
| `VITE_CONVEX_SITE_URL`   | client + SSR    | from `convex deploy --prod` output |
| `CONVEX_DEPLOYMENT`      | build only      | from `convex deploy --prod` output |
| `VITE_SENTRY_DSN`        | client (optional) | https://sentry.io                |
| `VITE_POSTHOG_KEY`       | client (optional) | https://posthog.com              |
| `VITE_POSTHOG_HOST`      | client (optional) | defaults `https://us.i.posthog.com` |
| `SITE_URL`               | SSR              | `https://firefly.example.com`     |

### 1.4 Wire Google OAuth callback

If `AUTH_GOOGLE_ID` is set, Google Cloud Console → OAuth credentials →
Authorized redirect URIs must include exactly:

```
${VITE_CONVEX_SITE_URL}/api/auth/callback/google
```

The fully-qualified value (no trailing slash, https). Mismatch here is the
single most common Wave-1 launch blocker — the user clicks "Continue with
Google", lands on a 400 from Google's auth server, and bounces.

### 1.5 First-time crons

`convex/crons.ts` registers the `daily concept-due reminder` job. It runs
24h after the first deploy and every 24h after that. There's no manual
trigger needed; the Convex scheduler picks it up on the next deploy.

You can dry-run it manually in dashboard → Functions →
`crons:sendReviewReminders` → Run with `{}`. If `AUTH_RESEND_KEY` is unset,
it returns zeros and logs a warning — safe.

---

## 2. Backups & data export

### 2.1 Snapshot the Convex production db

```bash
# Full export (writes to ./convex-backup-<timestamp>/)
npx convex export --prod --path ./convex-backup-$(date +%Y%m%d-%H%M%S)
```

Run this:

- **Before any schema migration** that touches existing tables.
- **Weekly** as a cron on a controlled host (push the tarball to S3 / R2 /
  whatever compliant storage you keep paying for).
- **Before** running `users:deleteMe` on a real account that may turn out
  to be a misclick.

### 2.2 Restore

```bash
npx convex import --prod --replace ./convex-backup-<timestamp>
```

`--replace` wipes the prod tables before importing. There is no in-place
"undo": the only way to recover from a bad import is to restore from an
older snapshot. **This is why we run weekly snapshots.**

### 2.3 Per-user export (GDPR / portability)

Endpoint: `api.users.exportMine` (auth-gated query, no args). Returns JSON
with the user's auth identity + every owned row across `threads`,
`explanations`, `user_memories`, `user_skill_progress`,
`user_concept_progress`, `quiz_attempts`, `userPreferences`,
`usage_events`, `share_links`. Capped at 5,000 rows per table; the response
includes a `truncated` map flagging any table that hit the cap.

For a power user beyond the cap, run a paginated dump from the Convex
dashboard's REPL (no row cap) and email them the file directly.

### 2.4 Per-user erasure (GDPR / right-to-erasure)

Endpoint: `api.users.deleteMe` (auth-gated action, no args). Cascade order:

1. Walk `explanations`, drop `audioStorageId` blobs from `_storage`, then
   delete the rows.
2. Delete `threads`, `user_memories`, `user_skill_progress`,
   `user_concept_progress`, `quiz_attempts`, `userPreferences`,
   `usage_events`, `share_links` in batches of 256 per transaction. Each
   batch is its own internal mutation; the action drives the loop until
   each table is empty.

**The auth `users` row itself is NOT deleted automatically.** Convex Auth's
current public API does not expose `auth.deleteAccount` from the action
ctx, so we leave the orphan auth row and document this manual cleanup
step:

```bash
# After the user calls deleteMe:
npx convex run --prod _system/users:deleteUser --args '{"userId":"<id>"}'
```

(Or do it through the Convex dashboard's user management UI.) Authentication
tokens still expire on their own clock; the orphan row carries no PII once
`deleteMe` has run.

---

## 3. Incident playbook

### 3.1 First five minutes

1. **Check Convex status**: https://status.convex.dev
2. **Check Groq status**: https://status.groq.com
3. **Check Sarvam status**: their dashboard banner
4. **Check Vercel status**: https://www.vercel-status.com
5. Open Convex dashboard → **Logs** stream for the prod deployment. Filter
   by `error`. Look for repeated `EnvConfigError` (someone rotated a key and
   forgot to push it to dashboard env), or repeated `Forbidden` (auth
   regression).

### 3.2 Who to call

| Symptom                        | First responder                |
|--------------------------------|--------------------------------|
| Convex deploy red              | Shaurya (deploy owner)         |
| Groq 5xx storm                 | Falls back automatically (`agent.ts` PRIMARY_MODEL → FALLBACK_MODEL); no human action needed for <30 min outages |
| Sarvam 5xx storm               | TTS fails; circuit breaker (`convex/lib/breaker.ts`) trips; UI shows the silent transcript; no human action needed |
| Auth flow broken (sign-in 400) | Verify `AUTH_GOOGLE_ID` + redirect URI match |
| Cron reminder not firing       | Check `AUTH_RESEND_KEY` is set in Convex env; check `crons:sendReviewReminders` log for `failed` count |
| Cost spike alert               | Open `api.usage.myUsage` for the top-10 users by total `costCents`; throttle via dashboard rate-limiter overrides |

### 3.3 Log streams

- **Convex function logs**: dashboard → Logs (live tail). Each function
  invocation logs with its full args + return; `console.warn`/`console.error`
  bubble to the same stream.
- **Vercel function logs**: dashboard → Functions → click any deployment.
  TanStack Start SSR errors live here.
- **Browser-side errors**: Sentry (if `VITE_SENTRY_DSN` is set).

### 3.4 Circuit breaker behavior

`convex/lib/breaker.ts` wraps Sarvam TTS calls. After 5 consecutive failures
within a 30-second window the breaker opens for 60 seconds; subsequent
calls fail fast with `BreakerOpenError`. The agent surfaces this as a
"narration unavailable" string on the affected frame; the visual still
renders. Breaker state is in-memory per Convex function instance — there is
no global state, so a redeploy resets every breaker.

### 3.5 Rate-limiter behavior

User-facing limiters live in `convex/rateLimiter.ts`:

- `sendQuestion` — 30/hr/user, capacity 30. Throws `Too many requests`.
- `dailyQuestions` — 100/day/user (fixed window). Hard cap.
- `ttsPerUser`, `ttsPerUserMinute` — Sarvam quota protection.
- `ttsPerAnonymousUser` — lower cap for anonymous accounts.
- `anonymousSignup` — 100/hr global on the anonymous provider.
- `passwordReset` — 3/hr/email-hash.

Override any of these from the Convex dashboard → Functions → component
data → `rateLimiter` table; delete the row to reset the bucket immediately.

---

## 4. Monitoring setup

### 4.1 Sentry

1. Create a Sentry project (Platform: React + Node).
2. Set `VITE_SENTRY_DSN` (browser) in Vercel and `SENTRY_DSN` (server) in
   Convex dashboard.
3. The browser-side init lives in `src/main.tsx` (delta-owned). Server-side
   init runs in any action that imports `@sentry/browser` or its node
   counterpart.

### 4.2 PostHog (product analytics, optional)

`VITE_POSTHOG_KEY` + `VITE_POSTHOG_HOST` in Vercel. Off by default.

### 4.3 Cost dashboard

Run the `myUsage` query manually for the top users (or wire a small admin
page calling it with `runQueryAsAdmin` + a `userId` arg if you build one).
The `usage_events` table is insert-only; aggregations stay cheap.

---

## 5. Secret rotation

### 5.1 Cadence

| Secret              | Rotation cadence | Reason                              |
|---------------------|------------------|-------------------------------------|
| `GROQ_API_KEY`      | 90 days          | provider best practice              |
| `SARVAM_API_KEY`    | 90 days          | provider best practice              |
| `AUTH_GOOGLE_SECRET`| 365 days         | Google OAuth client secret          |
| `AUTH_RESEND_KEY`   | 90 days          | mail provider best practice         |
| `SENTRY_DSN`        | on incident only | DSN is not strictly secret but rotate if leaked |

### 5.2 Procedure (zero-downtime)

1. Generate the new key in the provider dashboard.
2. Push the **new** value to Convex / Vercel env vars (overwrites old).
3. Trigger a redeploy: `npx convex deploy --prod` and a Vercel rebuild.
4. Confirm one happy-path request hits the new key (Convex log shows a
   successful Groq/Sarvam call with no `401`).
5. **Now** revoke the old key in the provider dashboard.

Steps 2 and 5 are on opposite sides of the redeploy on purpose: revoking
the old key first triggers a 401 storm until the redeploy completes.

---

## 6. Dependency policy

We **pin** rather than caret a few deps because the upstream RC/beta
landscape changes too fast to trust SemVer:

- **TanStack Start** ecosystem (`@tanstack/react-router`,
  `@tanstack/react-router-devtools`, `@tanstack/react-router-ssr-query`,
  `@tanstack/react-start`, `@tanstack/react-devtools`,
  `@tanstack/devtools-vite`, `@tanstack/eslint-config`) — pre-1.0 RCs.
  Caret pulls minor bumps that have repeatedly introduced breaking
  exports.
- **`nitro@3.x-beta`** — beta builds; minor bumps regularly change the
  Vite plugin contract.
- **React peers**: `pnpm.overrides.react` and `react-dom` pin the runtime
  to 19.x so `@met4citizen/talkinghead` (which advertises React 18 in its
  peer range) doesn't pull in a stale duplicate.

To bump any of these intentionally:

```bash
pnpm up -L "@tanstack/*"
pnpm up -L "nitro"
# then run the test suite + smoke-test routing + run `bun run build`
```

---

## 7. Presence (live "who is watching this share")

We use the official `@convex-dev/presence` Convex component as the substrate
for collaborative features. Today it powers the small "N watching" badge on
public share pages; future Phase 5 work (cursors, role permissions, live
editing) will layer on top of the same component.

### 7.1 What's installed

- Package: `@convex-dev/presence` (peer of `convex@^1.24.8`).
- Registered in `convex/convex.config.ts` via `app.use(presence)`.
- Public surface: `convex/presence.ts` exports
  - `heartbeat({ slug, sessionId, displayName? })` — anonymous-friendly,
    extends a session's TTL.
  - `listForRoom({ roomKey })` — returns
    `{ sessionId, displayName, joinedAt }[]` for the active viewers.
  - `disconnect({ sessionToken })` — optional graceful release; not used
    by the default UI.

### 7.2 Environment variables

**None.** The presence component is fully self-contained inside Convex —
there is no external service, no API key, and no per-environment config.
The component lives inside your prod Convex deployment and scales with it.

### 7.3 Heartbeat / TTL behavior

- The PresenceBar client heartbeats every **15s**.
- The component evicts a session at **2.5x the interval (~37.5s)** if no
  heartbeat is received, OR on a graceful `disconnect` call.
- We deliberately do NOT send a graceful disconnect on tab close — the
  `beforeunload` lifecycle is unreliable cross-browser (especially on
  mobile). We let TTL eviction handle cleanup.
- Each heartbeat is O(1) on the server: it touches one (room, session)
  row. The `listForRoom` query is shared across all viewers in a room, so
  total server cost scales O(N) with viewers, not O(N²).

### 7.4 Room-key conventions

`heartbeat` and `listForRoom` accept a single string. We have two reserved
namespaces today:

| Prefix      | Meaning                                              |
|-------------|------------------------------------------------------|
| `share:`    | Public share view (anonymous viewers OK)             |
| `owner:`    | Owner viewing their own thread                       |

The PresenceBar passes the bare slug for share rooms; `convex/presence.ts`
auto-prepends `share:` if the caller did not supply a prefix. To add a new
namespace (e.g. `classroom:` for teacher mode), add it to the allowlist in
`canonicalRoomId()` in `convex/presence.ts`.

### 7.5 Privacy

- The viewer's `sessionId` is a per-browser UUID generated client-side
  and persisted in `localStorage["firefly.sessionId"]` with a 24h TTL.
- It is NEVER tied to a user account, email, or IP.
- `displayName` defaults to "anonymous viewer" and is truncated server-side
  to 40 characters.
- Anyone with a share slug can see the count and display names — but
  knowing the slug already grants read access to the thread, so this is
  strictly less sensitive than the content itself.

### 7.6 Failure mode

Both the `heartbeat` mutation and `listForRoom` query wrap their underlying
component calls in `try/catch` and return safe defaults (`{ ok: false }` or
`[]`) on failure. Presence is an enhancement; a 5xx from the component
must never block the share view from rendering.

### 7.7 Bumping the component

```bash
pnpm up -L @convex-dev/presence
npx convex dev --typecheck-components   # verify component contract still matches
pnpm test                                # full vitest suite
```

If the component's API surface changes (heartbeat signature, list shape),
update `convex/presence.ts` first, then `src/components/PresenceBar.tsx`.
Do NOT replace the component with a custom implementation — presence is
hard to get right without scheduled-function-driven eviction.

---

## 8. Pending wiring (manual TODO)

See `WIRING_TODO.md` for the cross-agent contract. Any item there is
shipped-but-not-wired: the module exists and tests pass, but the call site
inside an existing handler hasn't been added yet.
