import { Suspense, lazy } from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import { UIRenderer } from './renderers/UIRenderer'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * PrintFrame — print/PDF-friendly variant of an explanation frame.
 *
 * Browser print contexts are hostile:
 *   - Canvas/WebGL contexts (manim, particles) typically render blank because
 *     the print pipeline snapshots the DOM and re-rasterizes it from the
 *     CSSOM, not from the live canvas. We render a text fallback for those.
 *   - Excalidraw renders to SVG when in viewMode, which prints fine — we let
 *     it through.
 *   - Shiki's syntax highlight CSS (theme=github-dark-default) is dark on
 *     dark; print stylesheet forces black-on-white anyway, so for code we
 *     downgrade to plain monospaced <pre><code> so the text actually shows up
 *     on paper.
 *   - UIRenderer prints fine — it's just semantic HTML — but its audio bar
 *     adds a useless control widget; PrintFrame omits the narration audio.
 *
 * Resilience: every renderer is wrapped in an ErrorBoundary that falls back
 * to plain narration text. A crashing renderer must never break the print
 * pipeline (Excalidraw in particular has been known to throw inside
 * non-visible / iframe contexts).
 */

type Frame = {
  _id: string
  skill: string
  config: string
  narration?: string | null
  step?: number | null
}

export function PrintFrame({ frame, index, total }: { frame: Frame; index: number; total: number }) {
  return (
    <article className="print-frame" style={{ pageBreakInside: 'avoid', breakInside: 'avoid' }}>
      <header style={{ marginBottom: 8 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontFamily: 'monospace',
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: '#000',
          }}
        >
          <span>{frame.skill}</span>
          <span>
            {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
          </span>
        </div>
      </header>

      <ErrorBoundary
        label={`print-${frame.skill}`}
        fallback={() => <NarrationFallback narration={frame.narration ?? undefined} />}
      >
        <PrintBody frame={frame} />
      </ErrorBoundary>

      {frame.narration && (
        <aside
          style={{
            marginTop: 8,
            paddingLeft: 10,
            borderLeft: '2px solid #000',
            fontFamily: 'monospace',
            fontSize: 12,
            lineHeight: 1.55,
            color: '#000',
          }}
        >
          {frame.narration}
        </aside>
      )}
    </article>
  )
}

function PrintBody({ frame }: { frame: Frame }) {
  let parsed: any = null
  try {
    parsed = JSON.parse(frame.config)
  } catch {
    // Malformed config → just narration. Don't crash the print page.
    return <NarrationFallback narration={frame.narration ?? undefined} />
  }

  switch (frame.skill) {
    case 'ui':
      return <UIRenderer config={parsed} explanationId={frame._id as Id<'explanations'>} />
    case 'diagram':
      return <PrintDiagram elements={parsed?.elements ?? []} />
    case 'code':
      return <PrintCode config={parsed} />
    case 'manim':
    case 'particles':
      return (
        <AnimationFallback
          label={frame.skill}
          caption={parsed?.title ?? parsed?.caption ?? null}
        />
      )
    default:
      return <NarrationFallback narration={frame.narration ?? undefined} />
  }
}

function NarrationFallback({ narration }: { narration?: string }) {
  return (
    <div
      style={{
        fontFamily: 'monospace',
        fontSize: 12,
        color: '#000',
        padding: 8,
        border: '1px dashed #999',
      }}
    >
      {narration ?? '(no content)'}
    </div>
  )
}

function AnimationFallback({ label, caption }: { label: string; caption: string | null }) {
  return (
    <div
      style={{
        fontFamily: 'monospace',
        fontSize: 11,
        color: '#000',
        padding: 12,
        border: '1px solid #000',
        textAlign: 'center',
        background: '#f5f5f5',
      }}
    >
      <div style={{ textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: 4 }}>
        {label} animation
      </div>
      {caption && <div style={{ fontStyle: 'italic', marginTop: 4 }}>{caption}</div>}
      <div style={{ marginTop: 6, opacity: 0.7 }}>
        (animation — view online for full experience)
      </div>
    </div>
  )
}

function PrintCode({ config }: { config: { code?: string; language?: string; title?: string } }) {
  return (
    <div>
      {config.title && (
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            marginBottom: 4,
            color: '#000',
          }}
        >
          {config.title} {config.language ? `· ${config.language}` : null}
        </div>
      )}
      <pre
        style={{
          background: '#f5f5f5',
          color: '#000',
          fontFamily: 'monospace',
          fontSize: 11,
          lineHeight: 1.55,
          padding: 10,
          border: '1px solid #ddd',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          margin: 0,
        }}
      >
        <code>{config.code ?? ''}</code>
      </pre>
    </div>
  )
}

// Lazy the actual Excalidraw renderer so the print bundle doesn't pay for it
// unless a diagram frame actually needs it. The renderer is wrapped in
// the parent ErrorBoundary so a print-context crash falls back to narration.
const DiagramRendererLazy = lazy(() =>
  import('./renderers/DiagramRenderer').then((m) => ({ default: m.DiagramRenderer }))
)

function PrintDiagram({ elements }: { elements: any[] }) {
  if (!elements?.length) {
    return <NarrationFallback narration="(empty diagram)" />
  }
  return (
    <div style={{ height: 420, border: '1px solid #ddd', background: '#fff' }}>
      <Suspense
        fallback={
          <div
            style={{
              padding: 12,
              fontFamily: 'monospace',
              fontSize: 11,
              color: '#000',
              textAlign: 'center',
            }}
          >
            (diagram loading)
          </div>
        }
      >
        <DiagramRendererLazy config={{ elements }} />
      </Suspense>
    </div>
  )
}
