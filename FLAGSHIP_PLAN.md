# Firefly — Flagship Transformation Plan

> Produced from a 4-agent forensic audit (backend orchestration, frontend/mobile, security/cost, product-reality). Every claim below is backed by `file:line` evidence in the audit. This is the single source of truth for turning Firefly from "demos on the first question" into a real, flagship, everything-works product.

---

## 0. Reality verdict (read this first)

**Firefly is not vaporware.** Nearly every headline feature is backed by real, non-trivial, working code:

- Director → sub-agent orchestration is **real** (`@convex-dev/agent`, zod-validated tool-use, genuine parallel scheduled actions — not simulated).
- All five renderers render **real dynamic content** from backend config: Manim (`manim-web` primitives), Diagram (Excalidraw), Particles (real R3F physics loop), Code (Shiki), UI (JSON→React interpreter).
- The avatar **really** loads a 12 MB GLB and lip-syncs to real word timings; STT is real; Sarvam TTS + Whisper word-timing are real HTTP integrations.
- Quizzes are **server-authoritative** (client never holds the answer); spaced repetition, memory extraction, sharing, presence, moderation, vision OCR, GDPR export/delete all exist and mostly work.

**So the gap to "flagship" is not building fake features — it is:**
1. A handful of **genuinely broken** things that make the core loop and account actions fail.
2. **Security/cost** exposure (unbounded spend, open dev skills surface, incomplete erasure).
3. **Fidelity** (Manim, narration timing, branching tree) — the believability levers.
4. **Mobile/responsive** finish and pervasive low-contrast text.
5. **Cruft + doc drift** that actively misleads.

The strategy: **solidify the foundation (Phase 0), make every feature genuinely real end-to-end (Phase 1), then flagship polish + mobile-first (Phase 2).**

---

## 1. CRITICAL — ship-blockers (fix before anything else)

| # | Severity | Problem | Evidence | Impact |
|---|----------|---------|----------|--------|
| C1 | **P0 core loop** | **Thread reuse breaks all follow-ups.** Frontend reuses one `threadId` across questions + ActionCards; backend keys on `(threadId, step)` and the director restarts at step 1 each question. Q2's steps 1-4 collide with Q1's rows → every follow-up frame is `REJECTED`, **zero new visuals**. Cumulative count settles instantly (`_done` fires against Q1's frames). Memory extracts only once ever. | backend §3 P0 — `threads.ts:170,310`, `agent.ts:410`, `index.tsx:260,420`, `memories.ts:24` | App only works on the **first** question. The documented primary navigation (ActionCards) is dead. |
| C2 | **P0 runtime** | **Account buttons throw on click.** `exportMine` (a query) called via `useAction`; `deleteMe` (an action) called via `useMutation`. Both hard-throw the moment the user clicks. Masked by an `(api as any).users` shim + stale "not deployed until Zeta ships" comment — functions *do* exist. | frontend §2 P0 — `settings.tsx:274-275`, `users.ts:288,334` | GDPR export + account deletion both silently broken. |
| C3 | **P0 security/cost** | **Unlimited free anonymous accounts → unbounded paid-API spend.** Anonymous signup gate is bypassable by design + only a global 100/hr window; every downstream limiter is per-`userId`, so disposable accounts each get a fresh budget. Each question fans out to ~5 Groq + 4 Sarvam + Whisper calls. No global spend circuit-breaker. | security §3.1 — `auth.ts:41`, `rateLimiter.ts:49`, `chat.ts:85,251` | Attacker scripts account creation → attacker-chosen paid spend. Largest cost exposure. |
| C4 | **P0 security** | **Dev-deployment skills surface is world-readable/writable.** App runs on `dev:nautical-dalmatian-537`; `assertSyncSecret`/`assertSkillsAdmin` return without error under a `dev:` prefix when the secret env is unset. The Convex URL ships in the client bundle. Anyone can `skills.list` (exfiltrate the proprietary prompt corpus) **and** `skills.upsert` (rewrite the `SKILL.md` sub-agents load → persistent prompt-injection / agent-hijack). | security §3.7 — `skills.ts:64,92`, `.env.local:32`, `agent.ts:172` | Full theft + persistent injection of the agent's instructions on any public demo. |
| C5 | **P0 privacy** | **`deleteMe` leaves the `@convex-dev/agent` message store.** Cascade deletes app tables but not the component's messages keyed by `agentThreadId` — the users' verbatim prompts (the most sensitive PII) survive erasure. | security §5.1 / backend — `users.ts:71`, `chat.ts:19,50` | GDPR right-to-erasure silently incomplete. |
| C6 | **P0 stall** | **Threads permanently stall.** `expectedFrames` comes from the LLM-announced `totalFrames`, not actual dispatched slots; on any miscount, or if the director errors / hits `maxSteps` before calling `done()`, `_done` is never inserted. No settle-sweep cron to unstick. | backend §3 P0/P1 — `agent.ts:121,153`, `threads.ts:88,308` | UI stuck at "3 of 4" forever; memory never runs. |
| C7 | **P0 hygiene** | **Live Groq + Sarvam keys in `.env.local`** (real, active). Not committed (good), but present in the working tree and mirrored to the dev dashboard. | security §2.1 — `.env.local:11,17` | Treat as compromised → rotate both. |

---

## 2. HIGH — fidelity, cost-truth, and correctness

**Cost telemetry is blind to ~80% of spend.** `usage.record` is never called for `groq.director`, `groq.subagent`, or `groq.memory` — the three biggest LLM spenders. `myUsage` (the ops cost dashboard) is structurally fiction. *(backend §2.1, security §6.1 — `agent.ts`, `usage.ts:122`)*

**The critic gates nothing.** Fail-open on every path (no key, error, unparseable, and even on real `ok:false` after one revise). It adds a synchronous Groq call to **every** frame for near-zero enforcement — pure latency + cost tax. *(backend §1 — `critic.ts:54,73,106,130`, `agent.ts:432,459`)*

**Skill-spec ↔ schema mismatches reject valid-looking configs.** The Manim skill tells the model to use `vector`, `number_line`, `moveTo`, `indicate` — none are in the zod enums. The Particles skill's own worked example emits a `noise` force without the schema-required `speed`. A model that follows the docs produces configs that **fail validation**, burn the one retry, and risk `_failed`. *(backend §5 — `manim/SKILL.md:82-92` vs `skillSchemas.ts:36-58`; `particles/SKILL.md:38` vs `skillSchemas.ts:174`)*

**Fidelity gaps (the flagship believability levers):**
- **Manim** is a constrained JSON→primitive interpreter (~10 objects, ~6 animations), not real 3Blue1Brown. **#1 believability gap.**
- **Narration timing** is Whisper *re-transcription* of the generated audio, not forced alignment to the known narration text → drift when Whisper mishears.
- **Branching** is a linear breadcrumb, not the promised spatial/collapsible tree (~20% done).

**Correctness hardening:**
- No unique index on `(threadId, step)` → concurrent same-step dispatch can double-write (TOCTOU). *(backend §3 P1)*
- Unbounded `.collect()` on `explanations` in six hot paths that run on every frame write → cost + OCC risk scales with thread age. *(backend §3 P1)*
- Director has **no** model fallback (only sub-agents do); the fallback-model docstring constants are reversed. *(backend §3 P2)*
- No prompt-length bound anywhere → single request can carry hundreds of KB into Groq. *(security §3.2)*
- `presence.heartbeat`/`disconnect` are **unauthenticated, unratelimited writes** with arbitrary room keys. *(security §3.4)*
- `getSharedThread` public read is unthrottled (scraping amplification). *(security §3.5)*
- `generateUploadUrl` orphan blobs are never GC'd — upload-only calls fill storage unboundedly, free, anonymous. *(security §3.3)*
- Moderation fails open (unrecognized output = safe; Groq outage → ~9-substring keyword floor). Acceptable for availability, but understand the exposure; fail-closed on S3/CSAM. *(security §4.2)*

---

## 3. MEDIUM — mobile/responsive & accessibility (user-emphasized)

**Breaks on a 375px phone:**
- `UIRenderer` `Grid` never collapses (`repeat(N, 1fr)` hardcoded) → 3-4 columns at ~80-110px, unreadable. Tabs overflow (no `overflow-x-auto`). `DiagramRenderer` fixed `height: 500` (not `dvh`). *(frontend §3 — `UIRenderer.tsx:82,247`, `DiagramRenderer.tsx:42`)*
- **12 MB avatar GLB on the mobile critical path** — downloads before first interaction, no defer, no `save-data`/connection gate, no low-power skip. *(frontend §3 — `index.tsx:414`)*
- Fixed-position overlays collide on narrow screens; no landscape handling (avatar eats 220px of a 375px-tall landscape screen). *(frontend §3)*
- No `viewport-fit=cover` / `env(safe-area-inset-*)` → prompt bar under the iOS home indicator. *(frontend §3 — `__root.tsx:16`)*
- Particles default **3000**, CPU-integrated every frame + per-particle color recompute + `autoRotate` → frame drops on mobile GPUs; no device budget. *(frontend §4 — `ParticlesRenderer.tsx:9`)*

**Accessibility:**
- **Pervasive low contrast:** `--smoke` (#3A3733) on `--void` ≈ **1.8:1** (WCAG needs 4.5:1) used for real content everywhere. Lift to `ash`-level. *(frontend §4)*
- Duplicate `<h1>` when onboarding overlays welcome; inverted mic icon (MicOff when idle); malformed `#05040` gradient stop silently dropped. *(frontend §4)*

**Done well (keep):** touch-swipe frame nav, 44px tap targets, iOS 16px-input zoom prevention, `100dvh` shell, `inert`/`contentVisibility` perf gates, SR live regions, genuine reduced-motion respect, per-renderer error boundaries.

---

## 4. LOW — cruft, redundancy & doc drift

- **Two lockfiles** (`bun.lock` + `pnpm-lock.yaml`) → a fresh clone can produce two different dep trees. Pick one manager, reconcile OPERATIONS commands.
- **Triplicate agent-skill installs** (`.qwen/`, `.vibe/`, `.agents/skills/`) — same Convex skill set. Keep one.
- **Dead code/indexes:** `chat.sendMessage` (dead + broken if called), `explanations.markDone`, `countNonDoneForThread`, `getByMessage`+`by_message`, `getThreadPlan`, `getSkillProgressForUser`, `topConceptsForUser`, `quiz.recentAttempts`/`myQuizScore`, `explanations.parentId`+`by_parent`, `threads.by_parent_thread`, `quiz_attempts.by_explanation`, `void allowed`. Dead settings shim, PostHog stub, duplicate PWA icons.
- **Docs actively mislead:** `PRD.md` ~80% stale (specifies Claude API + WorkOS + ElevenLabs + Voxtral + RAG/Workflow/r2 — **none** in code; actual is Groq + Convex Auth + Sarvam). `WIRING_TODO.md` **100% stale** (everything it lists as unwired is wired). README contradicts itself (ElevenLabs vs Sarvam; "custom R3F rig" is actually the `talkinghead` library + GLB). `NEXT_STEPS.md` lists shipped features (spaced-rep, quizzes, sharing) as "future."
- **Test gap:** the riskiest code — the dispatch/settle/`_failed`/critic-retry state machine — is untested.

---

## 5. The Plan — three phases

### Phase 0 — Solidify the foundation (ship-blockers + secure)
*Goal: the core loop works end-to-end for real users; nothing broken-on-click; not exploitable.*

1. **Fix the follow-up loop (C1).** Add `turnId` to `explanations` + index `(threadId, turnId, step)`; stamp it in `create` and thread it from `sendMessageStreaming`/`resetThreadPlan`; scope `existsRenderForStep`, `markDoneIfSettled`, `priorFrameSkills`, `_framesForThread`, `getByThread`, and memory keying to the current turn. *(The flagship-correct fix; the smaller alternative — fresh thread per question — fragments memory/history.)*
2. **Derive `expectedFrames` from `inflightDispatched`, not the LLM (C6);** add a **settle-sweep cron** to finalize stalled threads.
3. **Fix account actions (C2):** correct hook types, drop the `(api as any)` shim so TS catches it, verify export + delete end-to-end.
4. **Bound total spend (C3):** global daily question/spend circuit-breaker (`key:"global"`) in addition to per-user; gate anonymous signup behind IP/CAPTCHA at the HTTP layer; consider disabling public anonymous auth for launch. Add a prompt-length cap.
5. **Lock the skills surface (C4):** deploy on a **prod** Convex deployment; set `SKILLS_SYNC_SECRET` + `SKILLS_ADMIN_USER_IDS` always; remove the `dev:` fallthrough.
6. **Complete erasure (C5):** delete the agent-component messages/threads for each `agentThreadId` (and sub-agent threads) inside `deleteMe`.
7. **Rotate the exposed keys (C7).**
8. **Wire the three missing usage emitters** (`groq.director`/`subagent`/`memory`) so cost is observable before scaling.
9. **Fix skill-spec ↔ schema mismatches** (Manim enums, Particles `noise.speed`) + add a test asserting every documented example config passes its schema.
10. **Doc truth pass:** rewrite/archive PRD, delete WIRING_TODO, reconcile README (Sarvam, talkinghead), move shipped features out of NEXT_STEPS.
11. **Kill cruft:** one package manager, one skill-install dir, delete dead exports/indexes/shims/dup icons.
12. **Add orchestration tests:** `tryDispatchSlot` / `markDoneIfSettled` / `_failed` / critic-retry / turn-boundary.

### Phase 1 — Make every feature genuinely real
*Goal: fidelity + reliability so it works on the 2nd, 10th, and 100th question, on any prompt.*

1. **Manim overhaul** (biggest lever): dramatically expand the primitive/animation vocabulary, or move to server-side real Manim render → video/Lottie.
2. **True forced alignment** for narration timing (align the *known* text to audio; kill drift).
3. **Real branching tree UI** — spatial, collapsible, breadcrumb-compatible.
4. **Frame-gen SLOs:** telemetry on time-to-first-frame + failure/retry rate; tune the 4-frame cap and timeouts; harden primary→fallback→`_failed`. **Give the director a model fallback.**
5. **Unique `(threadId,turnId,step)` index** to make renders DB-idempotent; bound the hot-path `.collect()`s; rate-limit `presence.heartbeat` + `getSharedThread` + `generateUploadUrl`; add an orphan-blob GC cron.
6. **Decide the critic's role:** real gate with a bounded budget, or move off the synchronous path (post-hoc scoring). Stop taxing every frame for nothing.
7. **Settings completeness:** ship light mode, remove the shim, verify voice/speed/motion actually propagate to TTS + avatar.
8. **Verify/pin a live Groq vision model** (`llama-3.2-*-vision-preview` are deprecated).
9. **Cost/rate-limit admin surface;** wire PostHog or remove the claim; fail-closed moderation on S3/CSAM.

### Phase 2 — Flagship polish + mobile-first + growth
*Goal: feels like a million-dollar product on a phone.*

1. **Mobile-native pass:** responsive `Grid`/`Tabs`/`Table`; device-tested avatar (defer + `save-data` gate + static fallback) and canvas perf budgets; coherent overlay stacking + landscape; safe-area insets; particle budget by device.
2. **Contrast/a11y certification:** lift `smoke`→`ash` for info-bearing text; dedupe `<h1>`; flip mic icon; fix `#05040`; full WCAG + reduced-motion pass.
3. **Onboarding → first "wow" in <10s:** warm-cache the first frame, guided first question.
4. **Share as a growth surface:** OG images/SEO, read-only avatar playback, embeds, rate-limit + report/takedown.
5. **Collaboration:** wire `owner:` presence, co-viewing, teacher mode (substrate already built).
6. **Scroll-as-timeline** continuous playback (remaining V2 aspiration).
7. **Security hardening tail:** CSP/HSTS/frame headers, generic client error messages, `by_user` index on `share_links`, breaker doc/threshold reconciliation.

---

## 6. Suggested execution order (first 10 concrete PRs)

1. `turnId` boundary + settle from `inflightDispatched` + settle-sweep cron (C1 + C6). **← unblocks the whole product**
2. Fix account hook types + drop shim (C2).
3. Global spend breaker + prompt-length cap + anonymous-signup gate (C3).
4. Prod deployment + skills secret + remove `dev:` fallthrough (C4); rotate keys (C7).
5. `deleteMe` agent-store erasure (C5).
6. Wire director/subagent/memory usage records (cost truth).
7. Skill-spec ↔ schema fix + example-config tests.
8. Doc truth pass + cruft purge (lockfile, skill dirs, dead exports).
9. Mobile responsive `Grid`/`Tabs`/`Diagram` + safe-area + avatar defer.
10. Contrast/a11y sweep.

---

*Foundation is genuinely strong. Distance to flagship = reliability, fidelity, and finish — not a wall of fake features.*
