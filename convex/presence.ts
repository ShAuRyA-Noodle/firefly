/**
 * Presence — Phase 5 collaboration substrate.
 *
 * Wraps `@convex-dev/presence` so anonymous viewers of a public share page
 * (and authed owners of their own threads) can be enumerated as "currently
 * watching" without auth. Future Phase 5 work (cursors, role permissions,
 * live editing) layers on top of this — do NOT expand this surface for those
 * features here; build them as separate components/files.
 *
 * Room-key conventions (a single namespaced string):
 *   - "share:<slug>"           — public share view (anonymous viewers OK)
 *   - "owner:<agentThreadId>"  — owner viewing their own thread (authed)
 *
 * The PresenceBar client passes the literal slug today; we prepend "share:"
 * server-side here so collisions with future namespaces are impossible.
 *
 * Heartbeat economics:
 *   - Client sends every 15s; we forward `interval=15000` to the component.
 *   - The presence component evicts a session at 2.5x the interval (~37.5s)
 *     if no heartbeat arrives, OR on graceful disconnect.
 *   - Each heartbeat is O(1) — it touches a single (room, session) row.
 *     There's no per-viewer fan-out; the component re-runs the `list` query
 *     only when membership actually changes.
 *
 * Privacy:
 *   - sessionId is a client-generated UUID, persisted in localStorage so a
 *     refresh keeps the same identity for ~24h. We never tie it to an email,
 *     IP, or auth identity. It's effectively a per-browser pseudonym scoped
 *     to a single room.
 *   - displayName defaults to "anonymous viewer". The server does not
 *     sanitize beyond truncation; the client should keep it short.
 *
 * Failure mode:
 *   - All entry points wrap the underlying component call in try/catch and
 *     return a safe default (empty list / null) on failure. Presence is an
 *     enhancement; a 5xx from the component must NEVER block the share view.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { Presence } from "@convex-dev/presence";

const presence = new Presence(components.presence);

// Heartbeat cadence advertised to the component. The client interval and
// this value must agree; if they drift, eviction may fire too early/late.
const HEARTBEAT_INTERVAL_MS = 15_000;

// Cap how many viewers we surface per room. Anything above this is unlikely
// to render usefully in a small avatar stack and would just bloat the query
// payload.
const MAX_VIEWERS = 32;

// Cap displayName length so a malicious client can't bloat presence rows.
const MAX_DISPLAY_NAME_LEN = 40;

/**
 * Map a caller-supplied roomKey ("share:<slug>" or "owner:<agentThreadId>")
 * or a bare slug into the canonical roomId we store in the component.
 *
 * Bare slugs (legacy / convenience for the PresenceBar that just gets a
 * slug from the route) are auto-prefixed with "share:".
 */
function canonicalRoomId(roomKey: string): string {
  if (roomKey.startsWith("share:") || roomKey.startsWith("owner:")) {
    return roomKey;
  }
  return `share:${roomKey}`;
}

function normalizeDisplayName(raw: string | undefined): string {
  if (!raw) return "anonymous viewer";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "anonymous viewer";
  return trimmed.length > MAX_DISPLAY_NAME_LEN
    ? trimmed.slice(0, MAX_DISPLAY_NAME_LEN)
    : trimmed;
}

/**
 * Public heartbeat. Anonymous-friendly by design — anyone with a share slug
 * can announce presence in that room.
 *
 * Args:
 *   - slug: the share slug OR a fully-namespaced roomKey ("owner:<id>" etc).
 *   - sessionId: client-generated UUID, stable across refreshes via
 *     localStorage on the client side. Acts as the per-browser identity.
 *   - displayName: optional, defaults to "anonymous viewer".
 *
 * Returns: { ok: true } on success, { ok: false } if the underlying
 * component threw. We do not surface the roomToken/sessionToken here because
 * our `listForRoom` query takes the room key directly (using the helper
 * `listRoom` API which doesn't require a token).
 */
export const heartbeat = mutation({
  args: {
    slug: v.string(),
    sessionId: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, { slug, sessionId, displayName }) => {
    const roomId = canonicalRoomId(slug);
    const userId = normalizeDisplayName(displayName);
    try {
      // The component's notion of "userId" is just a display label — we use
      // the displayName for it so the facepile/list shows something human.
      // The (roomId, sessionId) pair is what uniquely keys this presence row.
      await presence.heartbeat(
        ctx,
        roomId,
        userId,
        sessionId,
        HEARTBEAT_INTERVAL_MS,
      );
      return { ok: true as const };
    } catch (err) {
      // Presence is best-effort; never throw to the caller and risk breaking
      // the share view. Log for observability and return ok:false.
      console.warn("[presence.heartbeat] failed", err);
      return { ok: false as const };
    }
  },
});

/**
 * Public list query — returns the active viewers in a room.
 *
 * No auth: anyone with the room key (slug) can see the count. This matches
 * the share-link threat model: knowing the slug already grants read access
 * to the thread content, so leaking "5 people are watching" is strictly
 * less sensitive.
 *
 * Returns the shape promised in the agent spec:
 *   { sessionId, displayName, joinedAt }[]
 *
 * Note: the underlying component returns `{ userId, online, lastDisconnected }`,
 * where `userId` is what we set during heartbeat (the displayName) and there
 * is no first-class joinedAt. We approximate joinedAt with `lastDisconnected`
 * inverted — the component tracks "last time they went offline"; a currently
 * online member uses 0 there and we substitute Date.now() for the UI.
 */
export const listForRoom = query({
  args: { roomKey: v.string() },
  handler: async (ctx, { roomKey }) => {
    const roomId = canonicalRoomId(roomKey);
    try {
      const rows = await presence.listRoom(
        ctx,
        roomId,
        /* onlineOnly */ true,
        MAX_VIEWERS,
      );
      const now = Date.now();
      return rows.map((row) => ({
        // The component does not expose sessionId in listRoom — it exposes
        // userId (which we set to the displayName). For a stable per-row
        // key we synthesize from userId+lastDisconnected. Clients that need
        // a true sessionId can disambiguate via their own local sessionId.
        sessionId: `${row.userId}:${row.lastDisconnected}`,
        displayName: row.userId,
        joinedAt: row.lastDisconnected > 0 ? row.lastDisconnected : now,
      }));
    } catch (err) {
      console.warn("[presence.listForRoom] failed", err);
      return [] as Array<{
        sessionId: string;
        displayName: string;
        joinedAt: number;
      }>;
    }
  },
});

/**
 * Optional graceful disconnect — exposed for completeness so a client that
 * does have a sessionToken can release a slot before TTL eviction. Today's
 * PresenceBar does NOT call this on unmount (sending leave from
 * beforeunload is unreliable cross-browser, and TTL eviction handles it).
 *
 * Wrapped in try/catch for the same best-effort reason as heartbeat.
 */
export const disconnect = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    try {
      await presence.disconnect(ctx, sessionToken);
      return { ok: true as const };
    } catch (err) {
      console.warn("[presence.disconnect] failed", err);
      return { ok: false as const };
    }
  },
});
