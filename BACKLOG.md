---
kanban-md: 1
project: agentic-kanban
exported: 2026-09-05T11:05:11.327Z
statuses: Backlog, Todo, In Progress, In Review, AI Reviewed
filter: status=open
issues: 3
---

# agentic-kanban — backlog

<!-- Backlog Markdown (kanban-md 1). One `##` per status column, one `###` per issue; the backtick line under a heading is its metadata. Edit freely and re-import — issues match by #number, then by title. Spec: docs/backlog-markdown.md -->

## Backlog

### #1037 Prove (or refute) the mechanism behind the #1033 node_modules wipe — the guard is a stopgap aimed at an unproven door
`priority: low` · `type: bug` · `created: 2026-09-05` · `updated: 2026-09-05`

Follow-up to #1033, which closed on its MITIGATIONS while its root-cause half stayed open.

#### What is not known
On 2026-09-04 the MAIN checkout's `node_modules` top-level links (root + every package) were
wiped twice, 30-50s after `pnpm dev` was launched from a nested `<main>/.claude/worktrees/*`
worktree. `.pnpm` and `.modules.yaml` were untouched in both wipes, which is the signature of a
pnpm `--force` purge aborted by EPERM before it relinked. **How a pnpm run with a nested cwd
reached main's importers at all is not proven.** No junction between the trees was found
afterwards, and no purge tool on this box was shown to follow one (measured: node `rmSync`,
`robocopy /MIR`, `Remove-Item -Recurse`, `git worktree remove`, `rm -rf`, `rmdir /s`).

#### Why it still matters
Everything #1033 shipped is a stopgap that assumes the hypothesis without testing it:
`validate-command-safety` refuses installs and the dev launcher from a nested cwd, and CLAUDE.md
says to put dependency-carrying checkouts outside the main tree. Both are correct advice either
way — but if the real mechanism is something else (a workspace-state file, a virtual-store path
collision, a pnpm version behaviour), then the guard is aimed at the wrong door and the same
wipe can arrive through another one. A guard nobody can explain is also a guard nobody will
dare to relax.

#### Shape of the work
Reproduce it deliberately in a throwaway tree — a scratch repo with the same nested-worktree
layout, main's `node_modules` populated, `pnpm install --force` from the nested cwd — and watch
what the process actually touches (Process Monitor, or `pnpm --loglevel=debug`). Confirm or kill
the EPERM-abort hypothesis. Then either narrow the guard to what is genuinely dangerous, or
widen it if the reproduction shows a second path in.

Not urgent: the stopgap holds and the failure is cheap to recover from
(`pnpm install -r --offline` in main, seconds). It is a knowledge gap, not an outage.

#### Acceptance
Either a reproduction that names the mechanism, with the guard adjusted to match — or a written
record that a bounded attempt failed to reproduce it, so the next session does not start over.

### #1038 CLI resolves relative file paths against packages/server, not the invocation dir — 'backlog export --out BACKLOG.md' silently writes the wrong file
`priority: medium` · `type: bug` · `created: 2026-09-05` · `updated: 2026-09-05`

#### What happens
`pnpm cli -- backlog export --out BACKLOG.md` run from the repo root writes
`packages/server/BACKLOG.md`, not `./BACKLOG.md`. Measured 2026-09-05: the run printed
`wrote BACKLOG.md (2 issue(s))` and left an untracked file in `packages/server/`, while the
stale root `BACKLOG.md` (4 issues, exported 2026-09-04) was untouched. The success message
names the relative path, so nothing about the output says the file went somewhere else.

#### Why
`pnpm cli --` is `pnpm --filter agentic-kanban exec node … src/cli/index.ts`, which runs with
cwd = `packages/server`. A relative `--out` therefore resolves against the package directory.
Every doc that says `pnpm cli -- backlog export --out BACKLOG.md` (root CLAUDE.md's Board
Operations section, `docs/backlog-markdown.md`) is telling the operator to do the thing that
silently misses.

#### Why it matters beyond the annoyance
The failure is silent and it looks like success — the operator believes the committed backlog
was refreshed, and the stale one stays in the diff-free state that makes it look current. That
is the same class of problem as a CONTINUE.md describing a state that no longer exists: worse
than absent, because it gets believed.

#### Shape of the fix
pnpm sets `INIT_CWD` to the directory the command was invoked from. Resolve relative file
arguments against `process.env.INIT_CWD ?? process.cwd()` at the CLI's argument boundary — not
per command, or the next command to take a path will have the same bug. Applies to at least
`backlog export --out` and `backlog import <file>`; audit for other path-taking options
(`issue create --description-file`, `issue create-batch <jsonFile>`).

Print the ABSOLUTE resolved path in the success message either way, so a wrong answer is
visible instead of silent.

#### Acceptance
From the repo root, `pnpm cli -- backlog export --out BACKLOG.md` writes the repo-root file; a
test covers the resolution helper with INIT_CWD set and unset; the success line names the
absolute path.

## Todo

_(empty)_

## In Progress

_(empty)_

## In Review

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

## AI Reviewed

_(empty)_
