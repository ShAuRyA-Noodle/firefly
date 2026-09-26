import { lazy, Suspense, useMemo } from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import { FrameSkeleton } from './FrameSkeleton'
import { UIRenderer } from './renderers/UIRenderer'
import { validateSkillConfig } from '../../convex/lib/skillSchemas'

import type { Id } from '../../convex/_generated/dataModel'

// Code-split heavy renderers — only their bytes download when needed,
// and never on the critical path of the first paint.
const ManimRenderer = lazy(() =>
  import('./renderers/ManimRenderer').then((m) => ({ default: m.ManimRenderer }))
)
const DiagramRenderer = lazy(() =>
  import('./renderers/DiagramRenderer').then((m) => ({ default: m.DiagramRenderer }))
)
const ParticlesRenderer = lazy(() =>
  import('./renderers/particles').then((m) => ({ default: m.ParticlesRenderer }))
)
const CodeRenderer = lazy(() =>
  import('./renderers/CodeRenderer').then((m) => ({ default: m.CodeRenderer }))
)

type Explanation = {
  _id: string
  skill: string
  config: string
  narration?: string
  step?: number
}

export function SkillRouter({
  explanation,
  onAction,
}: {
  explanation: Explanation
  onAction?: (prompt: string) => void
}) {
  // Parsing JSON on every parent rerender churned object identity, which
  // cascaded into every renderer's effects (CodeRenderer's step effect was
  // the worst offender — `config.steps` got a fresh reference each tick).
  // Memoize on the raw string so identity is stable across reruns.
  const parsed = useMemo<{ config: unknown; error: string | null }>(() => {
    try {
      return { config: JSON.parse(explanation.config), error: null }
    } catch (err) {
      return {
        config: null,
        error: err instanceof Error ? err.message : 'JSON parse failed',
      }
    }
  }, [explanation.config])

  // Client-side defense-in-depth: the server-side validator in the sub-agent
  // already rejects invalid configs, but old rows, skill-schema drift, or an
  // unexpected writer could still serve bad data. Show a readable panel
  // instead of crashing the downstream renderer. Memoize so the validated
  // .data reference stays stable when neither skill nor config changed.
  const validated = useMemo(() => {
    if (parsed.error !== null) return null
    return validateSkillConfig(explanation.skill, parsed.config)
  }, [explanation.skill, parsed.config, parsed.error])

  // A generation that exhausted both models lands as a _failed tombstone.
  // Render it as an intentional, calm state — not a scary "malformed" panel.
  if (explanation.skill === '_failed') {
    return (
      <div className="glass-card p-6 text-center space-y-2" role="status">
        <div className="kicker text-ash">frame skipped</div>
        <p className="text-smoke text-xs font-mono">
          this frame couldn’t be generated — the rest of the answer is below
        </p>
      </div>
    )
  }

  if (parsed.error !== null) {
    return (
      <div className="glass-card p-5 space-y-2" role="alert">
        <div className="kicker text-crimson">malformed config</div>
        <p className="text-bone text-xs font-mono">{parsed.error}</p>
      </div>
    )
  }

  if (!validated || !validated.ok) {
    return (
      <div className="glass-card p-5 space-y-2" role="alert">
        <div className="kicker text-crimson">frame malformed</div>
        <p className="text-bone text-xs font-mono break-words">
          {validated ? validated.error : 'validation failed'}
        </p>
        <p className="text-smoke text-[10px] font-mono uppercase tracking-wide">
          skill · {explanation.skill}
        </p>
      </div>
    )
  }

  return (
    <ErrorBoundary label={explanation.skill}>
      <Suspense fallback={<FrameSkeleton skill={explanation.skill} step={explanation.step} />}>
        <Inner
          skill={explanation.skill}
          config={validated.data}
          onAction={onAction}
          explanationId={explanation._id as Id<'explanations'>}
        />
      </Suspense>
    </ErrorBoundary>
  )
}

function Inner({
  skill,
  config,
  onAction,
  explanationId,
}: {
  skill: string
  config: any
  onAction?: (prompt: string) => void
  explanationId: Id<'explanations'>
}) {
  switch (skill) {
    case 'ui':
      return <UIRenderer config={config} onAction={onAction} explanationId={explanationId} />
    case 'particles':
      return <ParticlesRenderer config={config} />
    case 'manim':
      return <ManimRenderer config={config} />
    case 'diagram':
      return <DiagramRenderer config={config} />
    case 'code':
      return <CodeRenderer config={config} />
    default:
      return (
        <div className="glass-card p-6 text-center space-y-2">
          <div className="kicker text-ash">{skill}</div>
          <div className="text-smoke text-xs font-mono">renderer unavailable</div>
        </div>
      )
  }
}
