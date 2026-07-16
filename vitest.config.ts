import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Vitest has three project-shaped test suites:
//   - convex edge-runtime tests that use convex-test to simulate queries,
//     mutations, actions, and scheduled jobs against an in-memory backend.
//   - src unit tests: node-env pure unit tests for utilities and validators.
//   - src DOM tests (*.dom.test.tsx): jsdom tests for React components.
//
// Keeping them in one file (via test.projects) means a single `bun run test`
// command runs everything, with the right runtime per suite.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
        test: {
          name: "convex",
          environment: "edge-runtime",
          include: ["convex/**/*.test.ts"],
          server: { deps: { inline: ["convex-test"] } },
        },
      },
      {
        extends: true,
        plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.dom.test.tsx"],
        },
      },
    ],
  },
});
