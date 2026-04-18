import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

import ConvexProvider from '../integrations/convex/provider'
import { ErrorBoundary } from '../components/ErrorBoundary'

import appCss from '../styles.css?url'

const THEME_INIT_SCRIPT = `(function(){document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark';})();`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Firefly — your questions, lit up inside.' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
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
        <Scripts />
      </body>
    </html>
  )
}
