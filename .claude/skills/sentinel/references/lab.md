# The lab: tune the board, or the Sentinel, by controlled experiment

**Read this only on an explicit lab request** ("run the board-tuning lab", "tune the board for
<dimension>", "lab the Sentinel", "dogfood/stress the board's <X> support"). **A Sentinel wakeup
never reads this file and never runs a lab step**: a wakeup is one check pass, and a lab builds
fixtures, drives workspaces, files tickets and edits code, none of which a watch may do.

This lab used to be its own skill, `board-tuning-lab`. It was folded into `sentinel` as an
integrated lab on 2026-09-19. Two things did not come across, on purpose:

- **No pre-approved tools.** The old skill pre-approved `Write, Edit, Agent, Skill` and more.
  Sentinel carries none, because it runs unattended on a loop and its rule is the least invasive
  recovery. A lab session therefore gets the normal permission prompts.
- **No description of its own.** "Check the board monitor" and "tune the board for X" are
  opposite requests, so the lab is not in sentinel's description. It is reached from the
  `CLAUDE.md` Skill Map row and from the last section of sentinel's `SKILL.md`.

## Targets

Two kinds of target share this file. They differ in what gets tuned and where the fix lands.

| Target | What is tuned | Form | Fix lands in | Card |
|---|---|---|---|---|
| **Board, per dimension** | the board's agents, monitor and workflow | experiment rounds on a disposable fixture project (the loop below) | board code, with a regression test | the dimension table in Phase 0 + `references/lab/<dimension>.md` |
| **Sentinel** | the watch itself: its checks, its verdicts, its recoveries, its one line | eval rounds over recorded wakeups (default form, no recorded run) | `sentinel/SKILL.md` (and its `.codex` mirror) | [§ Sentinel target card](#sentinel-target-card) |

**Which parts of the board loop apply to the Sentinel target:** the cardinal rules 1, 2 and 5
(metric before change; ground truth over self-report, which is also the Sentinel's own golden
rule; a trap and a negative control), and the token-efficiency instrument (`session-inspector`
fleet tools), pointed at the Sentinel's own wakeup transcripts instead of builder transcripts.
**What does not apply:** building a fixture, registering and driving it, filing dev-board
tickets, the Phase 7 board-code gates, `snapshot.py`, and the Phase 8 docker cleanup.
The observability dimension's condition list (stalled, stuck review, healthy control) overlaps
the Sentinel's checks, but its instrument is the board UI and its fix is client code, so it
stays a board target.

---

# Board target: tune the board by controlled experiment

You are running a **lab**, not a feature ticket. The deliverable is not the toy
project you build — it's a **measured improvement to the board's own behavior**
along one *dimension*. A ticket "completes" the fixture; a gap **found, measured,
and fixed** completes the lab.

It exercises the kanban board (project `agentic-kanban`) by
standing up a *separate* fixture project, driving it, watching where the board's
agents / monitor / workflow fall short **for this dimension**, and closing the
gap in the board's code. It generalizes the pattern that was distilled over two
6-hour `/goal` marathon sessions (the docker/multi-repo dogfood) into a reusable,
dimension-parameterized harness.

Read `CLAUDE.md` first — `## Board Operations`, `## Architecture Patterns` (Git
service + Worktrees + Windows/hooks), and `## Server Resilience`. This lab
operationalizes stressing them. Read the relevant `references/lab/<dimension>.md`
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
  | **docker / multi-repo** | atomic multi-repo merge, per-workspace service stacks, DinD, leading-repo blind spots | `references/lab/multirepo.md` |
  | **observability** | monitor/board UI that surfaces multi-workspace + multi-repo health at a glance | `references/lab/observability.md` |
  | **token-efficiency** | agent context/token cost per ticket — prompts, skill materialization, tool-result bloat | `references/lab/token-efficiency.md` |
  | **ticket-sizing** | the enhancer/splitter sweet spot — too-small wastes exploration, too-large stalls | `references/lab/ticket-sizing.md` |
  | **devcontainer** | builders running INSIDE a container (not host processes) — auth, mounts, path/env translation, host↔container parity | `references/lab/devcontainer.md` |

  Adding a dimension later = a new `references/lab/<dim>.md` + a row here. Keep this
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
docker/multi-repo → `.claude/skills/sentinel/scripts/snapshot.py` (per-repo commits-ahead vs each `main`);
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
- **Fold a hard-won gotcha back into the playbook** (`references/lab/<dim>.md`) so the
  next round inherits it — this lab compounds only if lessons land in it.

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

- `.claude/skills/sentinel/scripts/snapshot.py <projectId> [boardPort]` — read-only per-workspace,
  per-repo commits-ahead view (ground truth for multi-repo; see `references/lab/multirepo.md`).

---

# Sentinel target card

**Status: scaffolded 2026-09-19, never run.** The form is a default with no recorded run behind
it. The Sentinel has real runs (five sessions, 2026-09-03 to 09-16, several hundred wakeups) and
no tune record, so round 1 is a **tune round over recorded wakeups**, not a live experiment.
Nothing in this card touches the live board: no endpoint call, no loop restart, no staged fault.

| Field | Value |
|---|---|
| `use_case` | a person away from the board learns from one line whether the Conductor needs them, and trusts that the Sentinel only did what was safe |
| `consumer` | the human operator, reading the healthy line or the `⚠️` alert. In a round: 2 blind readers who get only the Sentinel's lines for a window |
| `under_tune` | `sentinel/SKILL.md`: the check list, the interpretation table, the recovery playbook, the output format, the wakeup cadence |
| `questionnaire` | from the lines alone: is the loop alive · is it pulling work · does anything need me, and what · did the Sentinel act, and why · which board version is live · which strategy is it steering by |
| `state_catalogue` | each wakeup in a tuning window is labelled with one state, and the key says the right verdict and action for it (next table) |
| `key_source` | ground truth at each wakeup's timestamp, rebuilt from `loop.log`, the git history of `state.md`, merges in git, `promote.log` and the stable checkout's tags. Built by a key agent that never sees the Sentinel's own lines, so the key cannot be shaped by the output it grades |
| `metrics` | verdict accuracy per state · **unwarranted recoveries** (weighted highest: a kill or restart is not undoable) · false alarms on the negative controls · missed alerts · tokens per healthy wakeup (`session-inspector` `token-sinks` / `context-growth` on the wakeup session) · healthy-line length |
| `sessions` | tuning: `843ff1dc` (2026-09-15, the longest) and `3041091b` (09-16). Held-out: `5fa090e8` (09-03, before the promote-log split, so it also tests the check-7 wording) |
| `rounds`, `readers` | 3 rounds for the first run, 2 readers per tuning session, 1 held-out graded at the end against the pre-lab `SKILL.md` |
| `baseline_sha` | the `sentinel/SKILL.md` blob before this lab: `git show 2553d24b3a:.claude/skills/sentinel/SKILL.md` |
| `data_location` | scratch only. Wakeup transcripts read the settings and profile endpoints and may carry credentials: never copy a value out of them. The repo gets the card, the numbers and the `SKILL.md` diff |

**States the key labels, with the verdict the Sentinel should reach.** Rows marked *control* are
negative controls: the right answer is one calm line and no action.

| State | Right verdict | Right action |
|---|---|---|
| healthy (*control*) | one line | none |
| `In Progress 0` between cycles (*control*) | one line | none |
| In Review lingering, issue already `Done` (*control*) | one line after an issue-level check | none |
| `health=000` briefly, then 200 (*control*) | one line | none |
| `STAND DOWN: active WIP in main checkout` (*control*) | one line naming the stand-down | **none**; never touch the WIP |
| profile `mock` or blank | alert | restore `anth` only if no human is working |
| loop wedged (driver alive, no `iteration END`, gap much larger than the interval) | alert | kill the pid in `loop.pid`, relaunch |
| launch-failure guard tripped (3 sub-8 s exits, loop gone) | alert naming the log line | fix the launch first; no blind restart |
| stable HEAD on `failed-promotion-*` / ROLLBACK tail | one line naming the fallback tag | **never re-promote** |
| weekly planning pass overdue (> 7 days) | a prompt to the person | none. *Trap:* `scripts/board-monitor/README.md` says the Sentinel prompts for this; `SKILL.md` has no such step, so today's Sentinel is expected to miss it. Decide which text is wrong before scoring it |

**One round:** freeze this card → the key agent labels every wakeup of the tuning sessions →
readers answer the questionnaire from the lines → a judge (not the author) scores against the key
and marks each finding *mechanical* (a check or command is wrong) or *judgement* (a verdict or
wording) → one change to `SKILL.md`, mirrored into `.codex/skills/sentinel/` → the next round
re-scores the same wakeups. A **re-scored recorded wakeup only grades the reading of a state,
never the new commands**: a changed check needs a live pass before it is called verified.

## Runs so far

| Date | Target | Rounds | Result |
|---|---|---|---|
| to 2026-07-19 | board: docker / multi-repo | 13 | SEALED, no known blind spot (project memory `multirepo-leading-repo-blindspot`) |
| 2026-07-19 | board: ticket-sizing | 1 | decompose splitter gained an atomic floor (`decompose-sizing.ts`) |
| 2026-07-20 | board: devcontainer | 1–3 | #132–#138 fixed; #139, #140 open (memory `devcontainer-builders-round1`) |
| 2026-07-26 | board: greenfield bootstrap (no playbook) | 1 | one large ticket about 3x cheaper than fine decomposition (memory `greenfield-bootstrap-ticket-sizing`) |
| — | board: observability, token-efficiency | 0 | playbooks written, never run |
| — | Sentinel | 0 | card above, never run |
