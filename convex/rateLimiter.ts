// Per-user rate limiter. Keyed by userId for question sending, by
// explanationId for TTS so a single runaway frame can't drain the daily
// Sarvam quota for everyone.
import { RateLimiter, HOUR, MINUTE, DAY } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // User-initiated question send: steady drip, small burst.
  sendQuestion: {
    kind: "token bucket",
    rate: 30,
    period: HOUR,
    capacity: 30,
  },
  // Global TTS budget — protects Sarvam quota from a planner that fans out
  // way too many frames per thread. Per-user (key=userId) so one abusive
  // user can't starve others.
  ttsPerUser: {
    kind: "token bucket",
    rate: 200,
    period: HOUR,
    capacity: 60,
  },
  // Belt-and-suspenders for the same user hammering TTS within a minute.
  ttsPerUserMinute: {
    kind: "fixed window",
    rate: 20,
    period: MINUTE,
  },
  // Lower TTS ceiling for anonymous (guest) users — Sarvam minutes are
  // expensive and we don't want a botnet of fresh anonymous sessions to
  // burn through the daily quota. Wire when an `isAnonymous(userId)`
  // helper exists in convex/users.ts (Zeta-owned). Until then this is
  // defined-but-unused — safe to ship.
  ttsPerAnonymousUser: {
    kind: "token bucket",
    rate: 30,
    period: HOUR,
    capacity: 10,
  },
  // Anonymous signup gate. Convex Auth's Anonymous provider has no
  // pre-signup hook and there's no IP available inside auth ctx, so we
  // can't key per-IP. SYSTEM-wide cap instead: 100 anon signups/hour
  // across the whole deployment. Ugly but bounded — at worst an attacker
  // burns the global hour and locks ALL anonymous signup until the
  // window rolls; legitimate users get nudged toward email/Google. The
  // public action `gateAnonymousSignup` in convex/auth.ts enforces this
  // before the client calls signIn('anonymous').
  anonymousSignup: {
    kind: "fixed window",
    rate: 100,
    period: HOUR,
  },
  // Password reset flood guard. Keyed by SHA-256 hex of the email so the
  // limiter table doesn't store raw addresses. Three attempts per hour
  // per email is plenty for a real user fat-fingering their inbox; a
  // mailbomb attempt against any single account hits the wall fast.
  passwordReset: {
    kind: "fixed window",
    rate: 3,
    period: HOUR,
  },
  // Per-user daily question cap. 100 questions / 24h is a generous
  // ceiling for a real learner; a scraper or runaway client gets cut off
  // long before they drain LLM budget.
  //
  // NOTE FOR BETA: wire this in convex/chat.ts `sendMessage` and
  // `sendMessageStreaming`:
  //   await rateLimiter.limit(ctx, "dailyQuestions",
  //     { key: ctx.userId, throws: true });
  // Place it next to the existing `sendQuestion` limit calls (lines 83
  // and 130 as of this commit). Order doesn't matter — both throw on
  // overage.
  dailyQuestions: {
    kind: "fixed window",
    rate: 100,
    period: DAY,
  },
});
