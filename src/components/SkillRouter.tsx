import { lazy, Suspense } from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import { FrameSkeleton } from './FrameSkeleton'
import { UIRenderer } from './renderers/UIRenderer'

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
  let config: unknown
  try {
    config = JSON.parse(explanation.config)
  } catch (err) {
    return (
      <div className="glass-card p-5 space-y-2" role="alert">
        <div className="kicker text-crimson">malformed config</div>
        <p className="text-bone text-xs font-mono">
          {err instanceof Error ? err.message : 'JSON parse failed'}
        </p>
      </div>
    )
  }

  return (
    <ErrorBoundary label={explanation.skill}>
      <Suspense fallback={<FrameSkeleton skill={explanation.skill} step={explanation.step} />}>
        <Inner skill={explanation.skill} config={config} onAction={onAction} />
      </Suspense>
    </ErrorBoundary>
  )
}

function Inner({
  skill,
  config,
  onAction,
}: {
  skill: string
  config: any
  onAction?: (prompt: string) => void
}) {
  switch (skill) {
    case 'ui':
      return <UIRenderer config={config} onAction={onAction} />
    case 'particles':
      return <ParticlesRenderer config={config} />
    case 'manim':
      return <ManimRenderer config={config} />
    case 'diagram':
      return <DiagramRenderer config={config} />
    default:
      return (
        <div className="glass-card p-6 text-center space-y-2">
          <div className="kicker text-ash">{skill}</div>
          <div className="text-smoke text-xs font-mono">renderer unavailable</div>
        </div>
      )
  }
}
