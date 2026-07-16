# Cross-agent wiring TODO

This file tracks shipped-but-not-wired modules. Each entry is owned by a
specific agent who needs to add the call site inside their existing handler.
DO NOT edit a module out of its owner's lane — open a wiring PR against the
owner's file and link this checklist.

---

## Beta — `convex/chat.ts`

### [ ] Wire `dailyQuestions` rate limit

Gamma (`convex/rateLimiter.ts`) defined a `dailyQuestions` limiter:
100 questions / 24h / user, fixed window. It's currently defined-but-unused.

Add this **next to** the existing `sendQuestion` limit calls in both
`sendMessage` and `sendMessageStreaming`:

```ts
await rateLimiter.limit(ctx, "dailyQuestions", {
  key: ctx.userId,
  throws: true,
});
```

Order doesn't matter relative to `sendQuestion` — both throw on overage.

### [ ] Wire `internal.moderation.checkPrompt`

Zeta (`convex/moderation.ts`) ships a Llama-Guard pre-filter. Call it
**before** `director.streamText` in `sendMessageStreaming`:

```ts
const verdict = await ctx.runAction(internal.moderation.checkPrompt, {
  prompt: args.prompt,
});
if (!verdict.safe) {
  // Surface the refusal as a synthetic frame so the user sees feedback
  // instead of a silent stall, then return without invoking the director.
  throw new Error(verdict.reason ?? "Prompt flagged by safety pre-filter.");
}
```

The action is best-effort — it falls back to a keyword filter if Groq is
down or the model is unavailable, so it never hard-fails the request path.

---

## Beta + Gamma + Delta — usage tracking

Zeta (`convex/usage.ts`) ships `internal.usage.record` with hardcoded
pricing constants (`GROQ_TOKENS_IN_PER_M`, `GROQ_TOKENS_OUT_PER_M`,
`SARVAM_CHARS_PER_M`) and helpers (`groqCostCents`, `sarvamCostCents`).
Wire one `runMutation(internal.usage.record, { ... })` call after every
LLM/TTS hit so spend per user is observable via `api.usage.myUsage`.

| Call site                                 | Owner   | Kind             | What to log                                          |
|-------------------------------------------|---------|------------------|------------------------------------------------------|
| `convex/agent.ts` director generateText   | Beta    | `groq.director`  | `tokensIn`, `tokensOut`, `costCents = groqCostCents(...)` |
| `convex/agent.ts` sub-agent generateText  | Beta    | `groq.subagent`  | same                                                 |
| `convex/chat.ts` intro generateText       | Beta    | `groq.intro`     | same                                                 |
| `convex/memoryExtract.ts` generateText    | Beta    | `groq.memory`    | same                                                 |
| `convex/moderation.ts` Llama-Guard call   | Zeta    | `groq.moderation`| same — wire inside `checkPrompt` after the await      |
| `convex/tts.ts` Sarvam TTS request        | Gamma   | `sarvam.tts`     | `chars`, `audioMs`, `costCents = sarvamCostCents(...)` |
| `convex/tts.ts` Whisper alignment         | Gamma   | `groq.whisper`   | `audioMs`, `costCents` (Groq Whisper rate; treat as `groq.whisper` kind, compute via per-second rate or stub 0 until provider rate is finalized) |

The `userId` passed to `record` must come from the authenticated thread
owner, NOT from the auth identity at the call site (some sub-agent paths
run under a system identity). Use `internal.threads.getOwnerByAgentThread`
or `internal.explanations.getOwner` if you don't already have it in scope.

`threadId` is optional but should be set whenever the call is on a per-
thread codepath (not on global background work).

---

## Optional polish

### [ ] Wire `internal.users.isAnonymous` for `ttsPerAnonymousUser` limiter

Gamma's `convex/rateLimiter.ts` has a `ttsPerAnonymousUser` bucket that's
defined-but-unused. Inside `convex/tts.ts`'s TTS entrypoint, after
resolving the explanation owner, branch:

```ts
const isAnon: boolean = await ctx.runQuery(
  internal.users.isAnonymous,
  { userId: ownerId },
);
const bucket = isAnon ? "ttsPerAnonymousUser" : "ttsPerUser";
await rateLimiter.limit(ctx, bucket, { key: ownerId, throws: true });
```

### [ ] Auth user-row deletion in `users.deleteMe`

`@convex-dev/auth` does not yet expose a stable `auth.deleteAccount` from
the action ctx. When/if it does, append:

```ts
await auth.deleteAccount(ctx);
```

…to the bottom of `users:deleteMe`. Until then, OPERATIONS.md §2.4
documents the manual cleanup step.
