# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: shauryapunj404@gmail.com
Subject: `[FIREFLY SECURITY] <brief description>`

Provide repro + impact + suggested fix. Acknowledgement within 48 hours. GitHub's "Security › Report a vulnerability" tab is also accepted.

## Security Controls

- Direct bumps: @excalidraw/excalidraw ^0.18.1, nitro ^3.0.260429-beta, vite ^7.3.5.
- TanStack Start chain pinned to a coherent set (@tanstack/react-start ^1.168.26 and friends) so @tanstack/start-server-core resolves to the patched ^1.169.x and pulls patched h3.
- Top-level `overrides` (honored by bun, the deploy package manager): @xmldom/xmldom ^0.9.10, dompurify ^3.4.0, h3 ^2.0.1-rc.18, nanoid ^3.3.8, postcss ^8.5.10.
- A `pnpm.overrides` mirror is retained for pnpm users.
- CodeQL `security-extended` on push, PR, and weekly schedule (JS/TS).
- Dependabot weekly with `semver-major` ignored.
- Branch protection on `main`: required CodeQL check, linear history, no force-push, no deletion, conversation resolution required.
