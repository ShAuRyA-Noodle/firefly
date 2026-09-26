import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useConvexAuth, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'

export const Route = createFileRoute('/me')({ component: MePage })

function MePage() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <div className="canvas" />
  return <Gate />
}

function Gate() {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const navigate = useNavigate()
  useEffect(() => {
    if (!isLoading && !isAuthenticated) navigate({ to: '/signin' })
  }, [isLoading, isAuthenticated, navigate])
  if (isLoading || !isAuthenticated) {
    return (
      <div className="canvas flex items-center justify-center">
        <div className="font-mono text-crimson text-[11px] tracking-[0.32em] uppercase loading-breathe">
          loading
        </div>
      </div>
    )
  }
  return <Profile />
}

function Profile() {
  const threads = useQuery(api.threads.listMine, { limit: 50 })
  const progress = useQuery(api.skillProgress.myProgress, {})
  const memories = useQuery(api.memories.listMine, { limit: 50 })

  const totalExposures = progress?.skills.reduce((sum, s) => sum + s.exposures, 0) ?? 0

  return (
    <div className="canvas px-6 py-12 max-w-4xl mx-auto" style={{ overflow: 'auto' }}>
      <header className="mb-12 flex items-end justify-between">
        <div>
          <p className="kicker text-crimson">your</p>
          <h1 className="display-title text-5xl text-bone">LEARNING</h1>
          <p className="text-ash text-xs font-mono tracking-wide mt-2">
            {totalExposures} frames · {progress?.concepts.length ?? 0} concepts · {threads?.length ?? 0} threads
          </p>
        </div>
        <Link
          to="/"
          className="text-[10px] uppercase tracking-[0.24em] text-ash hover:text-crimson transition font-mono"
        >
          ← back
        </Link>
      </header>

      <section className="mb-12" aria-labelledby="skills-heading">
        <h2 id="skills-heading" className="kicker text-ash mb-4">skills</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {(progress?.skills ?? []).length === 0 ? (
            <p className="text-smoke text-xs font-mono col-span-full">
              no frames yet — ask your first question
            </p>
          ) : (
            progress?.skills
              .slice()
              .sort((a, b) => b.exposures - a.exposures)
              .map((s) => (
                <SkillBar
                  key={s.skill}
                  skill={s.skill}
                  exposures={s.exposures}
                  max={Math.max(...(progress.skills.map((x) => x.exposures)), 1)}
                />
              ))
          )}
        </div>
      </section>

      <section className="mb-12" aria-labelledby="concepts-heading">
        <h2 id="concepts-heading" className="kicker text-ash mb-4">concepts</h2>
        <div className="flex flex-wrap gap-2">
          {(progress?.concepts ?? []).length === 0 ? (
            <p className="text-smoke text-xs font-mono">
              no concepts extracted yet
            </p>
          ) : (
            progress?.concepts.map((c) => {
              const due =
                c.nextReviewAt != null && c.nextReviewAt <= Date.now()
              return (
                <span
                  key={c.concept}
                  className={`text-[11px] font-mono tracking-wide px-2.5 py-1 rounded-sm border ${
                    due
                      ? 'border-crimson/50 text-crimson bg-crimson/5'
                      : 'border-white/10 text-ash bg-white/[0.02]'
                  }`}
                  title={
                    due
                      ? 'due for review'
                      : `seen ${c.exposures}× · last ${timeAgo(c.lastSeenAt)}`
                  }
                >
                  {c.concept} · {c.exposures}
                </span>
              )
            })
          )}
        </div>
      </section>

      <section className="mb-12" aria-labelledby="threads-heading">
        <h2 id="threads-heading" className="kicker text-ash mb-4">threads</h2>
        <ul className="space-y-3">
          {(threads ?? []).length === 0 ? (
            <p className="text-smoke text-xs font-mono">no threads yet</p>
          ) : (
            threads?.map((t) => (
              <ThreadRow key={t.agentThreadId} thread={t} />
            ))
          )}
        </ul>
      </section>

      <section aria-labelledby="memory-heading">
        <h2 id="memory-heading" className="kicker text-ash mb-4">memory</h2>
        <ul className="space-y-3">
          {(memories ?? []).length === 0 ? (
            <p className="text-smoke text-xs font-mono">no memories yet</p>
          ) : (
            memories?.map((m) => (
              <li key={m._id} className="text-xs font-mono">
                <p className="text-bone leading-relaxed">
                  <span className="text-crimson mr-2">/</span>
                  {m.summary}
                </p>
                {m.concepts.length > 0 && (
                  <p className="text-smoke text-[10px] tracking-wide mt-1">
                    {m.concepts.join(' · ')}
                  </p>
                )}
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  )
}

/**
 * ThreadRow — one row in the threads list, with share affordances.
 *
 * Share state machine:
 *   - No active link → "share" button. Click → createShareLink mutation,
 *     copy URL to clipboard, surface "copied" inline feedback. The
 *     getMyShareLinkForThread reactive query then flips to "active",
 *     which reveals the "save as PDF" + "revoke" buttons.
 *   - Active link → "copy", "save as PDF", "revoke" buttons. Copy action
 *     re-uses the existing slug. Revoke flips back to no-active state.
 *
 * createShareLink is a mutation (idempotent server-side) — calling it
 * multiple times for an already-shared thread returns the same slug.
 */
function ThreadRow({
  thread,
}: {
  thread: {
    agentThreadId: string
    title: string | null
    parentAgentThreadId: string | null
    createdAt: number
  }
}) {
  // useMutation, not useAction — share.createShareLink is a mutation in
  // convex/share.ts. Earlier briefs called it an action; the actual
  // export is `authedMutation`. We dereference the api shape via the
  // generated module — `convex dev` regenerates _generated/api when
  // share.ts changes, matching how share.$slug.tsx already uses
  // api.share.getSharedThread without a cast.
  const createShare = useMutation(api.share.createShareLink)
  const revokeShare = useMutation(api.share.revokeShareLink)
  const existing = useQuery(
    api.share.getMyShareLinkForThread,
    { agentThreadId: thread.agentThreadId },
  )

  const [feedback, setFeedback] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Auto-clear inline feedback so the row doesn't stay in a confusing
  // "copied!" state forever after a successful action.
  useEffect(() => {
    if (!feedback) return
    const t = setTimeout(() => setFeedback(null), 1800)
    return () => clearTimeout(t)
  }, [feedback])

  const buildShareUrl = (slug: string, print = false) =>
    `${window.location.origin}/share/${slug}${print ? '?print=1' : ''}`

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      setFeedback(label)
    } catch {
      // clipboard API requires secure context and user gesture; in older
      // browsers / iframes this can throw. Fall back to silent failure
      // so we don't block the share flow — the user can still long-press
      // the URL bar after navigating.
      setFeedback('copy failed — open in new tab')
    }
  }

  async function onShare() {
    if (busy) return
    setBusy(true)
    try {
      const slug: string = await createShare({ agentThreadId: thread.agentThreadId })
      await copy(buildShareUrl(slug), 'copied!')
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'share failed')
    } finally {
      setBusy(false)
    }
  }

  async function onCopyExisting() {
    if (!existing) return
    await copy(buildShareUrl(existing.slug), 'copied!')
  }

  async function onCopyPdf() {
    if (!existing) return
    await copy(buildShareUrl(existing.slug, true), 'pdf link copied!')
  }

  async function onRevoke() {
    if (!existing || busy) return
    setBusy(true)
    try {
      await revokeShare({ slug: existing.slug })
      setFeedback('revoked')
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'revoke failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="border-b border-white/5 pb-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <span className="text-bone text-sm truncate">
            {thread.title ?? '(untitled)'}
          </span>
          {thread.parentAgentThreadId && (
            <span className="text-[9px] text-crimson uppercase tracking-wider font-mono shrink-0">
              branch
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {existing == null ? (
            <button
              type="button"
              onClick={onShare}
              disabled={busy}
              className="text-[10px] uppercase tracking-[0.18em] font-mono text-ash hover:text-crimson transition border border-white/10 hover:border-crimson/40 px-3 py-2 rounded-sm disabled:opacity-50"
              style={{ minHeight: 44 }}
              aria-label={`Share thread ${thread.title ?? 'untitled'}`}
            >
              share
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onCopyExisting}
                className="text-[10px] uppercase tracking-[0.18em] font-mono text-ash hover:text-crimson transition border border-white/10 hover:border-crimson/40 px-3 py-2 rounded-sm"
                style={{ minHeight: 44 }}
                aria-label="Copy share link"
              >
                copy link
              </button>
              <button
                type="button"
                onClick={onCopyPdf}
                className="text-[10px] uppercase tracking-[0.18em] font-mono text-ash hover:text-crimson transition border border-white/10 hover:border-crimson/40 px-3 py-2 rounded-sm"
                style={{ minHeight: 44 }}
                aria-label="Copy PDF print link"
              >
                save as PDF
              </button>
              <button
                type="button"
                onClick={onRevoke}
                disabled={busy}
                className="text-[10px] uppercase tracking-[0.18em] font-mono text-crimson hover:text-bone hover:bg-crimson transition border border-crimson/40 px-3 py-2 rounded-sm disabled:opacity-50"
                style={{ minHeight: 44 }}
                aria-label="Revoke share link"
              >
                revoke
              </button>
            </>
          )}
          <span className="text-[10px] font-mono text-smoke shrink-0">
            {timeAgo(thread.createdAt)}
          </span>
        </div>
      </div>
      {feedback && (
        <p
          role="status"
          aria-live="polite"
          className="text-[10px] font-mono text-crimson mt-1 tracking-wide"
        >
          {feedback}
        </p>
      )}
    </li>
  )
}

function SkillBar({
  skill,
  exposures,
  max,
}: {
  skill: string
  exposures: number
  max: number
}) {
  const pct = Math.round((exposures / max) * 100)
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-[0.18em] text-bone font-mono">
          {skill}
        </span>
        <span className="text-[10px] font-mono text-smoke">{exposures}</span>
      </div>
      <div className="h-[3px] bg-white/5 rounded-full overflow-hidden">
        <div
          className="h-full bg-crimson transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}
