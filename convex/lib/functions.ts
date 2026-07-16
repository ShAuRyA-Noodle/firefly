/**
 * Authenticated function wrappers.
 *
 * Replaces the repeated `const userId = await getAuthUserId(ctx); if (!userId)
 * throw new Error("Not authenticated");` prelude with composable variants that
 * (a) make the `userId` available to the handler and (b) narrow its type to
 * `Id<"users">` so downstream db.get / index ops stay type-safe.
 *
 * Usage:
 *   export const listMine = authedQuery({
 *     args: {},
 *     handler: async (ctx) => {
 *       // ctx.userId is Id<"users"> here — no null checks.
 *     },
 *   });
 */

import {
  customQuery,
  customMutation,
  customAction,
} from "convex-helpers/server/customFunctions";
import {
  query as rawQuery,
  mutation as rawMutation,
  action as rawAction,
} from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

export const authedQuery = customQuery(rawQuery, {
  args: {},
  input: async (ctx, _args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return { ctx: { userId }, args: {} };
  },
});

export const authedMutation = customMutation(rawMutation, {
  args: {},
  input: async (ctx, _args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return { ctx: { userId }, args: {} };
  },
});

export const authedAction = customAction(rawAction, {
  args: {},
  input: async (ctx, _args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return { ctx: { userId }, args: {} };
  },
});
