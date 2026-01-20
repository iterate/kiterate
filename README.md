# kiterate

Tactical notes for running the repo. The longer-term vision and design notes live in `PLAN.md`.

## Quick start

```bash
pnpm install
pnpm dev
```

`pnpm dev` uses `doppler run -- node dev.mjs`, so you will need the Doppler CLI configured for local dev.

## Mix and match backends/frontends

Everything talks to the same event stream API (append + stream), so backends and frontends are designed to be swappable.

```bash
pnpm dev [folder-in-server] [folder-in-web]
```

- Backends are subdirectories in `server/`
- Frontends are subdirectories in `web/`
- The CLI lives in `cli/`
- Port 3001 is the backend; port 3000 is the frontend

Examples:

```bash
pnpm dev basic
pnpm dev harness-wrapper
pnpm dev basic basic
pnpm dev harness-wrapper basic
```

## Tap the raw event stream

```bash
pnpm tsx cli/basic/main.ts /opencode/hulloklajd stream --live
```

## Tests and checks

```bash
pnpm typecheck
pnpm lint
pnpm lint:check
pnpm format
pnpm format:check
```

Package-level tests:

```bash
pnpm --filter @iterate-com/daemon test
pnpm --filter @iterate-com/daemon test:watch
pnpm --filter @iterate-com/daemon test:e2e
pnpm --filter @kiterate/server-harness-wrapper test
pnpm --filter @kiterate/server-harness-wrapper test:watch
```

Smoke tests for the event stream:

```bash
./smoke-test.sh
./smoke-test.sh basic
./smoke-test.sh harness-wrapper
```
