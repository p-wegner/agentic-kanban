# Contributing to agentic-kanban

Thanks for wanting to contribute. This file is deliberately short: the project's
operating rules already live in a few canonical places, and restating them here would
only let them drift. This guide routes you to the right one and describes the path from
fork to pull request.

## Before you start

- **Read [CLAUDE.md](./CLAUDE.md)** — it is the canonical rulebook for this repository
  (`AGENTS.md` points to it for the same reason). The hard constraints, scope
  discipline, and board conventions defined there apply to all contributions, human or
  agent.
- **Issues are the channel.** There are no Discussions or a wiki. Comment on an existing
  issue or open one before starting larger work, so scope can be agreed first.
- **Scope discipline** (from CLAUDE.md, worth repeating): change only what the task
  requires. Don't fix unrelated issues, rename or reformat out of scope, or add features
  in passing — file an issue for those instead.

## Setup

Prerequisites and clean-clone gotchas are maintained in [docs/install.md](docs/install.md).
In short: Node.js LTS 22 (the supported floor — avoid odd-numbered releases) and pnpm 10, then:

```bash
pnpm install    # also builds packages/shared/dist
pnpm db:setup   # migrate + seed + register this repo as a project
pnpm dev        # server :3001, client :5173
```

For a stable board that survives your dev server crashing, see the two-boards setup in
[docs/two-boards.md](docs/two-boards.md).

## Quality gates

Run before opening a PR. CI runs the first of these on every PR into `master`
(`.github/workflows/arch-gate.yml`), plus Docker smoke tests and a security scan.

| Command | What it does |
|---|---|
| `pnpm check:arch` | The composite architecture gate of record: god-module ceilings, dependency-cruiser layering, MCP catalog parity |
| `pnpm typecheck` | TypeScript across the whole workspace |
| `pnpm lint` | ESLint (`pnpm lint:strict` for zero warnings) |
| `pnpm test:unit` | Full unit suite (Vitest) |

`pnpm check` bundles the first three with `test:mine` (impact-targeted unit tests);
`pnpm check:full` adds E2E (Playwright) and a full build.

Some conventions are enforced by ratchet tests that run in CI (the env-var inventory in
[docs/env-vars.md](docs/env-vars.md), time-injection spellings, BOM-free files,
shrink-only baselines). If your change trips one, the failing test's message tells you
what to update.

## Pull requests

- Keep PRs small: one logical change, tests included for behavior changes, no unrelated
  fixes.
- Commit subjects in this repository follow `type(scope): summary` — see `git log` for
  examples. Note that `#N` in existing messages refers to kanban board issue numbers,
  not GitHub issues or PRs.
- New agent-facing surface has dedicated docs: plugins in
  [docs/plugin-development.md](docs/plugin-development.md), and bundled agent skills are
  generated (`pnpm skill:generate`, verified by `pnpm skill:check`) rather than
  hand-edited.

## Reporting bugs

Open a GitHub issue with: what you did, what you expected, what happened, and the
relevant server/client console output. For anything database-related, describe the
behavior — never attach or send a database file (CLAUDE.md's hard constraints explain
why the database is treated as irreplaceable).
