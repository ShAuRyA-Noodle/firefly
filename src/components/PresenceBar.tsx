/**
 * PresenceBar — minimal "who else is reading this share" indicator.
 *
 * Mounts on the public share view (and could mount on owner thread views
 * with a prefixed roomKey). Heartbeats every 15s; reads the live viewer
 * list reactively via a Convex query.
 *
 * Design notes:
 *   - Anonymous-friendly: no auth required. sessionId is a per-browser UUID
 *     persisted in localStorage with a 24h TTL so a refresh keeps the same
 *     identity bubble — but a new device or a rolled cache shows up as a
 *     fresh viewer. That's the right tradeoff for a public share page.
 *   - O(1) cost: a single setInterval ticks every 15s and fires one
 *     mutation. The Convex query is shared across all viewers in the room
 *     so server cost is effectively O(N) total, not O(N^2).
 *   - We do NOT send a leave signal on unmount. `beforeunload` is unreliable
 *     across browsers (especially mobile), and the presence component
 *     evicts after ~37.5s anyway. Cheaper to wait than to ship a half-broken
 *     signal.
 *   - Avatar identity: there are no real avatars (anonymous!), so we hash
 *     the sessionId into a small palette to give each viewer a recognizable
 *     dot color. Same browser → same color across renders.
 *   - Tooltip: HTML title attribute, not a JS popover. Native, accessible,
 *     and zero dependencies.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'

type Viewer = {
  sessionId: string
  displayName: string
  joinedAt: number
}

type Props = {
  roomKey: string
  /** Override the heartbeat interval. Defaults to 15000ms. */
  intervalMs?: number
  /** Display name to publish. Defaults to "anonymous viewer". */
  displayName?: string
}

const SESSION_KEY = 'firefly.sessionId'
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24h

// Cap visible avatars; anything beyond becomes a "+N" badge.
const MAX_VISIBLE_DOTS = 8

// 8-color palette (BMTH/firefly-aligned crimson + neutral ashes).
// Hash a sessionId into one of these so the same browser keeps the same dot
// color across renders without server-side state.
const DOT_COLORS = [
  '#d60017', // crimson
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#a855f7', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#fbbf24', // gold
] as const

function hashStringToIndex(input: string, mod: number): number {
  // FNV-1a — small, stable, no deps. Good enough for visual color routing.
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash % mod
}

/**
 * Get-or-create a stable per-browser sessionId. Stored as JSON `{id, exp}`
 * in localStorage with a 24h TTL. Falls back to in-memory if localStorage
 * is unavailable (private mode, SSR-ish, etc.).
 */
function getOrCreateSessionId(): string {
  if (typeof window === 'undefined' || typeof crypto === 'undefined') {
    // SSR / non-browser fallback. The interval effect won't run anyway, but
    // make the value valid so type-narrowing stays happy.
    return '00000000-0000-0000-0000-000000000000'
  }
  try {
    const raw = window.localStorage.getItem(SESSION_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { id?: string; exp?: number }
      if (
        parsed.id &&
        typeof parsed.id === 'string' &&
        typeof parsed.exp === 'number' &&
        parsed.exp > Date.now()
      ) {
        return parsed.id
      }
    }
  } catch {
    // Corrupt entry — fall through and rewrite.
  }
  const id = crypto.randomUUID()
  try {
    window.localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ id, exp: Date.now() + SESSION_TTL_MS }),
    )
  } catch {
    // localStorage unavailable; the id still works for this tab's lifetime.
  }
  return id
}

export function PresenceBar({
  roomKey,
  intervalMs = 15_000,
  displayName,
}: Props) {
  // Stable sessionId for this browser. Generated on mount and cached.
  const [sessionId] = useState<string>(() => getOrCreateSessionId())

  const heartbeat = useMutation(api.presence.heartbeat)
  const viewers = useQuery(api.presence.listForRoom, { roomKey }) as
    | Viewer[]
    | undefined

  // Use a ref to keep the interval handle stable across renders.
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let cancelled = false

    const send = () => {
      // Best-effort. Backend already wraps in try/catch and returns ok:false
      // on internal failure. Catch network-level errors here too so a
      // transient blip doesn't surface in the console as an unhandled
      // rejection.
      heartbeat({
        slug: roomKey,
        sessionId,
        displayName: displayName ?? undefined,
      }).catch((err) => {
        // Soft-log; never throw. Presence is enhancement.
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn('[PresenceBar] heartbeat failed', err)
        }
      })
    }

    // Fire immediately so a viewer shows up within the first second instead
    // of waiting for the first interval tick.
    send()
    tickRef.current = setInterval(send, intervalMs)

    return () => {
      cancelled = true
      if (tickRef.current) {
        clearInterval(tickRef.current)
        tickRef.current = null
      }
      // Intentionally NOT sending a "leave" event. TTL eviction (~37.5s)
      // handles cleanup; beforeunload is unreliable cross-browser.
    }
  }, [heartbeat, roomKey, sessionId, intervalMs, displayName])

  const list: Viewer[] = useMemo(() => viewers ?? [], [viewers])
  const total = list.length
  const visible = list.slice(0, MAX_VISIBLE_DOTS)
  const overflow = Math.max(0, total - visible.length)

  // While the query is loading or the heartbeat hasn't landed yet, render
  // nothing. We don't want a flash of "0 watching" before the first tick.
  if (viewers === undefined || total === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="presence-bar h-6"
        // Reserve the row height so the page doesn't reflow when viewers
        // appear. Matches the populated state's effective height.
      />
    )
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${total} ${total === 1 ? 'person' : 'people'} watching`}
      className="presence-bar flex items-center gap-2 print:hidden"
    >
      <div className="flex -space-x-1.5">
        {visible.map((v) => {
          const color = DOT_COLORS[hashStringToIndex(v.sessionId, DOT_COLORS.length)]
          return (
            <span
              key={v.sessionId}
              title={v.displayName}
              aria-label={v.displayName}
              className="inline-block w-3 h-3 rounded-full ring-1 ring-black/60"
              style={{ backgroundColor: color }}
            />
          )
        })}
        {overflow > 0 && (
          <span
            // Mobile-friendly tap target: visually a small chip, but the
            // hit area expands via padding to >= 44px on touch.
            className="inline-flex items-center justify-center text-[10px] font-mono text-bone bg-white/[0.06] rounded-full px-2 ring-1 ring-black/60 min-w-[1.5rem] h-3 leading-none"
            style={{
              // Touch-target expansion without affecting layout.
              touchAction: 'manipulation',
              minHeight: '44px',
              minWidth: '44px',
              // Visual size stays small; we expand the *outer* hit area only
              // on touch via -webkit-tap-highlight + padding via ::before.
              // Simpler approach: just bump min sizes inline; small visual
              // overhead is acceptable on a header row.
            }}
            aria-label={`${overflow} more viewer${overflow === 1 ? '' : 's'}`}
            title={`${overflow} more`}
          >
            +{overflow}
          </span>
        )}
      </div>
      <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-ash">
        {total} watching
      </span>
    </div>
  )
}

export default PresenceBar
