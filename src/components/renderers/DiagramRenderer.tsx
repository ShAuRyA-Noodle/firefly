import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

/** Minimal slice of Excalidraw's imperative API that we drive. */
type DiagramApi = {
  scrollToContent: (
    target: unknown,
    opts?: { fitToContent?: boolean; animate?: boolean },
  ) => void
  updateScene: (scene: { appState: { zoom: { value: number } } }) => void
  getAppState: () => { zoom?: { value?: number } }
}

/**
 * Excalidraw's `initialData.elements` expects FULLY-formed elements (seed,
 * versionNonce, all style fields, correct binding shape). A model that emits
 * a minimal element list renders blank or throws. `convertToExcalidrawElements`
 * is the library's official skeleton→full converter: it takes minimal
 * elements ({type,x,y,width,height,label,...}) and fills every required field
 * + wires container/label bindings. Running every diagram through it makes the
 * renderer tolerant of exactly the sparse output cheaper models produce.
 */
const ExcalidrawWrapper = lazy(async () => {
  const mod = await import('@excalidraw/excalidraw')
  await import('@excalidraw/excalidraw/index.css')
  const { convertToExcalidrawElements } = mod
  return {
    default: ({ elements }: { elements: unknown[] }) => {
      const [api, setApi] = useState<DiagramApi | null>(null)
      const hostRef = useRef<HTMLDivElement>(null)
      // Skeleton → full. Raw skeleton elements CANNOT render in Excalidraw
      // (they lack seed/version/bindings), so on failure we surface the real
      // reason instead of silently blanking the canvas.
      const { prepared, error } = useMemo(() => {
        try {
          // Models emit a guessed `width`/`height` on text elements that is
          // almost always too small for the string, and the converter honours
          // it — so labels rendered visibly truncated ("Handsha|", "ESTABLISHE|").
          // Dropping those lets Excalidraw measure the real text metrics.
          const sanitized = (elements as Array<Record<string, unknown>>).map(
            (el) => {
              if (!el || typeof el !== 'object') return el
              const isText = el.type === 'text'
              const next: Record<string, unknown> = { ...el }
              if (isText) {
                delete next.width
                delete next.height
              }
              // Same problem for bound labels inside shapes.
              if (next.label && typeof next.label === 'object') {
                const lbl = { ...(next.label as Record<string, unknown>) }
                delete lbl.width
                delete lbl.height
                next.label = lbl
              }
              return next
            },
          )
          const converted = convertToExcalidrawElements(sanitized as never, {
            regenerateIds: true,
          })
          if (Array.isArray(converted) && converted.length > 0) {
            return { prepared: converted, error: null as string | null }
          }
          return {
            prepared: null,
            error: `converter produced ${
              Array.isArray(converted) ? converted.length : 0
            } elements`,
          }
        } catch (err) {
          return {
            prepared: null,
            error: err instanceof Error ? err.message : 'conversion failed',
          }
        }
      }, [elements])

      // Scale the whole graph into view once the canvas is live (and again if
      // the elements change) — this is what stops titles getting clipped.
      const fit = useCallback(() => {
        if (!api || !prepared) return
        try {
          api.scrollToContent(prepared, { fitToContent: true, animate: false })
        } catch {
          /* non-fatal — diagram still renders unfitted */
        }
      }, [api, prepared])

      const zoomBy = useCallback(
        (factor: number) => {
          if (!api) return
          try {
            const cur = api.getAppState()?.zoom?.value ?? 1
            const next = Math.min(6, Math.max(0.1, cur * factor))
            api.updateScene({ appState: { zoom: { value: next } } })
          } catch {
            /* non-fatal */
          }
        },
        [api],
      )

      // Frames render inside a `contentVisibility: hidden` container until the
      // carousel activates them, so on mount the canvas is 0x0 and a fit
      // computed then produces a garbage transform — the diagram appeared
      // shifted/clipped with its title off-screen. Re-fit whenever the host
      // actually has dimensions (i.e. when the frame becomes visible, and on
      // any resize).
      useEffect(() => {
        const el = hostRef.current
        if (!el || !api) return
        let raf = 0
        const tryFit = () => {
          cancelAnimationFrame(raf)
          raf = requestAnimationFrame(() => {
            if (el.clientWidth > 0 && el.clientHeight > 0) fit()
          })
        }
        tryFit()
        const ro = new ResizeObserver(tryFit)
        ro.observe(el)
        return () => {
          cancelAnimationFrame(raf)
          ro.disconnect()
        }
      }, [api, fit])

      if (!prepared) {
        return (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-6 text-center">
            <div className="kicker text-crimson">diagram error</div>
            <p className="text-bone text-xs font-mono break-words max-w-sm">
              {error}
            </p>
          </div>
        )
      }

      return (
        <div ref={hostRef} className="w-full h-full">
        <mod.Excalidraw
          // Keep a handle so we can fit + zoom. `scrollToContent: true` in
          // initialData only scrolls — it doesn't scale — so larger diagrams
          // overflowed with their titles clipped. fitToContent scales the whole
          // graph into view; the buttons below give real zoom control (zen mode
          // hides Excalidraw's own footer widget).
          excalidrawAPI={(api) => setApi(api as unknown as DiagramApi)}
          initialData={{
            elements: prepared,
            appState: {
              // The diagram palette (pastel fills + dark strokes) is designed
              // for a light canvas — a warm paper tone reads as an intentional
              // whiteboard ("democratize the whiteboard") instead of a jarring
              // pure-white glitch, and keeps every stroke high-contrast.
              viewBackgroundColor: '#F2EFEA',
              zenModeEnabled: true,
              viewModeEnabled: true,
              gridSize: 0,
            },
            scrollToContent: true,
          }}
          viewModeEnabled
          zenModeEnabled
          theme="light"
        />
        <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1">
          {[
            { label: '−', title: 'Zoom out', fn: () => zoomBy(0.8) },
            { label: '+', title: 'Zoom in', fn: () => zoomBy(1.25) },
            { label: 'fit', title: 'Fit diagram', fn: fit },
          ].map((b) => (
            <button
              key={b.label}
              type="button"
              onClick={b.fn}
              title={b.title}
              aria-label={b.title}
              className="min-h-[32px] min-w-[32px] px-2 rounded-sm border border-black/15 bg-white/85 text-[11px] font-mono text-black/70 hover:text-black hover:border-black/40 transition backdrop-blur"
            >
              {b.label}
            </button>
          ))}
        </div>
        </div>
      )
    },
  }
})

interface DiagramConfig {
  elements: unknown[]
}

export function DiagramRenderer({ config }: { config: DiagramConfig }) {
  if (!config.elements?.length) {
    return (
      <div className="glass-card p-8 text-center text-gray-600 text-xs font-mono">
        no diagram elements
      </div>
    )
  }

  return (
    <div
      className="glass-card overflow-hidden relative"
      // Diagrams are the densest frame type, so give them real estate — the
      // old 560px cap clipped larger graphs. `data-no-frame-scroll` stops the
      // frame carousel from stealing the wheel, so scroll pans and
      // ctrl/pinch-scroll zooms inside the canvas.
      // Sized to the space that actually remains between the avatar strip and
      // the bottom chrome — a taller box just pushed content under the prompt
      // bar and looked clipped.
      style={{ height: 'clamp(320px, 56dvh, 680px)' }}
      data-no-frame-scroll
    >
      <Suspense
        fallback={
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs font-mono">
            loading excalidraw…
          </div>
        }
      >
        <ExcalidrawWrapper elements={config.elements} />
      </Suspense>
    </div>
  )
}
