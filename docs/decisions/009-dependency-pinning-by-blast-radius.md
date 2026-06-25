# Decision 009: Dependency pinning policy by blast radius

## Date: 2026-06-25

## Context

`#873` exact-pinned the correctness-critical core — the DB driver (`@libsql/client`),
ORM (`drizzle-orm` / `drizzle-kit`), the MCP wire protocol (`@modelcontextprotocol/sdk`),
and the agent SDK (`@anthropic-ai/claude-agent-sdk`) — and added `engines.node`. Good as
far as it went, but the split was effectively drawn by **familiarity**: the deps that felt
fragile (pre-1.0, "we've been bitten") got pinned; the rest were left to float.

`#900` (arch review) flagged the gap: the **transport / IPC surface still floated with `^`**:

- `hono ^4.12` + its node adapters (`@hono/node-server`, `@hono/node-ws`) — the HTTP/WS server
- `zod ^3.24` — the request/response **wire-validation** layer
- every `@tauri-apps/*` (`^2.x`) — the desktop IPC bridge (api, cli, plugins)

A `^` minor of hono or a Tauri plugin can land on the next clean `pnpm install` and change
middleware ordering / IPC behaviour **with no lockfile-reviewed intent** — the exact same
silent-drift risk `#873` pinned the core against, just on the edges of the system rather than
the centre. Whether a dep "feels" stable is the wrong axis.

## Decision

**Pin (exact) by blast radius, not by familiarity.** A dependency is pinned to an exact
version iff a silent minor bump could **change runtime behaviour without surfacing at
build/test time** — i.e. it can reach production undetected. Two buckets qualify:

1. **Correctness-critical core** (`#873`): `@libsql/client`, `drizzle-orm`, `drizzle-kit`,
   `@modelcontextprotocol/sdk`, `@anthropic-ai/claude-agent-sdk`.
2. **Transport / IPC surface** (`#900`): `hono`, `@hono/node-server`, `@hono/node-ws`,
   `zod`, and every `@tauri-apps/*`.

**Deliberately left to float (`^`):** the UI / build tooling — `react` / `react-dom`,
`vite`, `tailwindcss`, `eslint`, `typescript`, `tsx`, etc. A bad minor there fails **loudly
and immediately** at typecheck / build / test time; it cannot drift into production unseen, so
the silent-drift argument does not apply and pinning would only add upgrade churn. (`react`
and `vite` appear in the `#900` ticket's "floats" list, but they are UI/build surface, not
transport/IPC — they stay floating under this policy.)

## Enforcement

`packages/shared/__tests__/dependency-pinning.test.ts` is the gate. It scans every package
manifest (`dependencies` + `devDependencies`) and fails on any caret/tilde/range spec for a
name in `MUST_BE_EXACT` or matching a `MUST_BE_EXACT_PREFIXES` entry (the `@tauri-apps/*`
family). It also asserts the root `engines.node` constraint. It runs in `test:mine` → `pnpm
check`.

## To upgrade a pinned dep

Bump the exact version in the manifest(s) **and** the lockfile in the **same commit**, run
`pnpm check`, and review the diff. The pin makes the upgrade a deliberate, reviewable manifest
change instead of a lockfile drift.
