import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { SkillRouter } from './SkillRouter'

type Explanation = {
  _id: string
  skill: string
  config: string
  narration?: string
  step?: number
  createdAt: number
}

export function FrameContainer({
  explanations,
  isLoading,
  onAction,
}: {
  explanations: Explanation[]
  isLoading: boolean
  onAction?: (prompt: string) => void
}) {
  const isDone = explanations.some((e) => e.skill === '_done')
  const visuals = explanations.filter((e) => e.skill !== '_done' && e.skill !== 'intro')

  const sorted = useMemo(
    () =>
      [...visuals].sort((a, b) => {
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
      const activeFrame = container.querySelector('.frame.active') as HTMLElement | null
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
            <div className="font-mono text-[10px] tracking-[0.24em] uppercase text-ash">
              {String(i + 1).padStart(2, '0')} / {String(totalExpected).padStart(2, '0')}
            </div>
          </div>
          <SkillRouter explanation={explanation} onAction={onAction} />
          {explanation.narration && (
            <aside
              className="border-l border-crimson/40 pl-4 pr-2 py-2 mt-4"
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
            aria-hidden={!active}
            // Huge perf win: off-screen frames skip rendering entirely.
            style={{ contentVisibility: active ? 'visible' : 'hidden' }}
          >
            {frame.content}
          </div>
        )
      })}

      {/* Frame indicator rail */}
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
                aria-selected={active}
                aria-label={`Frame ${i + 1}`}
                onClick={() => setActiveIndex(i)}
                className="group h-1 transition-all"
                style={{
                  width: active ? '28px' : '8px',
                  background: active ? 'var(--crimson)' : 'rgba(232,228,221,0.15)',
                  boxShadow: active ? '0 0 14px rgba(214,0,23,0.5)' : 'none',
                }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
