import { useEffect, useMemo, useRef, useState } from 'react'
import type { BundledLanguage } from 'shiki'

/**
 * CodeRenderer — step-through code visualization.
 *
 * Loads a Shiki highlighter on demand for the requested language (cached per
 * language across renders, bounded LRU(4) to keep memory in check), renders
 * the highlighted HTML once, then animates a crimson highlight bar through
 * the configured steps. Lines outside the active step dim to ~35% opacity so
 * the eye locks on what's being narrated.
 *
 * Auto-advance interval is derived from each step's label length so steps
 * with more to read get more time. The user can click any step in the
 * caption rail to jump directly — that click pauses auto-advance for the
 * rest of the frame's lifetime (so the user isn't fighting the timer).
 */

type CodeStep = { lines: number[]; label: string }
type CodeConfig = {
  language: string
  code: string
  title?: string
  caption?: string
  steps: CodeStep[]
}

// Bounded LRU(4): each Shiki highlighter ships its own grammar and theme, so
// holding many at once eats real memory. A typical thread visits 1–2 langs;
// 4 is generous headroom. Map iteration order = insertion order, so the
// first key is the least-recently-used.
const HIGHLIGHTER_CACHE_LIMIT = 4
const HIGHLIGHTER_CACHE = new Map<string, Promise<HtmlBuilder>>()
type HtmlBuilder = (code: string, lang: string) => string

async function loadHighlighter(lang: string): Promise<HtmlBuilder> {
  const cached = HIGHLIGHTER_CACHE.get(lang)
  if (cached) {
    // Touch: delete + reinsert moves this lang to the most-recently-used end.
    HIGHLIGHTER_CACHE.delete(lang)
    HIGHLIGHTER_CACHE.set(lang, cached)
    return cached
  }
  // Evict LRU before inserting so we never exceed the cap. Note: Shiki does
  // not expose a public dispose() in this version, so we rely on GC once the
  // promise reference drops.
  if (HIGHLIGHTER_CACHE.size >= HIGHLIGHTER_CACHE_LIMIT) {
    const firstKey = HIGHLIGHTER_CACHE.keys().next().value
    if (firstKey !== undefined) HIGHLIGHTER_CACHE.delete(firstKey)
  }
  const promise: Promise<HtmlBuilder> = (async () => {
    const shiki = await import('shiki')
    const highlighter = await shiki.createHighlighter({
      themes: ['github-dark-default'],
      langs: [lang as BundledLanguage],
    })
    return (code: string, language: string) =>
      highlighter.codeToHtml(code, {
        lang: language as BundledLanguage,
        theme: 'github-dark-default',
        // Wrap each line in a span so we can address it from the step animator.
        transformers: [
          {
            line(node, line) {
              node.properties = node.properties ?? {}
              node.properties['data-line'] = String(line)
            },
          },
        ],
      })
  })().catch((err) => {
    HIGHLIGHTER_CACHE.delete(lang)
    throw err
  })
  HIGHLIGHTER_CACHE.set(lang, promise)
  return promise
}

export function CodeRenderer({ config }: { config: CodeConfig }) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stepIdx, setStepIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  // Once the user clicks any step, we treat that as "I'm driving now" and
  // stop auto-advance for the rest of this frame's lifetime. Trade-off:
  // there is no resume gesture — the user has to navigate frames or reload
  // to get auto-play back. This is the standard slideshow pattern and the
  // alternative (timed resume) usually fights the user.
  const userInteractedRef = useRef(false)

  // Highlight on mount / language change.
  useEffect(() => {
    let cancelled = false
    setError(null)
    setHtml(null)
    loadHighlighter(config.language)
      .then((build) => {
        if (cancelled) return
        try {
          setHtml(build(config.code, config.language))
        } catch (err) {
          setError(err instanceof Error ? err.message : 'failed to highlight')
        }
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'highlighter unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [config.code, config.language])

  // Apply highlight class to the active step's lines + dim the rest.
  // Done via direct DOM manipulation because Shiki output is innerHTML — we
  // don't want to re-build the AST per tick.
  useEffect(() => {
    const root = containerRef.current
    if (!root || !html) return
    const activeLines = new Set(config.steps[stepIdx]?.lines ?? [])
    const lines = root.querySelectorAll<HTMLElement>('[data-line]')
    lines.forEach((el) => {
      const line = Number(el.getAttribute('data-line'))
      if (activeLines.has(line)) {
        el.classList.add('code-step-active')
        el.classList.remove('code-step-dim')
      } else {
        el.classList.add('code-step-dim')
        el.classList.remove('code-step-active')
      }
    })
  }, [html, stepIdx, config.steps])

  // Auto-advance — gives each step time roughly proportional to its label.
  // Bails out if the user has taken manual control of the rail.
  useEffect(() => {
    if (!html) return
    if (userInteractedRef.current) return
    const step = config.steps[stepIdx]
    if (!step) return
    const ms = Math.max(2000, Math.min(8000, step.label.length * 70))
    const t = setTimeout(() => {
      setStepIdx((i) => (i + 1 < config.steps.length ? i + 1 : i))
    }, ms)
    return () => clearTimeout(t)
  }, [html, stepIdx, config.steps])

  const totalLines = useMemo(() => config.code.split(/\r?\n/).length, [config.code])

  if (error) {
    return (
      <div className="glass-card p-5 space-y-2" role="alert">
        <div className="kicker text-crimson">code render failed</div>
        <p className="text-bone text-xs font-mono">{error}</p>
      </div>
    )
  }

  return (
    <div className="glass-card overflow-hidden p-0">
      {config.title && (
        <header className="px-4 pt-4 pb-2 flex items-baseline justify-between border-b border-white/5">
          <div className="flex items-baseline gap-3">
            <span className="kicker text-crimson">{config.language}</span>
            <span className="text-bone text-sm font-mono truncate">
              {config.title}
            </span>
          </div>
          <span className="text-[10px] font-mono text-smoke">
            {totalLines} ln
          </span>
        </header>
      )}
      <div
        ref={containerRef}
        className="code-step-container overflow-x-auto"
        data-no-frame-scroll
        // Shiki produces its own <pre><code>; we let it fully control inside.
        dangerouslySetInnerHTML={{
          __html:
            html ??
            '<pre class="p-4 text-xs font-mono text-ash">loading…</pre>',
        }}
      />
      <footer className="px-4 py-3 border-t border-white/5 space-y-2">
        <div
          role="status"
          aria-live="polite"
          className="text-bone text-xs font-mono leading-relaxed"
        >
          <span className="text-crimson mr-2">{`> ${stepIdx + 1}/${config.steps.length}`}</span>
          {config.steps[stepIdx]?.label}
        </div>
        <div className="flex items-center gap-1.5" role="tablist" aria-label="Code steps">
          {config.steps.map((s, i) => {
            const active = i === stepIdx
            return (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={`Step ${i + 1}: ${s.label}`}
                onClick={() => {
                  // Mark before setState — the auto-advance effect re-runs
                  // when stepIdx changes and reads the ref synchronously.
                  userInteractedRef.current = true
                  setStepIdx(i)
                }}
                className="h-1 transition-all rounded"
                style={{
                  width: active ? '24px' : '6px',
                  background: active ? 'var(--crimson)' : 'rgba(232,228,221,0.18)',
                  boxShadow: active ? '0 0 10px rgba(214,0,23,0.4)' : 'none',
                }}
              />
            )
          })}
        </div>
        {config.caption && (
          <p className="text-smoke text-[11px] font-mono">{config.caption}</p>
        )}
      </footer>
    </div>
  )
}
