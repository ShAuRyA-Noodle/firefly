// App schema: auth tables + skills + explanations + thread ownership.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  ...authTables,

  skills: defineTable({
    name: v.string(),
    description: v.string(),
    domains: v.array(v.string()),
    parentSkillName: v.optional(v.string()),
    depth: v.number(),
    hasChildren: v.boolean(),
    filePath: v.string(),
    contentHash: v.string(),
    syncedAt: v.optional(v.number()),
  })
    .index("by_name", ["name"])
    .index("by_depth", ["depth"])
    .index("by_parent", ["parentSkillName"]),

  skill_files: defineTable({
    skillName: v.string(),
    path: v.string(),
    content: v.string(),
    contentHash: v.string(),
    syncedAt: v.optional(v.number()),
  })
    .index("by_skill_path", ["skillName", "path"])
    .index("by_skill", ["skillName"]),

  threads: defineTable({
    agentThreadId: v.string(),
    userId: v.id("users"),
    createdAt: v.number(),
    // First-question title; updated after the first done fires.
    title: v.optional(v.string()),
    // Director announces the expected frame count via done(totalFrames=N).
    // Sub-agents race in parallel — the last one to render a frame sees
    // count == expectedFrames and inserts the _done sentinel. This lets us
    // parallelize dispatch without the UI flipping "done" early.
    expectedFrames: v.optional(v.number()),
    // Once _done has been inserted for this thread, don't insert again.
    doneMarkedAt: v.optional(v.number()),
    // Branching: a thread created as a follow-up points at the parent
    // thread + the specific frame the user branched from. null on roots.
    parentThreadId: v.optional(v.id("threads")),
    anchorFrameId: v.optional(v.id("explanations")),
    // Atomic dispatch slot counter — incremented in tryDispatchSlot before
    // scheduling a sub-agent. Replaces the optimistic countNonDoneForThread
    // precheck (which races against in-flight dispatches that haven't yet
    // written explanations rows). Reset alongside expectedFrames.
    inflightDispatched: v.optional(v.number()),
    // Pointer to the active `turns` row — the question currently being
    // answered. Set by startTurn on every new prompt; read by the dispatch
    // path (which only has the agentThreadId) to find the turn to charge a
    // slot against. The legacy expectedFrames/doneMarkedAt/inflightDispatched
    // fields above are retained only for back-compat with pre-turns rows and
    // are no longer written on the live path.
    currentTurnId: v.optional(v.id("turns")),
    // User-archived threads — hidden from the default listMine view.
    archivedAt: v.optional(v.number()),
  })
    .index("by_agent_thread", ["agentThreadId"])
    .index("by_user", ["userId"])
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_parent_thread", ["parentThreadId"]),

  // Per-question turn state. A single thread hosts many questions (the
  // original prompt + every ActionCard follow-up). Each question is one
  // `turns` row, which owns the per-question settle counters that used to
  // live (single-valued) on the thread row — moving them here isolates
  // concurrent questions so a late-finishing frame from question 1 can
  // never settle against question 2's plan. `turnId` = this row's _id;
  // frames stamp it so every count/dedup/settle scopes to one question.
  turns: defineTable({
    threadId: v.string(), // agentThreadId this turn belongs to
    userId: v.id("users"),
    // 1-based, monotonic per thread — drives append-order frame grouping.
    turnIndex: v.number(),
    // Director's dispatched-slot count for THIS turn. Set at done() time to
    // the actual number of slots reserved (not the LLM-announced total), so
    // a miscount can never strand the turn waiting for a frame that will
    // never land.
    expectedFrames: v.optional(v.number()),
    // Atomic dispatch counter for this turn's frame cap.
    inflightDispatched: v.number(),
    // Set once the _done sentinel is inserted for this turn.
    doneMarkedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_thread", ["threadId"])
    .index("by_thread_index", ["threadId", "turnIndex"])
    // Sweep support: open turns (doneMarkedAt undefined) ordered by age so
    // the settle-sweep cron can finalize ones stuck past a timeout.
    .index("by_open", ["doneMarkedAt", "createdAt"]),

  // Per-user learning memory. Compact, human-readable one-liners summarizing
  // what the user asked + what they learned, stored post-done by an extractor
  // action. Injected into the director prompt as "prior context" so a
  // follow-up question can reference earlier concepts without redundancy.
  user_memories: defineTable({
    userId: v.id("users"),
    threadId: v.string(),
    // The specific question this memory summarizes. One memory per turn now
    // (a thread accrues many). Optional for pre-turns rows. Dedup key on the
    // live path so re-settles don't double-insert.
    turnId: v.optional(v.id("turns")),
    summary: v.string(),
    concepts: v.array(v.string()),
    createdAt: v.number(),
  })
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_thread", ["threadId"])
    .index("by_turn", ["turnId"]),

  // Per-user skill exposure counter. Incremented whenever a frame with a
  // given skill lands; powers the skill tree + "try X next" suggestions.
  user_skill_progress: defineTable({
    userId: v.id("users"),
    skill: v.string(),
    exposures: v.number(),
    lastSeenAt: v.number(),
  }).index("by_user_skill", ["userId", "skill"]),

  // Per-attempt quiz answers. Aggregated for "recent score" + per-concept
  // mastery feedback. Insert-only — re-attempts of the same quiz frame are
  // recorded as fresh rows so progression over time is visible.
  quiz_attempts: defineTable({
    userId: v.id("users"),
    threadId: v.string(),
    explanationId: v.id("explanations"),
    questionIndex: v.number(),
    correct: v.boolean(),
    selectedAnswer: v.string(),
    correctAnswer: v.string(),
    concept: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_explanation", ["explanationId"]),

  // Concept-level progression — one row per (user, concept). Concepts are
  // extracted per-thread by the memory extractor; future recommendation
  // and spaced-repetition logic reads from this.
  user_concept_progress: defineTable({
    userId: v.id("users"),
    concept: v.string(),
    exposures: v.number(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    // Review schedule — next time this concept should resurface as an
    // ActionCard. Populated by the spaced-repetition scheduler (Phase 3).
    nextReviewAt: v.optional(v.number()),
  })
    .index("by_user_concept", ["userId", "concept"])
    .index("by_user_nextReview", ["userId", "nextReviewAt"]),

  // Per-user UI/voice preferences. One row per user (enforced by callers
  // upserting on the by_user index). Optional fields so partial updates are
  // safe without rewriting unrelated knobs.
  userPreferences: defineTable({
    userId: v.id("users"),
    voice: v.optional(v.string()),
    voiceLanguage: v.optional(v.string()),
    autoplay: v.optional(v.boolean()),
    narrationSpeed: v.optional(v.number()),
    theme: v.optional(v.string()),
    reducedMotion: v.optional(v.boolean()),
    updatedAt: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  // Per-call cost + token telemetry. Insert-only firehose; aggregation reads
  // walk the by_user_ts index for per-user spend rollups, and by_kind_ts for
  // operational dashboards. costCents is required so partial logging never
  // hides spend.
  usage_events: defineTable({
    userId: v.id("users"),
    kind: v.string(), // "groq.director" | "groq.subagent" | "groq.whisper" | "sarvam.tts" | "groq.intro" | "groq.memory" | "groq.moderation"
    tokensIn: v.optional(v.number()),
    tokensOut: v.optional(v.number()),
    audioMs: v.optional(v.number()),
    chars: v.optional(v.number()),
    costCents: v.number(),
    threadId: v.optional(v.string()),
    ts: v.number(),
  })
    .index("by_user_ts", ["userId", "ts"])
    .index("by_kind_ts", ["kind", "ts"]),

  // Public read-only thread shares. Slug is the URL token; revoked flips
  // shares dark without deleting the row (preserves audit trail).
  share_links: defineTable({
    threadId: v.string(),
    userId: v.id("users"),
    slug: v.string(),
    createdAt: v.number(),
    revoked: v.optional(v.boolean()),
  })
    .index("by_slug", ["slug"])
    .index("by_thread", ["threadId"]),

  explanations: defineTable({
    threadId: v.string(),
    userId: v.id("users"),
    messageId: v.optional(v.string()),
    skill: v.string(),
    config: v.string(),
    narration: v.optional(v.string()),
    audioUrl: v.optional(v.string()),
    audioStorageId: v.optional(v.id("_storage")),
    audioTimings: v.optional(v.string()),
    step: v.optional(v.number()),
    createdAt: v.number(),
    // The question (turn) this frame belongs to. Optional for back-compat
    // with rows written before turns existed (they render as an untitled
    // leading group). All new frames carry it. Scopes dedup + settle so
    // follow-up questions on the same thread don't collide on `step`.
    turnId: v.optional(v.id("turns")),
    // Denormalized turn ordinal so getByThread can sort (turnIndex, step)
    // without a join per row.
    turnIndex: v.optional(v.number()),
    // V2: a branched follow-up points at the frame it branched from.
    // Null/absent for root explanations in a thread.
    parentId: v.optional(v.id("explanations")),
    // Soft delete — keeps row for ancestor references in branched trees
    // while removing it from the user's active view.
    deletedAt: v.optional(v.number()),
  })
    .index("by_thread", ["threadId"])
    .index("by_message", ["messageId"])
    .index("by_user_thread", ["userId", "threadId"])
    .index("by_turn", ["turnId"])
    .index("by_parent", ["parentId"]),
});
