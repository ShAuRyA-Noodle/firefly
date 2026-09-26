import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { SkillRouter } from './SkillRouter'

type Explanation = {
  _id: string
  skill: string
  config: string
  narration?: string
  step?: number
  // Question ordinal within the thread. A thread accrues one turn per
  // question (original + every ActionCard follow-up); frames render in
  // append order (turnIndex, then step). Absent on pre-turns rows → 0.
  turnIndex?: number
  createdAt: number
}

export function FrameContainer({
  explanations,
  isLoading,
  onAction,
  onBranch,
}: {
  explanations: Explanation[]
  isLoading: boolean
  onAction?: (prompt: string) => void
  onBranch?: (frameId: string) => void | Promise<void>
}) {
  // "Done" tracks the LATEST question only — a thread can hold many settled
  // turns while a fresh follow-up is still generating, and the loading
  // placeholder must show for that new turn even though earlier turns closed.
  const maxTurn = explanations.reduce(
    (m, e) => Math.max(m, e.turnIndex ?? 0),
    0,
  )
  const isDone = explanations.some(
    (e) => e.skill === '_done' && (e.turnIndex ?? 0) === maxTurn,
  )
  const visuals = explanations.filter((e) => e.skill !== '_done' && e.skill !== 'intro')

  const sorted = useMemo(
    () =>
      [...visuals].sort((a, b) => {
        // Questions in ask-order, frames within a question in narrative order.
        const ta = a.turnIndex ?? 0
        const tb = b.turnIndex ?? 0
        if (ta !== tb) return ta - tb
        if (a.step != null && b.step != null) return a.step - b.step
        return a.createdAt - b.createdAt
      }),
    [visuals],
  )

  const hasExplanations = sorted.length > 0
  const frameCount =
    (hasExplanations ? sorted.length : 1) + (isLoading && !isDone ? 1 : 0)

  const [activeIndex, setActiveIndex] = useState(0)
  const prevCountRef = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const wasLoadingRef = useRef(false)
  const generationStartCountRef = useRef(0)

  useEffect(() => {
    const prevCount = prevCountRef.current
    prevCountRef.current = sorted.length

    if (isLoading && !wasLoadingRef.current) {
      generationStartCountRef.current = prevCount
    }
    wasLoadingRef.current = isLoading

    if (sorted.length > prevCount && sorted.length > generationStartCountRef.current) {
      setActiveIndex(sorted.length - 1)
    }

    if (isLoading && sorted.length === 0 && !isDone) {
      setActiveIndex(0)
    }
  }, [sorted.length, isLoading, isDone])

  const goNext = useCallback(
    () => setActiveIndex((i) => Math.min(i + 1, frameCount - 1)),
    [frameCount],
  )
  const goPrev = useCallback(() => setActiveIndex((i) => Math.max(i - 1, 0)), [])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        goNext()
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        goPrev()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [goNext, goPrev])

  useEffect(() => {
    let accumulated = 0
    let lastDir = 0
    let lastWheelAt = 0
    let lastInFrameScrollAt = 0
    let switchCooldownUntil = 0
    const THRESHOLD = 180
    const IDLE_RESET_MS = 250
    const POST_INFRAME_QUIET_MS = 300
    const SWITCH_COOLDOWN_MS = 400

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return
      const target = e.target as Element | null
      if (target?.closest?.('canvas, .manim-scene, pre, [data-no-frame-scroll]')) return

      const container = containerRef.current
      if (!container) return
      const activeFrame = container.querySelector('.frame.active')
      if (!activeFrame) {
        e.preventDefault()
        return
      }

      const now = performance.now()
      if (now - lastWheelAt > IDLE_RESET_MS) accumulated = 0
      const dir = Math.sign(e.deltaY)
      if (dir !== 0 && lastDir !== 0 && dir !== lastDir) accumulated = 0
      if (dir !== 0) lastDir = dir
      lastWheelAt = now

      const { scrollTop, scrollHeight, clientHeight } = activeFrame
      const atTop = scrollTop <= 0
      const atBottom = scrollTop + clientHeight >= scrollHeight - 1
      const isScrollable = scrollHeight > clientHeight + 1

      if (isScrollable) {
        if (e.deltaY > 0 && !atBottom) {
          lastInFrameScrollAt = now
          accumulated = 0
          return
        }
        if (e.deltaY < 0 && !atTop) {
          lastInFrameScrollAt = now
          accumulated = 0
          return
        }
      }

      if (now - lastInFrameScrollAt < POST_INFRAME_QUIET_MS) {
        e.preventDefault()
        return
      }
      if (now < switchCooldownUntil) {
        e.preventDefault()
        return
      }

      e.preventDefault()
      accumulated += e.deltaY
      if (accumulated >= THRESHOLD) {
        accumulated = 0
        switchCooldownUntil = now + SWITCH_COOLDOWN_MS
        goNext()
      } else if (accumulated <= -THRESHOLD) {
        accumulated = 0
        switchCooldownUntil = now + SWITCH_COOLDOWN_MS
        goPrev()
      }
    }
    window.addEventListener('wheel', handleWheel, { passive: false })
    return () => window.removeEventListener('wheel', handleWheel)
  }, [goNext, goPrev])

  // Touch swipe — horizontal gesture only, with a noise floor on the vertical
  // axis so vertical scrolls inside a frame (manim, code blocks, narration)
  // don't steal the gesture. Threshold is generous (60px) so accidental
  // sub-thumb wiggles don't trigger frame changes.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const SWIPE_THRESHOLD = 60
    const VERTICAL_TOLERANCE = 40
    let startX = 0
    let startY = 0
    let tracking = false

    const onStart = (e: TouchEvent) => {
      const target = e.target as Element | null
      // Don't hijack swipes that started inside scrollable subtrees — those
      // gestures belong to the inner content (canvas, code, manim).
      if (
        target?.closest?.(
          'canvas, .manim-scene, pre, [data-no-frame-scroll], input, textarea, [contenteditable="true"]',
        )
      ) {
        tracking = false
        return
      }
      const t = e.touches[0]
      if (!t) return
      startX = t.clientX
      startY = t.clientY
      tracking = true
    }
    const onEnd = (e: TouchEvent) => {
      if (!tracking) return
      tracking = false
      const t = e.changedTouches[0]
      if (!t) return
      const dx = t.clientX - startX
      const dy = t.clientY - startY
      // Reject mostly-vertical gestures even if dx clears the threshold —
      // those are scroll intents that grazed sideways.
      if (Math.abs(dy) > Math.abs(dx) + VERTICAL_TOLERANCE) return
      if (dx <= -SWIPE_THRESHOLD) goNext()
      else if (dx >= SWIPE_THRESHOLD) goPrev()
    }
    const onCancel = () => {
      tracking = false
    }

    container.addEventListener('touchstart', onStart, { passive: true })
    container.addEventListener('touchend', onEnd, { passive: true })
    container.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      container.removeEventListener('touchstart', onStart)
      container.removeEventListener('touchend', onEnd)
      container.removeEventListener('touchcancel', onCancel)
    }
  }, [goNext, goPrev])

  // ── Build frames ──────────────────────────────────────────────────
  const frames: { key: string; content: React.ReactNode; aria: string }[] = []

  if (!hasExplanations && !isLoading) {
    frames.push({
      key: 'welcome',
      aria: 'Welcome. Type a question to begin.',
      content: (
        <div className="frame-content text-center space-y-6">
          <p className="kicker text-crimson">firefly · visual learning</p>
          <h1 className="display-title text-7xl md:text-8xl text-bone glitch-hover cursor-default">
            ASK<br />SEE<br />UNDERSTAND
          </h1>
          <p className="text-ash text-xs font-mono tracking-[0.18em] uppercase max-w-sm mx-auto pt-4">
            your questions, lit up inside.
          </p>
        </div>
      ),
    })
  }

  const totalExpected = sorted.length + (isLoading && !isDone ? 1 : 0)

  for (let i = 0; i < sorted.length; i++) {
    const explanation = sorted[i]
    frames.push({
      key: explanation._id,
      aria: `Frame ${i + 1} of ${totalExpected}. ${explanation.narration ?? ''}`,
      content: (
        <div className="frame-content space-y-6">
          <div className="flex items-center justify-between">
            <div className="kicker text-crimson">{explanation.skill}</div>
            <div className="flex items-center gap-3">
              {onBranch && (
                <button
                  type="button"
                  onClick={() => void onBranch(explanation._id)}
                  className="text-[10px] uppercase tracking-[0.22em] text-ash hover:text-crimson transition font-mono"
                  title="Ask a follow-up based on this frame"
                >
                  branch ↗
                </button>
              )}
              <div className="font-mono text-[10px] tracking-[0.24em] uppercase text-ash">
                {String(i + 1).padStart(2, '0')} / {String(totalExpected).padStart(2, '0')}
              </div>
            </div>
          </div>
          <SkillRouter explanation={explanation} onAction={onAction} />
          {explanation.narration && (
            <aside
              // Prose keeps a readable measure even though the frame itself is
              // now viewport-wide — long mono lines across 1440px are painful.
              className="border-l border-crimson/40 pl-4 pr-2 py-2 mt-4 max-w-[78ch]"
              aria-label="Narration"
            >
              <p className="text-bone text-sm font-mono leading-relaxed">
                <span className="text-crimson mr-2">/</span>
                {explanation.narration}
              </p>
            </aside>
          )}
        </div>
      ),
    })
  }

  if (isLoading && !isDone) {
    frames.push({
      key: 'loading',
      aria: 'Generating the next frame.',
      content: (
        <div className="frame-content">
          <div className="flex items-center justify-between mb-4">
            <div className="kicker text-crimson">generating</div>
            <div className="font-mono text-[10px] tracking-[0.24em] uppercase text-ash">
              {String(sorted.length + 1).padStart(2, '0')} / {String(totalExpected).padStart(2, '0')}
            </div>
          </div>
          <div
            className="h-40 w-full rounded-sm bg-white/[0.02] border border-white/5 grid place-items-center"
          >
            <div className="space-y-3 text-center">
              <div className="relative w-2 h-2 mx-auto">
                <div className="absolute inset-0 rounded-full bg-crimson pulse-crimson" />
              </div>
              <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-ash loading-breathe">
                thinking
              </p>
            </div>
          </div>
        </div>
      ),
    })
  }

  // Clamp activeIndex if the count shrinks
  const safeActive = Math.min(activeIndex, Math.max(0, frames.length - 1))

  return (
    <div
      ref={containerRef}
      className="frame-container"
      role="region"
      aria-label="Visual explanation frames"
    >
      {/* SR-only live region announces active frame */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {frames[safeActive]?.aria ?? ''}
      </div>

      {frames.map((frame, i) => {
        const active = i === safeActive
        return (
          <div
            key={frame.key}
            className={`frame ${active ? 'active' : ''}`}
            role="tabpanel"
            id={`frame-panel-${i}`}
            aria-labelledby={`frame-tab-${i}`}
            aria-hidden={!active}
            // `inert` blocks focus + pointer + tab into hidden frames so
            // SR users and tab-cyclers can't accidentally land in a frame
            // they can't see. React 19 + @types/react 19 type this as a
            // boolean attribute.
            inert={!active}
            // Huge perf win: off-screen frames skip rendering entirely.
            style={{ contentVisibility: active ? 'visible' : 'hidden' }}
          >
            {frame.content}
          </div>
        )
      })}

      {/* Frame indicator rail. Buttons are at least 44px tall so finger
          taps land cleanly on mobile (Apple HIG / Material guidance);
          the visible bar inside is the same width as before so the
          desktop look is unchanged. */}
      {frames.length > 1 && (
        <div
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5"
          role="tablist"
          aria-label="Frame navigation"
        >
          {frames.map((_, i) => {
            const active = i === safeActive
            return (
              <button
                key={i}
                type="button"
                role="tab"
                id={`frame-tab-${i}`}
                aria-selected={active}
                aria-controls={`frame-panel-${i}`}
                aria-label={`Frame ${i + 1}`}
                onClick={() => setActiveIndex(i)}
                className="group flex items-center justify-center bg-transparent border-0"
                style={{
                  // ≥44px tall via padding; horizontal padding keeps the
                  // hit area between dots without adding visible spacing.
                  padding: '12px 4px',
                  minHeight: '44px',
                }}
              >
                <span
                  aria-hidden="true"
                  className="block h-1 transition-all rounded"
                  style={{
                    width: active ? '28px' : '8px',
                    background: active ? 'var(--crimson)' : 'rgba(232,228,221,0.15)',
                    boxShadow: active ? '0 0 14px rgba(214,0,23,0.5)' : 'none',
                  }}
                />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
