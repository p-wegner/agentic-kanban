---
kanban-md: 1
project: agentic-kanban
exported: 2026-09-04T13:54:42.422Z
statuses: Backlog, Todo, In Progress, In Review, AI Reviewed
filter: status=open
issues: 4
---

# agentic-kanban — backlog

<!-- Backlog Markdown (kanban-md 1). One `##` per status column, one `###` per issue; the backtick line under a heading is its metadata. Edit freely and re-import — issues match by #number, then by title. Spec: docs/backlog-markdown.md -->

## Backlog

### #1020 Producer side: BACKLOG_FLOOR 15, refill back on for the dev project, weekly planning checklist in the board-monitor README
`priority: medium` · `type: task` · `depends: #1013` · `created: 2026-09-04` · `updated: 2026-09-04`

#### Why
Proposal `docs/proposals/2026-09-03-dev-board-vs-deployed-board.md` §3.D (producer side): Yegge's balance needs stock. `objective.md` says "DRAIN THE BACKLOG, DO NOT REFILL", the board has ~1 open ticket, and a stable board with three builders would be empty in a day. Only makes sense once the stable/dev split exists (the dev board is what gets fed).

#### What
- `objective.md` FOCUS POLICY: `BACKLOG_FLOOR` 15 gate-sized tickets; refill via `backlog-refill` + `ticket-enhancer`; group with `coupled_with` (#661) at creation.
- Refill sources, in order: `BACKLOG.md`, `docs/proposals/*`, open items in `CONTINUE.md`, the general architecture plan's Phase 1-2 items.
- The weekly planning pass (the Crew role) is a human ritual, not code: write it into `scripts/board-monitor/README.md` as a checklist so a Sentinel can prompt for it.

#### Acceptance
Refill is on for the dev project, the floor holds for a week, and no refilled ticket is a few-minutes change (CLAUDE.md sizing rule).

### #1033 pnpm install inside a .claude/worktrees/* worktree wipes the MAIN checkout's node_modules links (twice, 2026-09-04): root-cause, safe-rmdir, junction-free boot-dist smoke, CLAUDE.md rule
`priority: high` · `type: bug` · `created: 2026-09-04` · `updated: 2026-09-04`

#### What happened
2026-09-04 12:41:56: every `node_modules` in the MAIN checkout (`C:\projects\andrena\agentic-kanban`, root + all packages) lost its top-level package links at once (root left with 8 entries, no `typescript`, no `vitest` anywhere; `node_modules/.pnpm` untouched, mtime 2026-08-24). The Stop-hook typecheck then failed in all five packages with `Cannot find module .../node_modules/typescript/bin/tsc`. `pnpm install -r --offline` restored the links in seconds; the running dev server survived because its modules were already loaded.

#### Second occurrence and the correlation
It happened again at 12:45:25, seconds after `pnpm install -r --offline` had restored the links. Both wipes line up with `pnpm install -r --prefer-offline` / `--force` runs by an agent inside `.claude/worktrees/agent-a4f985c7d4f1a39cb` (10:38 and 10:45 UTC): main's top-level links and 16 `node_modules/.pnpm/*` entries vanished while main's `.modules.yaml` kept its 2026-08-24 mtime, so no install ran IN main - something deleted through main. No reparse point was found afterwards in either tree. Every agent worktree this session reported the same symptom from the other side: "install reports up-to-date but packages/*/node_modules holds 6 entries", "`--force` dies with EPERM on lightningcss-win32-x64-msvc" (a file held open by MAIN's running vite). Working hypothesis: pnpm in a worktree that lives UNDER the main repo (`<main>/.claude/worktrees/*`) shares or confuses state with the outer workspace (virtual store / workspace-state / hoisting), so its prune step deletes the outer links. Until proven otherwise: never `pnpm install` in a `.claude/worktrees/*` worktree while main is live; place agent worktrees OUTSIDE the main checkout (the board's own `.worktrees/` sibling layout never showed this).

#### Why it matters
Several agents were cleaning up finished `.claude/worktrees/agent-*` directories at that time with `robocopy /MIR <empty> <dir>` because `git worktree remove` fails on long pnpm paths. A mirror-purge that meets a junction pointing OUTSIDE the tree deletes the junction's TARGET contents. Two components deliberately create such junctions into the live checkout:
- `scripts/boot-dist-smoke.mjs` (#1012) junctions the main checkout's `node_modules` (root + packages) into its throwaway worktree under `%TEMP%\ak-boot-dist-*`; its cleanup removes the junctions before the tree, but anything else that purges that temp dir (a crash, a later cleanup, a TEMP sweeper) walks into main.
- ad-hoc agent workarounds (an agent junctioned main's `node_modules` into its worktree when the per-worktree install was incomplete; see #1019's report).
Root cause not proven — no junction was found afterwards — but the shape (links gone, store intact, at cleanup time) matches exactly.

#### What to do
- `scripts/boot-dist-smoke.mjs`: mark the junctions so they are recognisable (a sidecar file naming them) and prefer `pnpm install --offline` in the throwaway worktree over junctions when the store is warm (measure; ~10 s per CLAUDE.md), or at least `--no-junction` as an option.
- A tiny `scripts/safe-rmdir.mjs` (or a `cleanup` skill step) that refuses to delete a tree containing reparse points whose target is outside the tree, and use it in the `cleanup` skill and in agent instructions instead of `robocopy /MIR`.
- Document in CLAUDE.md "Worktrees": never mirror-purge a directory without checking `fsutil reparsepoint query` / `Get-Item -Force | ? Attributes -match ReparsePoint` first.
- Optional: the Stop hook's typecheck could recognise "tsc binary missing in every package" as environment damage and say `run pnpm install -r --offline` instead of reporting a code break.

#### Acceptance
`safe-rmdir` refuses a fixture tree with an outbound junction and deletes one without; the smoke script no longer leaves an outbound junction between two of its own steps that a crash could strand; CLAUDE.md carries the rule.

## Todo

_(empty)_

## In Progress

_(empty)_

## In Review

### #1013 Split the stable board from the dev board: second checkout on tag stable serves 3001/5173 + today's DB, dev board on 3101/5273 with its own DB
`priority: high` · `type: task` · `depends: #1012` · `created: 2026-09-04` · `updated: 2026-09-04`

#### Why
Proposal `docs/proposals/2026-09-03-dev-board-vs-deployed-board.md` §3.A: the board develops itself in the same process that operates it (`pnpm dev` = `tsx watch` on the main checkout). Every merge restarts the server driving the merge; a red master is a broken board, so every gate must be complete, so gates take 10-40 minutes and get discarded. Splitting the **stable board** (operates everything, incl. the `agentic-kanban` project) from the **dev board** (fixtures only, may be red) is the lever the rest of the proposal depends on.

#### Target
| | Stable board | Dev board |
|---|---|---|
| Checkout | second checkout of this repo on tag `stable` | this checkout |
| Process | built artifact from `dist/` (see the boot-from-dist ticket) | `pnpm dev` |
| Ports | 3001 / 5173 (unchanged, so MCP configs, skills, hooks keep working) | 3101 / 5273 |
| DB | today's `kanban.db`, pinned via `KANBAN_DB_URL` | own DB (snapshot or empty + fixture projects from `exp/`) |
| Registered projects | all, incl. `agentic-kanban` | fixtures only, never its own checkout |

#### What
- Make the dev board's port/DB selection a documented one-command mode (`pnpm dev` with an env or a script) so 3101/5273 + own DB is not hand-assembled each time.
- Runbook in `docs/` + the `dev-server` skill: how to start/stop each board, which one the MCP configs in `~/.claude*` point at (port unchanged, so presumably nothing changes: verify), and the rule "exactly one board registers `agentic-kanban`" (prevents the branch-holder collision #110).
- The stable checkout is a foreign repo for the cross-worktree guard (#959), so builders cannot write into it. Confirm, do not assume.
- Hooks find the main checkout via `KANBAN_MAIN_CHECKOUT`; state which checkout that must name for builders of the dev board.

#### Out of scope
The `promote` script (own ticket). A second repository: a second checkout of the same repo is enough.

#### Acceptance
Both boards run at once on this machine; a deliberately red master on the dev checkout does not affect the stable board; the runbook was followed cold by a second session.

### #1014 promote script: nightly-sweep-green -> tag stable-YYYYMMDD -> fast-forward stable checkout -> build/migrate/restart -> smoke or roll back
`priority: high` · `type: task` · `depends: #1013` · `created: 2026-09-04` · `updated: 2026-09-04`

#### Why
Proposal `docs/proposals/2026-09-03-dev-board-vs-deployed-board.md` §3.A "Promotion" (Yegge's Drawbridge): once the stable board is a separate checkout, master reaches it by a timed promotion, not per merge. That is the one moment the full suite decides anything.

#### What
`scripts/promote.mjs` (`pnpm promote`) that
1. checks the last nightly full sweep on master was green (read the `base_branch_health` row written by `recordBaseSweepOutcome`, not a re-run),
2. tags `stable-YYYYMMDD` on that sha,
3. in the stable checkout: fast-forward to the tag, build, run migrations, restart,
4. smoke: `/health`, `list_projects`, one `get_board_status`; on failure fast-forward back to the previous `stable-*` tag, rebuild, restart, and say so.

Timed (once a day, idle) or by hand. Never per merge. Log every step to a file the Sentinel can read.

#### Acceptance
A dry run prints the sha, tag, and each step; a forced smoke failure rolls back to the previous tag and the stable board answers `/health` afterwards.

## AI Reviewed

_(empty)_
