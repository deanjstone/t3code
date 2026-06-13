# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

**ARCHIVED.** T3 Code was an early-stage web GUI for coding agents (Codex-first, with Claude support planned). It was abandoned — no successor project exists. The original agent instructions are in `AGENTS.md`.

## Commands

```bash
bun install        # install deps (uses bun, not npm)
bun fmt            # format
bun lint           # lint
bun typecheck      # type check
bun run test       # run tests via Vitest (never `bun test`)
```

All three of `bun fmt`, `bun lint`, and `bun typecheck` must pass before any task is considered complete.

## Architecture

Turbo monorepo with four packages:

- `apps/server` — Node.js WebSocket server. Starts `codex app-server` (JSON-RPC over stdio) per provider session; proxies structured events to the browser.
- `apps/web` — React/Vite UI. Session UX, conversation/event rendering, client-side state. Connects via WebSocket.
- `packages/contracts` — Shared Effect/Schema schemas and TypeScript types for WebSocket protocol, provider events, and model/session types. Schema-only, no runtime logic.
- `packages/shared` — Shared runtime utilities for both server and web. Explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

Key server files: `codexAppServerManager.ts` (session lifecycle), `providerManager.ts` (provider dispatch), `wsServer.ts` (WebSocket NativeApi routing).
