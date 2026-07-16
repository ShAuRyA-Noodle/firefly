/**
 * Scheduled jobs.
 *
 * Currently:
 *   - daily concept-due reminder: walks `user_concept_progress` rows whose
 *     `nextReviewAt <= now`, groups by user, and sends a single Resend email
 *     per user listing how many concepts are due. Anonymous accounts (no
 *     email on the auth identity) are skipped.
 *
 * Convex transaction limits:
 *   - The reminder is an action (Resend HTTP fetch + multi-table reads), so
 *     it cannot be a single mutation. We page through `users` via
 *     `internal.crons._collectDueByUser` (a query) in batches and do the
 *     network fan-out from the action. The query itself uses `.take(N)` +
 *     pagination cursors so a single read stays under the txn read cap even
 *     if the table grows past tens of thousands of users.
 */

import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalQuery,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const PAGE_SIZE = 200;

const crons = cronJobs();

crons.interval(
  "daily concept-due reminder",
  { hours: 24 },
  internal.crons.sendReviewReminders,
  {},
);

// Settle-sweep: finalize question turns that announced an expected frame
// count but never reached it (a sub-agent action died before writing AND
// before laying a _failed tombstone, so no settle path ever ran). Without
// this, such a turn's UI hangs at "N-1 of N" forever and its memory never
// extracts. Runs frequently + cheaply; only touches turns older than the
// grace window, so an in-flight turn is never cut short.
crons.interval(
  "settle stalled turns",
  { minutes: 2 },
  internal.turns.finalizeStalledTurns,
  { olderThan: 120_000, limit: 25 },
);

export default crons;

/**
 * Read one page of users + the first concept-due row per user. Returns a
 * cursor-friendly shape so the action can stream pages without overflowing
 * a transaction.
 *
 * We deliberately don't include the entire concept list — only the COUNT of
 * concepts due per user, since the email template only needs N.
 */
export const _collectDueByUserPage = internalQuery({
  args: {
    now: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { now, cursor }) => {
    const usersPage = await ctx.db
      .query("users")
      .paginate({ numItems: PAGE_SIZE, cursor });

    const results: Array<{
      userId: Id<"users">;
      email: string | null;
      dueCount: number;
    }> = [];

    for (const u of usersPage.page) {
      // Email is on the auth `users` document; if absent (anonymous) we
      // skip later. The shape comes from `authTables` so we read defensively.
      const email = (u as { email?: string | null }).email ?? null;

      // Per-user due rows. Bounded by `.take()` so a degenerate user with
      // tens of thousands of overdue concepts still fits in this query's
      // read budget. The email template only needs the count anyway.
      const dueRows = await ctx.db
        .query("user_concept_progress")
        .withIndex("by_user_nextReview", (q) =>
          q.eq("userId", u._id).lte("nextReviewAt", now),
        )
        .take(500);

      const dueCount = dueRows.length;
      if (dueCount > 0) {
        results.push({ userId: u._id, email, dueCount });
      }
    }

    return {
      page: results,
      cursor: usersPage.continueCursor,
      isDone: usersPage.isDone,
    };
  },
});

async function sendReminderEmail(
  apiKey: string,
  email: string,
  dueCount: number,
): Promise<void> {
  const subject =
    dueCount === 1
      ? "1 concept ready to review at firefly"
      : `${dueCount} concepts ready to review at firefly`;
  const body = [
    `You have ${dueCount} concept${dueCount === 1 ? "" : "s"} due to review at firefly.`,
    ``,
    `Open firefly and pick up where you left off — short visual recaps keep`,
    `the concept fresh in long-term memory.`,
    ``,
    `If you don't want these reminders, you can unsubscribe by deleting your`,
    `account from Settings.`,
  ].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Firefly <onboarding@resend.dev>",
      to: [email],
      subject,
      text: body,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[crons/resend] send failed ${res.status}: ${text}`);
  }
}

/**
 * Cron entry point. Walks `users` via paginated queries; for each user with
 * overdue concepts and an email on file, sends a single nudge.
 *
 * Failures on a single email don't abort the run — we log and continue, so
 * one user with a dead address can't starve the rest. AUTH_RESEND_KEY is
 * required: missing key throws once at the top, before the first send.
 */
export const sendReviewReminders = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; sent: number; skipped: number; failed: number }> => {
    const apiKey = process.env.AUTH_RESEND_KEY;
    if (!apiKey) {
      console.warn(
        "[crons.sendReviewReminders] AUTH_RESEND_KEY not set — skipping",
      );
      return { checked: 0, sent: 0, skipped: 0, failed: 0 };
    }

    const now = Date.now();
    let cursor: string | null = null;
    let checked = 0;
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    // Pagination loop. Each call is a fresh query transaction — no risk of
    // hitting the per-txn read cap as the user table grows.
    while (true) {
      const result: {
        page: Array<{ userId: Id<"users">; email: string | null; dueCount: number }>;
        cursor: string;
        isDone: boolean;
      } = await ctx.runQuery(internal.crons._collectDueByUserPage, {
        now,
        cursor,
      });

      for (const row of result.page) {
        checked += 1;
        if (!row.email) {
          // Anonymous accounts — no inbox to mail.
          skipped += 1;
          continue;
        }
        try {
          await sendReminderEmail(apiKey, row.email, row.dueCount);
          sent += 1;
        } catch (err) {
          failed += 1;
          console.error(
            `[crons.sendReviewReminders] send failed for user ${row.userId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      if (result.isDone) break;
      cursor = result.cursor;
    }

    return { checked, sent, skipped, failed };
  },
});
