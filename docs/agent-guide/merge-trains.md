# Merge trains: how a batch of tickets reaches master

Operator view: what a train does, what each risk posture changes about it, what happens on red,
and where to look when it is stuck. Code-level detail: `architecture-notes.md` (red strategy
paragraph), `pre-merge-gate.md` (gate tiers), decision 017 (postures), decision 020 (flush trains).

## The life of a train

1. **Ready.** A ticket's workspace is built (and, unless the posture skips it, reviewed) and
   marked `readyForMerge`. Under a posture with `trainMaxSize > 1` (`fast`, `sprint`) it does not
   merge alone; it waits in the **train window**. `strict`, `standard`, `iterate` and `flow` use
   size 1, so every ticket is its own one-member "train".
2. **Window closes** at `train_max_size` members or after `train_max_wait_ms`, whichever comes
   first, and releases everything waiting (it can release more than the size; on 2026-10-17 it
   released 15 at size 12). Log line: `[auto-merge] train window closed ... (max_size, size 12/wait 1800000ms): releasing 15 workspace(s)`.
   `pnpm cli -- train depart <project>` closes it now.
3. **Assembly.** The board creates a train worktree under
   `.worktrees/<project>/train/kanban_train_<label>` and merges every member onto the base.
   **A member that conflicts with an earlier member is deferred to the next train**
   (`[merge-train] deferred <branch> (#N) from train ...: conflicts with ...`). Nothing resolves
   the conflict, so a pair that keeps conflicting can miss train after train (#1562 vs #1560
   missed two). The train shepherd (below) replaces this.
4. **Gate.** One pre-merge gate for the whole tree: install, `check:arch`, typecheck, tests at
   the posture's tier (`verify_gate_strategy`). With `verify_placement=worker` it runs on a verify
   worker (`[verify-placement] train-gate placed on ao-pf38`); the host does no install.
   **The train holds the project's merge lock for the whole gate**, so no other merge lands
   meanwhile (`refused for lock contention ... held by merge-train:<label>`). A stale test-impact
   map widens an `impact`/scoped selection to the whole suite (`[test-impact] impact map is STALE
   ... widened to tier "all"`): a 3-minute gate becomes 45-70 minutes (#1568).
5. **Green:** the assembled tree lands on the base in one merge commit
   (`Merge train <label>: #A #B ...`), every member is closed as merged.
6. **Red:** handled by the red strategy (next section).

A **missing-deps** verdict (the gate output looks like a module failed to resolve) re-runs the
install and the whole gate once. Since 2026-10-17 this can fire falsely on a test's own coloured
log output (#1570), which costs a second full run.

## Red trains

Per project, `merge_train_red_strategy_<id>`:

| Value | What happens on red |
|---|---|
| `agent-fix-then-bisect` (default) | One fix agent in the train worktree; if still red, a control arm (gate the base alone) and a bisect over the members |
| `agent-fix` (**set on agentic-kanban**) | One fix agent; a second red is final. No bisect |
| `bisect` | No agent; control arm + bisect straight away |

The **fix agent** is a one-shot session started in the train worktree (it may run on a fleet
worker, #1431). Its brief (`buildAgentFixBrief`, saved as `kanban-train-fix-<label>.md` in the
temp dir) lists the members as `#N (branch)`, the failing suites and the last 60 lines of gate
output. It commits onto the train ref, the gate re-runs, and green lands the fixed tree. Caps:
`merge_train_agent_fix_max_turns` (default 1), `_timeout_ms` (20 min), `_cost_cap_usd` ($2, not
enforced: the one-shot runner reports no usage).

**When the fix agent fails, the members get the failure as feedback** (`merge-train-red-feedback.ts`):
members whose changed files include a failing suite get a builder turn; if no member owns a
failing file, **every** member gets one. On 2026-10-17 a worker disconnect killed the fix agent's
only turn, which counted as red, and all 14 builders were sent back for a one-line god-module
overflow.

**Bisect** gates halves of the member set to find the member that breaks it and sends that
member back. It costs a gate run per split and only attributes, it never fixes. The control arm
stops a red base from being blamed on a member.

## What each risk posture does to trains

| Posture | Train size / wait | Gate tier | Review | Red base | Implement-exit check |
|---|---|---|---|---|---|
| `strict` | 1 / 0 | `full` | thorough, per ticket | blocks all merges | full |
| `standard` (default) | 1 / 0 | `full` | per ticket | blocks all merges | impact |
| `iterate` | 1 / 0 | `impact` | per ticket | files a heal ticket | impact |
| `flow` | 1 / 0 | `impact` (no guard floor) | per ticket | reported only | impact |
| `fast` | 8 / 20 min | `scoped` | the train, not each ticket | allowed if known debt | typecheck |
| `sprint` | 12 / 30 min | `scoped-base-watch` | none | files a debt ticket | none |

The full per-level table (sweep cadence, merges per cycle, contention, placement) is in
`operator-reference.md` "Risk postures". **Explicit per-field prefs win over the posture without
a warning:** `train_max_size_<id>`, `train_max_wait_ms_<id>`, `verify_gate_strategy_<id>`. Clear
them after changing the posture (#1560).

## The train shepherd (target design, #1569; not shipped yet)

Replaces deferral, bisect and per-member fan-out with **one persistent agent per train**:

- The train worktree exists from the first member; each member is merged onto it as it joins.
- The first conflict starts the shepherd (a regular placed session, worker-capable). Every later
  conflict and every red gate of the same train goes to **the same session** as a follow-up
  turn, so it already knows the members and its prompt cache stays warm.
- Its first brief carries each member's title, description, branch and changed files; later
  turns add only the new member or the new failure.
- Members are frozen at the sha they joined with; a member that changes leaves and rejoins the
  next train. `git rerere` replays earlier resolutions when the tree is rebuilt.
- Each shepherd edit is its own commit naming the tickets it reconciles
  (`train-shepherd: resolve #A x #B ...`), listed on the train row: nobody reviewed these edits.
- An infrastructure failure (disconnect, failed launch) re-places the shepherd without using a
  turn; a shepherd with no progress for N minutes is an attention line and is re-placed (#1561).
- When it gives up, feedback goes only to members that own the failing files; with no owner the
  train is held with one attention line.

When #1569 lands, this section is rewritten as shipped behaviour.

## Landing a train by hand: `train land-local` (#1586)

When the board's train path keeps failing (the 2026-10-17 train 04 took four failed runs and ~15
manual steps), run from the **main checkout**:

```
pnpm cli -- train land-local <train-id>      # a train row (cancelled on the board if still live)
pnpm cli -- train land-local --from-window   # the open window's pending members, no row yet
pnpm cli -- train land-local <train-id> --continue   # re-run the gate after committing a fix
```

What it does, in order:

1. **Pauses** `auto_merge_disabled_<project>` and holds the train window for 12 h. Both are
   **restored in a `finally`** (a pref that was unset is deleted again), also when the gate is red
   or the run throws. A crash of the process itself skips the restore: reset the pref and
   `window/hold {minutes: 0}` by hand.
2. **Worktree** at `<repo parent>/.worktrees/<repo>/land-local/<label>` on branch
   `kanban/land-local/<label>`: cut from `kanban/train/<label>` when that ref exists, else the base
   with every member merged `--no-ff`. A member conflict stops the run and leaves the worktree.
3. **Gate** there: `pnpm install -r` (`--skip-install` to skip), then `check:arch`, `typecheck` and
   `test:mine` with `KANBAN_TEST_FILES` set to the train diff (guards still run). Progress is
   printed per step.
4. **Red** stops with the failing step and suite files and leaves the worktree. Fix, **commit in
   the worktree**, re-run with `--continue` (it skips assembly and install).
5. **Green** merges `--no-ff` into the base in the main checkout (must be on the base, clean, and
   the worktree must contain the current base) with the standard `Merge train <label>: #A #B`
   subject and `Merge-Train:` trailer, closes each member through `finalizeMergeCleanup` (the same
   bookkeeping as a board landing, so `hand-merged-branch-reconciler` has nothing to do), marks the
   train row `landed` with `landedLocally: true`, and removes the worktree and branch.

It does not reinstall in the main checkout: run `pnpm install -r` there if the train changed
dependencies.

## Where to look

| Question | Where |
|---|---|
| Which trains exist, their state and evidence | `pnpm cli -- train list`, `train show <id>`, or `GET /api/merge-queue/trains?projectId=<id>` (`gateEvidence` holds the failure text) |
| Is the window open, how full | `GET /api/merge-queue/window`, MERGE TRAIN section of `pnpm cli -- status --watch` |
| What the gate is doing now | `GET /api/workers/console?projectId=<id>` (`chains[]`: worker, stage, age) |
| Why it went red | `gateEvidence.gateFailure` on the train row; the full log `kanban-verify-train-<label>.log` in the board's temp dir (`D:\tmp` here), written when the gate ends. A failed worker run keeps no copy on the worker (#1571) |
| The story in order | stable board log `D:\projects\andrena\agentic-kanban-stable\.kanban\board.log`, grep `\[merge-train\]`, `\[auto-merge\]`, `\[verify-placement\]`, `\[verify-worker\]`, `\[test-impact\]` |
| Stop a train | `pnpm cli -- train cancel <id>` (the train becomes `abandoned`; the window re-forms with the members) |

## Ready workspaces that conflict with the base (#1584)

`startup/ready-base-conflict-healer.ts` (a registered background sweep, every 2 min) probes each idle
ready workspace with the read-only merge-tree check. On a conflict with the base it (1) rebases via the
board's update-base action, (2) resolves a `CONTINUE.md`-only conflict mechanically keeping both sides
(`services/base-conflict-keep-both.ts`), else (3) gives the builder ONE fix turn naming the files and
the base commits that touched them, taking the workspace out of the ready set until its exit re-arms
it. One turn per branch tip; after two turns the workspace gets a merge hold (needs attention).
Workspaces with a hold, a running session or merge job, or a live train in their project are skipped.
