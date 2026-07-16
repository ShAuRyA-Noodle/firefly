import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import tsconfigPaths from 'vite-tsconfig-paths'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const config = defineConfig({
  plugins: [
    devtools(),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    nitro(),
    viteReact(),
  ],
  resolve: {
    // node_modules carries two three.js copies (0.180.0 + 0.183.2 via
    // transitive deps). React-Three-Fiber stores its Canvas context on the
    // three instance, so hooks resolving the OTHER copy threw
    // "R3F: Hooks can only be used within the Canvas component!" and every
    // particles frame failed. Dedupe forces one instance for all importers.
    dedupe: ['three', '@react-three/fiber', '@react-three/drei', 'react', 'react-dom'],
  },
  optimizeDeps: {
    exclude: ['@met4citizen/talkinghead'],
  },
  ssr: {
    noExternal: [],
    external: ['@met4citizen/talkinghead', 'three'],
  },
})

export default config
