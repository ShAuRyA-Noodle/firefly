import { Canvas } from '@react-three/fiber'
import { OrbitControls, PerspectiveCamera } from '@react-three/drei'
import { ParticleSystem } from './ParticleSystem'
import type { ParticlesConfig } from './types'

function applyDefaults(config: Partial<ParticlesConfig>): ParticlesConfig {
  return {
    particleCount: config.particleCount ?? 3000,
    bounds: config.bounds ?? { x: [-10, 10], y: [-10, 10], z: [-10, 10] },
    camera: config.camera ?? { position: [0, 5, 15], lookAt: [0, 0, 0] },
    forces: config.forces ?? [],
    appearance: {
      colorMode: config.appearance?.colorMode ?? 'velocity',
      colorMap: config.appearance?.colorMap ?? ['#3b82f6', '#8b5cf6', '#ef4444'],
      size: config.appearance?.size ?? 0.05,
      opacity: config.appearance?.opacity ?? 0.8,
    },
    physics: {
      damping: config.physics?.damping ?? 0.98,
      maxVelocity: config.physics?.maxVelocity ?? 2.0,
    },
  }
}

// Device capability probe (browser-only; SSR-safe). Coarse pointers (phones/
// tablets) run the CPU integration + per-particle color recompute on weaker
// silicon, so we cut the particle budget and the DPR ceiling there. Reduced-
// motion users get no auto-rotate.
function deviceProfile() {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return { coarse: false, reducedMotion: false }
  }
  return {
    coarse: window.matchMedia('(pointer: coarse)').matches,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  }
}

export function ParticlesRenderer({ config }: { config: Partial<ParticlesConfig> }) {
  const safeConfig = applyDefaults(config)
  const { coarse, reducedMotion } = deviceProfile()

  // Cap the particle count on mobile so the per-frame integration stays within
  // budget — 1200 reads as "a lot" while staying smooth on a phone GPU/CPU.
  const budgetedConfig = coarse
    ? { ...safeConfig, particleCount: Math.min(safeConfig.particleCount, 1200) }
    : safeConfig

  return (
    <div className="glass-card overflow-hidden rounded-2xl" style={{ aspectRatio: '16 / 9' }}>
      <Canvas
        gl={{ antialias: !coarse, alpha: true }}
        style={{ background: 'transparent' }}
        dpr={coarse ? [1, 1.5] : [1, 2]}
      >
        <PerspectiveCamera
          makeDefault
          position={budgetedConfig.camera.position}
          fov={50}
        />
        <OrbitControls
          target={budgetedConfig.camera.lookAt}
          enableZoom
          enablePan={false}
          autoRotate={!reducedMotion}
          autoRotateSpeed={0.5}
        />
        <ParticleSystem config={budgetedConfig} />
      </Canvas>
    </div>
  )
}
