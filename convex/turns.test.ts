/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, test, expect } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Mirror of turns.ts MAX_FRAMES_PER_THREAD — kept local so the test asserts
// the cap independently of the implementation constant.
const MAX = 4;

async function seed() {
  const t = convexTest(schema, modules);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "u" } as never),
  );
  const agentThreadId = "agent-thread-1";
  await t.run(async (ctx) =>
    ctx.db.insert("threads", {
      agentThreadId,
      userId,
      createdAt: 1,
    } as never),
  );
  return { t, userId, agentThreadId };
}

describe("turns lifecycle", () => {
  test("startTurn creates turn 1 then increments, pointing thread.currentTurnId at newest", async () => {
    const { t, agentThreadId } = await seed();

    const r1 = await t.mutation(internal.turns.startTurn, { agentThreadId });
    expect(r1.turnIndex).toBe(1);

    const afterFirst = await t.run(async (ctx) =>
      ctx.db
        .query("threads")
        .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
        .unique(),
    );
    expect(afterFirst!.currentTurnId).toBe(r1.turnId);

    const r2 = await t.mutation(internal.turns.startTurn, { agentThreadId });
    expect(r2.turnIndex).toBe(2);
    expect(r2.turnId).not.toBe(r1.turnId);

    const afterSecond = await t.run(async (ctx) =>
      ctx.db
        .query("threads")
        .withIndex("by_agent_thread", (q) => q.eq("agentThreadId", agentThreadId))
        .unique(),
    );
    expect(afterSecond!.currentTurnId).toBe(r2.turnId);
  });

  test("tryDispatchSlot charges the current turn, caps at MAX, and resets on a new turn", async () => {
    const { t, agentThreadId } = await seed();
    const turn1 = await t.mutation(internal.turns.startTurn, { agentThreadId });

    for (let i = 1; i <= MAX; i++) {
      const slot = await t.mutation(internal.turns.tryDispatchSlot, {
        agentThreadId,
      });
      expect(slot.ok).toBe(true);
      if (slot.ok) {
        expect(slot.slot).toBe(i);
        expect(slot.turnId).toBe(turn1.turnId);
        expect(slot.turnIndex).toBe(1);
      }
    }
    const over = await t.mutation(internal.turns.tryDispatchSlot, {
      agentThreadId,
    });
    expect(over.ok).toBe(false);

    // A fresh turn gets a fresh slot budget.
    await t.mutation(internal.turns.startTurn, { agentThreadId });
    const afterReset = await t.mutation(internal.turns.tryDispatchSlot, {
      agentThreadId,
    });
    expect(afterReset.ok).toBe(true);
    if (afterReset.ok) expect(afterReset.slot).toBe(1);
  });

  test("existsRenderForTurnStep isolates by turn — same step in two turns does not collide", async () => {
    const { t, userId, agentThreadId } = await seed();
    const turnA = await t.mutation(internal.turns.startTurn, { agentThreadId });

    await t.run(async (ctx) =>
      ctx.db.insert("explanations", {
        threadId: agentThreadId,
        userId,
        skill: "manim",
        config: "{}",
        step: 1,
        turnId: turnA.turnId,
        turnIndex: turnA.turnIndex,
        createdAt: 2,
      } as never),
    );

    expect(
      await t.query(internal.turns.existsRenderForTurnStep, {
        turnId: turnA.turnId,
        step: 1,
      }),
    ).toBe(true);
    expect(
      await t.query(internal.turns.existsRenderForTurnStep, {
        turnId: turnA.turnId,
        step: 2,
      }),
    ).toBe(false);

    // Second question, same step number — must NOT be seen as already rendered.
    const turnB = await t.mutation(internal.turns.startTurn, { agentThreadId });
    expect(
      await t.query(internal.turns.existsRenderForTurnStep, {
        turnId: turnB.turnId,
        step: 1,
      }),
    ).toBe(false);
  });

  test("markDoneIfSettled settles per turn using dispatched count, once", async () => {
    const { t, userId, agentThreadId } = await seed();
    const turnA = await t.mutation(internal.turns.startTurn, { agentThreadId });

    // Dispatch 2 slots, then freeze expectedFrames from the dispatch count.
    await t.mutation(internal.turns.tryDispatchSlot, { agentThreadId });
    await t.mutation(internal.turns.tryDispatchSlot, { agentThreadId });
    const exp = await t.mutation(internal.turns.setExpectedFramesFromDispatch, {
      turnId: turnA.turnId,
    });
    expect(exp.expectedFrames).toBe(2);

    const insertFrame = (step: number) =>
      t.run(async (ctx) =>
        ctx.db.insert("explanations", {
          threadId: agentThreadId,
          userId,
          skill: "manim",
          config: "{}",
          step,
          turnId: turnA.turnId,
          turnIndex: turnA.turnIndex,
          createdAt: 10 + step,
        } as never),
      );

    await insertFrame(1);
    const notYet = await t.mutation(internal.turns.markDoneIfSettled, {
      turnId: turnA.turnId,
      userId,
    });
    expect(notYet.marked).toBe(false);

    await insertFrame(2);
    const settled = await t.mutation(internal.turns.markDoneIfSettled, {
      turnId: turnA.turnId,
      userId,
    });
    expect(settled.marked).toBe(true);
    if (settled.marked) {
      expect(settled.threadId).toBe(agentThreadId);
      expect(settled.turnIndex).toBe(1);
    }

    // _done sentinel exists, stamped with the turn.
    const doneRows = await t.run(async (ctx) =>
      ctx.db
        .query("explanations")
        .withIndex("by_turn", (q) => q.eq("turnId", turnA.turnId))
        .collect(),
    );
    const done = doneRows.filter((r) => r.skill === "_done");
    expect(done).toHaveLength(1);

    // Idempotent — a second call after done does not re-mark.
    const again = await t.mutation(internal.turns.markDoneIfSettled, {
      turnId: turnA.turnId,
      userId,
    });
    expect(again.marked).toBe(false);
  });

  test("a follow-up turn settles independently of the first", async () => {
    const { t, userId, agentThreadId } = await seed();

    const turnA = await t.mutation(internal.turns.startTurn, { agentThreadId });
    await t.mutation(internal.turns.tryDispatchSlot, { agentThreadId });
    await t.mutation(internal.turns.setExpectedFramesFromDispatch, {
      turnId: turnA.turnId,
    });
    await t.run(async (ctx) =>
      ctx.db.insert("explanations", {
        threadId: agentThreadId,
        userId,
        skill: "ui",
        config: "{}",
        step: 1,
        turnId: turnA.turnId,
        turnIndex: 1,
        createdAt: 20,
      } as never),
    );
    expect(
      (await t.mutation(internal.turns.markDoneIfSettled, {
        turnId: turnA.turnId,
        userId,
      })).marked,
    ).toBe(true);

    const turnB = await t.mutation(internal.turns.startTurn, { agentThreadId });
    await t.mutation(internal.turns.tryDispatchSlot, { agentThreadId });
    await t.mutation(internal.turns.setExpectedFramesFromDispatch, {
      turnId: turnB.turnId,
    });
    // Not settled until B's frame lands.
    expect(
      (await t.mutation(internal.turns.markDoneIfSettled, {
        turnId: turnB.turnId,
        userId,
      })).marked,
    ).toBe(false);
    await t.run(async (ctx) =>
      ctx.db.insert("explanations", {
        threadId: agentThreadId,
        userId,
        skill: "ui",
        config: "{}",
        step: 1,
        turnId: turnB.turnId,
        turnIndex: 2,
        createdAt: 30,
      } as never),
    );
    expect(
      (await t.mutation(internal.turns.markDoneIfSettled, {
        turnId: turnB.turnId,
        userId,
      })).marked,
    ).toBe(true);

    const allDone = await t.run(async (ctx) =>
      ctx.db
        .query("explanations")
        .withIndex("by_thread", (q) => q.eq("threadId", agentThreadId))
        .collect(),
    );
    expect(allDone.filter((r) => r.skill === "_done")).toHaveLength(2);
  });

  test("finalizeStalledTurns closes an open turn older than the cutoff, skipping fresh and settled ones", async () => {
    const { t, userId, agentThreadId } = await seed();

    // Stalled: expected 3, only 1 frame, created long ago.
    const stalled = await t.mutation(internal.turns.startTurn, { agentThreadId });
    await t.run(async (ctx) =>
      ctx.db.patch(stalled.turnId, { expectedFrames: 3, createdAt: 1000 }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("explanations", {
        threadId: agentThreadId,
        userId,
        skill: "manim",
        config: "{}",
        step: 1,
        turnId: stalled.turnId,
        turnIndex: stalled.turnIndex,
        createdAt: 1001,
      } as never),
    );

    const result = await t.mutation(internal.turns.finalizeStalledTurns, {
      olderThan: 5000,
      limit: 50,
    });
    expect(result.finalized).toBe(1);

    const turnRow = await t.run(async (ctx) => ctx.db.get(stalled.turnId));
    expect(turnRow!.doneMarkedAt).toBeTruthy();
    const done = await t.run(async (ctx) =>
      ctx.db
        .query("explanations")
        .withIndex("by_turn", (q) => q.eq("turnId", stalled.turnId))
        .collect(),
    );
    expect(done.filter((r) => r.skill === "_done")).toHaveLength(1);

    // Running again finalizes nothing (already settled).
    const second = await t.mutation(internal.turns.finalizeStalledTurns, {
      olderThan: 5000,
      limit: 50,
    });
    expect(second.finalized).toBe(0);
  });
});
