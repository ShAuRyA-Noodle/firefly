import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { useEffect } from 'react'

import ConvexProvider from '../integrations/convex/provider'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { flush as flushObservability } from '../lib/observability'

import appCss from '../styles.css?url'

const THEME_INIT_SCRIPT = `(function(){document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark';})();`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content:
          'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      {
        name: 'description',
        content:
          "Firefly — AI tutor that answers your questions with visuals: animations, diagrams, particles, code. Narrated by a 3D talking avatar.",
      },
      { name: 'theme-color', content: '#0A0808' },
      { property: 'og:title', content: 'Firefly — your questions, lit up inside.' },
      {
        property: 'og:description',
        content:
          'AI visual tutor. Math animations, system diagrams, code walkthroughs, narrated by a 3D avatar.',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:image', content: '/og-image.svg' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: 'Firefly' },
      { name: 'twitter:description', content: 'AI visual tutor with 3D avatar narration.' },
      { name: 'twitter:image', content: '/og-image.svg' },
      { title: 'Firefly — your questions, lit up inside.' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.ico' },
      { rel: 'manifest', href: '/manifest.json' },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  // Flush queued Sentry events on tab close so in-flight error reports
  // survive navigation. No-ops when no DSN is configured.
  useEffect(() => {
    const onUnload = () => {
      void flushObservability()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased">
        <ErrorBoundary
          label="root"
          fallback={(err, reset) => (
            <div className="min-h-screen flex items-center justify-center px-6">
              <div className="max-w-md w-full space-y-5 text-center">
                <p className="kicker text-crimson">fatal</p>
                <h1 className="display-title text-5xl text-bone">
                  SOMETHING<br />BROKE
                </h1>
                <p className="text-ash text-xs font-mono tracking-wide">
                  {err.message}
                </p>
                <button type="button" onClick={reset} className="btn-crimson">
                  reload
                </button>
              </div>
            </div>
          )}
        >
          <ConvexProvider>{children}</ConvexProvider>
        </ErrorBoundary>
        <footer className="fixed bottom-1 left-1/2 -translate-x-1/2 z-30 text-[9px] font-mono text-smoke tracking-[0.2em] uppercase pointer-events-none">
          AI may be wrong · verify important answers
        </footer>
        <Scripts />
      </body>
    </html>
  )
}
