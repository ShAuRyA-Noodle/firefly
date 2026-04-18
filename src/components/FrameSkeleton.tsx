/**
 * Skill-aware BMTH-themed skeleton loaders.
 * Shown while the sub-agent is still generating a given frame.
 * Aspect ratios match each renderer so there's zero layout shift when the
 * real content drops in.
 */
type Props = { skill: string; step?: number; total?: number }

export function FrameSkeleton({ skill, step, total }: Props) {
  return (
    <div className="frame-content space-y-4" role="status" aria-live="polite" aria-busy="true">
      <Header skill={skill} step={step} total={total} />
      <Body skill={skill} />
    </div>
  )
}

function Header({ skill, step, total }: Props) {
  return (
    <div className="flex items-center justify-between">
      <div className="kicker text-crimson">{skill}</div>
      <div className="font-mono text-[10px] tracking-[0.24em] uppercase text-ash">
        {step != null && total != null ? `${step} / ${total}` : 'incoming'}
      </div>
    </div>
  )
}

function Body({ skill }: { skill: string }) {
  switch (skill) {
    case 'manim':
      return <ManimSkeleton />
    case 'diagram':
      return <DiagramSkeleton />
    case 'particles':
      return <ParticlesSkeleton />
    case 'ui':
      return <UISkeleton />
    default:
      return <GenericSkeleton />
  }
}

function ManimSkeleton() {
  return (
    <div
      className="relative w-full rounded-sm overflow-hidden border border-white/5"
      style={{ aspectRatio: '16 / 9', background: '#0b0806' }}
    >
      <div className="absolute inset-0 grid place-items-center">
        <div className="loading-breathe font-mono text-[10px] tracking-[0.32em] uppercase text-crimson">
          plotting
        </div>
      </div>
      <div
        className="absolute left-0 bottom-0 h-[2px] bg-crimson"
        style={{ width: '28%', boxShadow: '0 0 12px rgba(214,0,23,0.6)' }}
      />
    </div>
  )
}

function DiagramSkeleton() {
  return (
    <div
      className="relative w-full rounded-sm border border-dashed border-crimson/30"
      style={{ aspectRatio: '16 / 10', background: 'rgba(214,0,23,0.02)' }}
    >
      <div className="absolute inset-0 grid place-items-center">
        <div className="loading-breathe font-mono text-[10px] tracking-[0.32em] uppercase text-ash">
          drawing
        </div>
      </div>
    </div>
  )
}

function ParticlesSkeleton() {
  return (
    <div
      className="relative w-full rounded-sm overflow-hidden border border-white/5"
      style={{ aspectRatio: '1 / 1', background: '#080605' }}
    >
      <div className="absolute inset-0 grid place-items-center">
        <div className="relative w-2 h-2">
          <div className="absolute inset-0 rounded-full bg-crimson pulse-crimson" />
        </div>
      </div>
    </div>
  )
}

function UISkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-4 w-2/3 rounded-sm bg-white/5 loading-breathe" />
      <div className="h-3 w-full rounded-sm bg-white/[0.04] loading-breathe" />
      <div className="h-3 w-5/6 rounded-sm bg-white/[0.04] loading-breathe" />
      <div className="grid grid-cols-2 gap-3 pt-4">
        <div className="h-10 rounded-sm bg-white/5 loading-breathe" />
        <div className="h-10 rounded-sm bg-white/5 loading-breathe" />
      </div>
    </div>
  )
}

function GenericSkeleton() {
  return (
    <div className="h-40 w-full rounded-sm bg-white/5 loading-breathe" />
  )
}
