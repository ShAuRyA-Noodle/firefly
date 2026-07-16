import { useEffect, useRef } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { SkillRouter } from '../components/SkillRouter'
import { PrintFrame } from '../components/PrintFrame'
import { PresenceBar } from '../components/PresenceBar'

export const Route = createFileRoute('/share/$slug')({
  component: SharedThreadPage,
  validateSearch: (search: Record<string, unknown>) => {
    // Coerce ?print=1 / ?print=true → boolean. Anything else → false.
    const raw = search.print
    const print =
      raw === '1' || raw === 1 || raw === 'true' || raw === true || false
    return { print: Boolean(print) }
  },
})

/**
 * Public read-only thread view.
 *
 * No auth gate, no PromptInput, no avatar, no branch button. Anyone with the
 * slug can read; revoking the slug server-side flips this to a 404 on next
 * reactive update. Server projects out userId/messageId so the viewer never
 * learns who owns the thread.
 *
 * ActionCards inside UIRenderer ARE clickable but their onClick handler is
 * unset here — the action context never resolves so they no-op. Acceptable
 * static behavior for a shared snapshot. (Wiring them to "fork into a new
 * authed session" would require sign-in, which contradicts the public-read
 * pattern.)
 *
 * Print mode (?print=1):
 *   - Renders a paper-styled, light-background, print-friendly view.
 *   - Auto-fires window.print() once after the data resolves so the user
 *     hits "save as PDF" in the OS print dialog. Browser-native PDF export
 *     is the entire pipeline — no Remotion, no server-side rendering.
 *   - Re-prints suppressed via a ref so a reactive update from Convex doesn't
 *     pop the print dialog repeatedly.
 */
function SharedThreadPage() {
  const { slug } = Route.useParams()
  const { print } = Route.useSearch()
  const data = useQuery(api.share.getSharedThread, { slug })
  const printedRef = useRef(false)

  useEffect(() => {
    // Only fire print once per page load, only after data has resolved
    // (data === null means "404, don't print" and data === undefined means
    // "still loading"). window.print() is a blocking modal in most browsers,
    // so guarding against re-entry is essential.
    if (!print) return
    if (printedRef.current) return
    if (data === undefined || data === null) return
    printedRef.current = true
    // Defer to next paint so the DOM has actually committed before the OS
    // dialog snapshots the page. requestAnimationFrame + a microtask gives
    // Excalidraw + image loaders one frame to settle.
    const id = requestAnimationFrame(() => {
      try {
        window.print()
      } catch {
        // Some headless / sandboxed contexts disallow print. Silent.
      }
    })
    return () => cancelAnimationFrame(id)
  }, [print, data])

  if (data === undefined) {
    // Loading
    return (
      <div className="canvas flex items-center justify-center px-6">
        <div className="font-mono text-crimson text-[11px] tracking-[0.32em] uppercase loading-breathe">
          loading
        </div>
      </div>
    )
  }

  if (data === null) {
    return (
      <div className="canvas flex items-center justify-center px-6">
        <div className="max-w-md w-full text-center space-y-5">
          <p className="kicker text-crimson">404</p>
          <h1 className="display-title text-5xl text-bone">
            SHARE NOT FOUND
          </h1>
          <p className="text-ash text-xs font-mono tracking-wide">
            this link is invalid or has been revoked.
          </p>
          <Link to="/" className="btn-crimson inline-block">
            try firefly
          </Link>
        </div>
      </div>
    )
  }

  if (print) {
    return (
      <div
        className="print-mode"
        style={{
          background: '#fff',
          color: '#000',
          minHeight: '100vh',
          padding: '24px 28px',
          maxWidth: 760,
          margin: '0 auto',
          fontFamily: "'Space Grotesk', system-ui, sans-serif",
        }}
      >
        <header
          data-no-print
          style={{
            borderBottom: '1px solid #ccc',
            paddingBottom: 8,
            marginBottom: 18,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: 10,
                letterSpacing: '0.24em',
                textTransform: 'uppercase',
                color: '#666',
              }}
            >
              firefly · printable
            </div>
            <h1
              style={{
                fontFamily: "'Big Shoulders Display', sans-serif",
                fontSize: 28,
                margin: '4px 0 0',
                color: '#000',
                textTransform: 'uppercase',
                letterSpacing: '-0.01em',
                lineHeight: 1,
              }}
            >
              {data.title ?? '(untitled)'}
            </h1>
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            data-no-print
            style={{
              fontFamily: 'monospace',
              fontSize: 11,
              padding: '8px 12px',
              background: '#000',
              color: '#fff',
              border: 0,
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
            }}
          >
            print or save as PDF
          </button>
        </header>

        {/* Print-only header (visible in PDF, hidden onscreen via @media print toggle below) */}
        <div className="print-only-title" style={{ display: 'none' }}>
          <h1
            style={{
              fontFamily: "'Big Shoulders Display', sans-serif",
              fontSize: 32,
              margin: 0,
              color: '#000',
              textTransform: 'uppercase',
            }}
          >
            {data.title ?? '(untitled)'}
          </h1>
          <hr style={{ border: 0, borderTop: '2px solid #000', margin: '10px 0 18px' }} />
        </div>

        {data.frames.length === 0 ? (
          <p style={{ fontFamily: 'monospace', fontSize: 12 }}>no frames in this share.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {data.frames.map((frame, i) => (
              <PrintFrame
                key={frame._id}
                frame={{
                  _id: frame._id as string,
                  skill: frame.skill,
                  config: frame.config,
                  narration: frame.narration ?? null,
                  step: frame.step ?? null,
                }}
                index={i}
                total={data.frames.length}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="canvas px-6 py-8 max-w-3xl mx-auto" style={{ overflow: 'auto' }}>
      <header className="mb-10 flex items-end justify-between gap-4 border-b border-white/5 pb-4">
        <div className="min-w-0">
          <p className="kicker text-crimson">shared explanation</p>
          <h1 className="display-title text-3xl md:text-4xl text-bone truncate">
            {data.title ?? '(untitled)'}
          </h1>
          {/* Live viewer indicator. Anonymous, capped, 15s heartbeats.
              Hidden in print mode via the @media print stylesheet. */}
          <div className="mt-2" data-no-print>
            <PresenceBar roomKey={slug} />
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {/* Plain anchor (not typed Link) — the typed router tree may
              not have picked up the print search-param schema yet, and
              `validateSearch` already accepts ?print=1 at runtime. Using
              <a> avoids the FileRoutesByPath generic friction. */}
          <a
            href={`/share/${slug}?print=1`}
            data-no-print
            className="text-[10px] uppercase tracking-[0.24em] text-ash hover:text-crimson transition font-mono"
          >
            save as PDF
          </a>
          <Link
            to="/"
            data-no-print
            className="text-[10px] uppercase tracking-[0.24em] text-ash hover:text-crimson transition font-mono"
          >
            try firefly →
          </Link>
        </div>
      </header>

      {/*
        Presence row — anonymous viewers can see "N watching" without auth.
        Mounted only on the non-print render so it never bleeds into the
        PDF view. roomKey is the slug; the server prefixes it with
        "share:" to namespace it away from owner-side rooms.
      */}
      <div className="-mt-6 mb-6" data-no-print>
        <PresenceBar roomKey={slug} />
      </div>

      {data.frames.length === 0 ? (
        <p className="text-smoke text-xs font-mono">no frames in this share.</p>
      ) : (
        <div className="space-y-12">
          {data.frames.map((frame, i) => (
            <article key={frame._id} className="space-y-4">
              <div className="flex items-baseline justify-between">
                <span className="kicker text-crimson">{frame.skill}</span>
                <span className="font-mono text-[10px] tracking-[0.24em] uppercase text-ash">
                  {String(i + 1).padStart(2, '0')} / {String(data.frames.length).padStart(2, '0')}
                </span>
              </div>
              <SkillRouter
                explanation={{
                  _id: frame._id as string,
                  skill: frame.skill,
                  config: frame.config,
                  narration: frame.narration ?? undefined,
                  step: frame.step ?? undefined,
                }}
                // No onAction — this is read-only. ActionCards visually
                // render but their callback is null so clicks no-op.
              />
              {frame.narration && (
                <aside
                  className="border-l border-crimson/40 pl-4 pr-2 py-2"
                  aria-label="Narration"
                >
                  <p className="text-bone text-sm font-mono leading-relaxed">
                    <span className="text-crimson mr-2">/</span>
                    {frame.narration}
                  </p>
                  {frame.audioUrl && (
                    <audio
                      controls
                      preload="metadata"
                      className="mt-3 w-full"
                      src={frame.audioUrl}
                    >
                      <track kind="captions" />
                    </audio>
                  )}
                </aside>
              )}
            </article>
          ))}
        </div>
      )}

      <footer className="mt-16 pt-6 border-t border-white/5 text-center" data-no-print>
        <p className="text-[10px] font-mono text-smoke tracking-[0.18em] uppercase">
          made with firefly · ai may be wrong
        </p>
      </footer>
    </div>
  )
}
