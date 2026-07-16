import { ConvexAuthProvider } from '@convex-dev/auth/react'
import { ConvexReactClient } from 'convex/react'
import { CONVEX_URL } from '#/lib/env'

export const convex = new ConvexReactClient(CONVEX_URL, {
  unsavedChangesWarning: false,
})

export default function AppConvexProvider({
  children,
}: {
  children: React.ReactNode
}) {
  return <ConvexAuthProvider client={convex}>{children}</ConvexAuthProvider>
}
