---
name: board-tuning-lab
description: R&D harness for tuning the kanban BOARD (its agents, monitor, and workflow) along a chosen DIMENSION by building an increasingly complex disposable fixture project, driving it through the board, measuring where the workflow breaks, filing the gaps as dev-board tickets, and fixing them end-to-end. Dimension-parameterized — docker/multi-repo, observability, token-efficiency, ticket-sizing, and more added over time. Use for "run the board-tuning lab", "tune the board for <dimension>", "dogfood/stress the board's <X> support", "build a fixture and find gaps in <X>", "exercise the board on docker / multi-repo / observability / token efficiency / ticket sizing", or "improve how the board handles <X>".
allowed-tools: Bash, PowerShell, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion, Skill
---

# board-tuning-lab — tune the board by controlled experiment

You are running a **lab**, not a feature ticket. The deliverable is not the toy
project you build — it's a **measured improvement to the board's own behavior**
along one *dimension*. A ticket "completes" the fixture; a gap **found, measured,
and fixed** completes the lab.

This is a META skill. It exercises the kanban board (project `agentic-kanban`) by
standing up a *separate* fixture project, driving it, watching where the board's
agents / monitor / workflow fall short **for this dimension**, and closing the
gap in the board's code. It generalizes the pattern that was distilled over two
6-hour `/goal` marathon sessions (the docker/multi-repo dogfood) into a reusable,
dimension-parameterized harness.

Read `CLAUDE.md` first — `## Board Operations`, `## Architecture Patterns` (Git
service + Worktrees + Windows/hooks), and `## Server Resilience`. This skill
operationalizes stressing them. Read the relevant `references/<dimension>.md`
before you build, and the linked memory notes so you don't re-litigate settled
ground.

## The invariant loop (dimension-independent)

```
Intake → Baseline → Instrument → Build fixture → Drive → Observe+Measure
→ File → Fix → Verify → Fold back / Record round → (loop or seal)
```

The only thing that changes per dimension is **what you build, what you measure,
and where the fix lives**. The loop, the cardinal rules, and the board mechanics
are constant.

### Cardinal rules (violating these turns a lab back into vibes)

1. **A change without a measurement is a guess.** Every dimension has an
   *instrument* (§Instrument) — decide the metric BEFORE you build, capture a
   baseline, and re-measure after the fix. "Feels better" is not a finding.
2. **Ground truth is the real artifact, never the board's self-report.** For
   multi-repo it's each repo's `main` (`snapshot.py`), not the board summary;
   for token efficiency it's the transcript's billed tokens (`session-inspector`
   fleet tools), not a vibe; for observability it's what the UI actually renders
   (`playwright-cli`), not what the API returns.
3. **Verify the worst finding before you file it.** Repro on the fixture. Prefer
   a few precise, root-caused tickets (Symptom → Root cause `file:line` → Fix →
   Impact) over a long speculative list.
4. **Every fix lands with a test that would have caught the gap**, plus the
   repo's gates (§Fix). A fix without a regression test re-opens next round.
5. **Include a trap and a negative control where the dimension supports it** — a
   case the board must flag/refuse (catches real bugs) and a case it must NOT
   act on (over-triggering erodes trust).

## Phase 0 — Intake + Baseline

- **Pick the dimension.** From the user's args (`tune the board for observability`)
  or, if open, ask. The v1 dimensions and their playbooks:

  | Dimension | What you tune | Playbook |
  |---|---|---|
  | **docker / multi-repo** | atomic multi-repo merge, per-workspace service stacks, DinD, leading-repo blind spots | `references/multirepo.md` |
  | **observability** | monitor/board UI that surfaces multi-workspace + multi-repo health at a glance | `references/observability.md` |
  | **token-efficiency** | agent context/token cost per ticket — prompts, skill materialization, tool-result bloat | `references/token-efficiency.md` |
  | **ticket-sizing** | the enhancer/splitter sweet spot — too-small wastes exploration, too-large stalls | `references/ticket-sizing.md` |

  Adding a dimension later = a new `references/<dim>.md` + a row here. Keep this
  table and the loop stable; put all depth in the reference.

- **Baseline against memory.** Read the dimension's linked memory notes (each
  playbook lists them) and any prior round's un-fixed findings. Do NOT re-run
  settled experiments; DO re-probe fixes that shipped since. The docker/multi-repo
  dimension in particular is marked **SEALED** in memory across 13 rounds — only
  re-open it for a genuinely new topology.
- **Scope the round** with the user if unspecified: set-up only / drive a few /
  full dogfood to merge; new fixture vs extend an existing one; how many tickets.
- **Preflight:** dev server up + healthy (`dev-server` skill); real provider
  (`GET /api/preferences/settings` → `provider` ≠ `mock`); plus any
  dimension-specific tool (Docker daemon, `playwright-cli`, session-inspector).

## Phase 1 — Instrument (decide the metric first)

Before building, write down the ONE number (or per-repo/ per-ticket vector) this
round moves, and how you'll read it. Each playbook names its instrument; e.g.
docker/multi-repo → `scripts/snapshot.py` (per-repo commits-ahead vs each `main`);
token-efficiency → `session-inspector` `token-sinks.mjs` / `waste.mjs` /
`context-growth.mjs`; observability → `playwright-cli` screenshots of the monitor
view; ticket-sizing → exploration-vs-implementation tool-call ratio per ticket.
Capture the baseline reading now — you compare against it after the fix.

## Phase 2 — Build the fixture (stress the dimension)

Build a *disposable* fixture project whose shape **maximizes** the friction the
dimension cares about (details per playbook). General rules:

- Keep services dependency-free (node builtins: `"type":"module"`,
  `test:"node --test"`, a `node:http` server + a `node:test`) so worktrees install
  instantly and setup-script gaps don't mask the feature under test.
- Make the fixture *coherent* (a believable domain) so cross-cutting tickets feel
  real, and **leave the target work unbuilt** (no `/api/version` yet) so seeded
  tickets have real work to do.
- Increasing complexity across rounds is the point — each round adds one axis the
  previous fixture didn't have (a repo, a service, a compose feature, a metric).

## Phase 3 — Register + seed the mix

- Register the fixture as a **separate** project (`pnpm cli -- register <path>`
  from the MAIN checkout, or `POST /api/projects/create`); resolve the UUID.
  Multi-repo: add siblings via `POST /api/projects/:id/repos {"path":"C:/fwd/slash"}`
  (**forward slashes** — backslash JSON via curl → `invalid JSON body`).
- Seed 5–10 issues (`POST /api/issues`) whose **mix is the instrument** — the
  spread is chosen to surface the dimension's gaps (each playbook gives the mix).
  Descriptions name exact repo(s)/file(s), the contract, "add a node:test", and
  "commit in each affected repo".

## Phase 4 — Drive via the board

- Launch workspaces (`POST /api/workspaces {"issueId":"..."}`) — creates the
  worktree(s) + auto-launches the agent (+ per-workspace stack for docker).
- **Use the board's own features** — mark-ready → merge, `update-base` rebase,
  `reconcile-as-done`, review, enhance, dependency-analyze — don't hand-git.
- Stage it: a first wave (one of each kind) to confirm mechanics, then fan out.
- Watch with the dimension's instrument (Phase 1), re-read every couple minutes.

## Phase 5 — Observe + Measure

Walk the dimension's **friction checklist** (in its playbook) against the running
fixture, reading the instrument each time. A gap is a *measured* divergence
between what the board did and ground truth (rule 2). Note the trap/negative-control
outcomes.

## Phase 6 — File findings (DEV board)

File each gap as an `agentic-kanban` issue: `priority` (critical/high/medium),
`issueType` (`bug` vs `feature`), body = **Symptom → Root cause (`file:line`) →
Fix → Impact**. Verify the worst directly first (rule 3). Cross-link memory with
`[[...]]`.

## Phase 7 — Fix (usually the point)

Only if the user asked (they usually do). Per finding:

- **Branch off DEV `master` first** (`git checkout -b feature/<slug>`) — never
  edit master directly. Never work on the DEV repo's master.
- Implement. Schema change → migration `NNNN_*.sql` (highest number lives in the
  **MAIN checkout** `packages/shared/drizzle`) + a `_journal.json` entry with a
  monotonic timestamp, then rebuild `shared/dist` (`npm run build` in
  `packages/shared`) before the server typechecks.
- **Gate before commit:** `npx tsc --noEmit` (server + shared), the affected
  `npx vitest run <patterns>` (from the worktree), `node scripts/check-god-modules.mjs`
  (facade-extract any file crossing 1000 lines), and the `git-exec-single-spawn`
  / `barrel-client-safety` / `migration-schema-drift` gates. Add a focused
  regression test per fix (rule 4). Run `scope-guard` before commit.
- Commit per ticket (message ends with the `Co-Authored-By` trailer from CLAUDE.md).
  Merge `--no-ff` and push **only when the user asks**. If a migration landed,
  restart the dev server so it applies, and verify the new columns via the API.

## Phase 8 — Fold back + record the round

- **Clean up:** tear down every `ak-*` compose project (`docker compose -p <name>
  down -v`) — leave co-tenant stacks (`shift_app`) alone; prune toy worktrees
  (`git worktree remove --force`); confirm 0 `ak-*` containers.
- **Record the round in memory** (the durable cross-round log this lab relies on):
  the fixture's current shape, any new root-caused class, and whether the
  dimension is now sealed or has a named residual. Update `MEMORY.md` pointers.
- **Fold a hard-won gotcha back into the playbook** (`references/<dim>.md`) so the
  next round inherits it — this skill compounds only if lessons land in it.

## Cross-dimension gotchas (don't relearn)

- **CLI runs from the MAIN checkout; vitest runs from the worktree** (worktrees
  lack `packages/shared/dist`; use MCP/REST from a worktree). New worktrees
  install real deps (symlinks OFF here) — `pnpm install` in one is safe.
- **PowerShell/REST writes:** use `curl` (Bash) or MCP for API writes —
  `Invoke-RestMethod -Method Put/Patch` silently no-ops. Never name a var `$pid`
  (read-only automatic → REST hits the wrong id).
- **Branch names get truncated** by `suggestBranchName` — match the real ref
  (`git branch --list <prefix>*`), don't assume the full title.
- **Never `db:reset` / delete `kanban.db`** — findings and fixtures aside, the
  board's own DB is sacred (CLAUDE.md hard constraint).
- **Marathon-session cost is real:** these runs hit 500k+ peak context over 6h.
  Use `/clear` between rounds, drive with a leaner provider where the dimension
  allows, and mind the token-efficiency lens on yourself.

## Bundled tooling

- `scripts/snapshot.py <projectId> [boardPort]` — read-only per-workspace,
  per-repo commits-ahead view (ground truth for multi-repo; see `references/multirepo.md`).
