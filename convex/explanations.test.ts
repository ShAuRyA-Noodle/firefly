/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, test, expect } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("explanations internal queries + mutations", () => {
  test("create stores a row with the provided userId and stamps createdAt", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u" } as never),
    );

    const id = await t.mutation(internal.explanations.create, {
      threadId: "thread-1",
      userId,
      skill: "ui",
      config: JSON.stringify({ component: "Text", children: "hi" }),
      step: 1,
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(userId);
    expect(row!.skill).toBe("ui");
    expect(typeof row!.createdAt).toBe("number");
  });

  test("countNonDoneForThread excludes _done, intro, and tombstones", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u" } as never),
    );

    await t.mutation(internal.explanations.create, {
      threadId: "x",
      userId,
      skill: "manim",
      config: "{}",
      step: 1,
    });
    await t.mutation(internal.explanations.create, {
      threadId: "x",
      userId,
      skill: "intro",
      config: "{}",
      step: 0,
    });
    await t.mutation(internal.explanations.create, {
      threadId: "x",
      userId,
      skill: "ui",
      config: "{}",
      step: 2,
    });

    // Tombstone the manim row directly.
    const manimRow = await t.run(async (ctx) =>
      ctx.db
        .query("explanations")
        .filter((q) => q.eq(q.field("skill"), "manim"))
        .first(),
    );
    await t.run(async (ctx) =>
      ctx.db.patch(manimRow!._id, { deletedAt: Date.now() }),
    );

    const count = await t.query(internal.explanations.countNonDoneForThread, {
      threadId: "x",
    });
    // intro excluded, manim tombstoned, ui counted -> 1
    expect(count).toBe(1);
  });

  test("markDone inserts a sentinel row with totalFrames metadata", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u" } as never),
    );

    await t.mutation(internal.explanations.markDone, {
      threadId: "d",
      userId,
      totalFrames: 4,
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("explanations")
        .filter((q) => q.eq(q.field("threadId"), "d"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].skill).toBe("_done");
    expect(JSON.parse(rows[0].config)).toEqual({ totalFrames: 4 });
  });

  test("getOwner returns the userId for an existing row and null otherwise", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u" } as never),
    );
    const id = await t.mutation(internal.explanations.create, {
      threadId: "g",
      userId,
      skill: "ui",
      config: "{}",
    });

    const owner = await t.query(internal.explanations.getOwner, {
      explanationId: id,
    });
    expect(owner).toBe(userId);
  });
});
