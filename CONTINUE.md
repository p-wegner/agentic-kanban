# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## Where this stands (2026-08-27)

**Read this section before anything below it.** Everything under it is a dated pass and
describes the state *at the time it was written*. A continuation scraper previously pulled a
"Next steps" list out of the 2026-08-23/24 pass and handed it to a fresh session as current —
three of its five items were already closed. Standing state lives here and nowhere else.

### Verified now (2026-08-27)

- **Branch `master`, working tree clean, 36 commits ahead of `origin/master`, 0 behind** —
  a clean fast-forward (`git merge-base --is-ancestor origin/master master` passes).
  `origin` = GitHub `p-wegner/agentic-kanban`; there is a second remote `gitlab`
  (`code.andrena.de/pizza-und-ai-code/agentic-code-review.git`) — do not confuse them.
- **#807, #831 and #834 are all Done** (checked via `pnpm cli -- issue get <N>`, closed
  2026-08-26). Any older text below that treats them as open or as blockers is stale.
- **Board: 17 open** — In Progress #905, #906, #907 (merge train); In Review #922;
  Todo #923, #924; Backlog #909–#919.

### Next steps, in order

1. **Operator: decide the push.** 36 commits, clean FF. Its *old* rationale is gone — #834 and
   #807 both closed without it. What it buys now is a Linux CI run, which is what **#923**
   (board-events + conductor-lifecycle failing on the runner) needs to move.
2. **`pnpm --filter agentic-kanban test` on an idle box** — still the outstanding whole-repo
   gate. See "Deferred on machine load" below; this has been deferred across several sessions
   and is genuinely unverified, not merely unrecorded.
3. **#922** (In Review) — disclose-context PostToolUse hook into the worktree scaffold.
4. **#924** — investigated 2026-08-28: already fully solved by #893 (`4ce27bb3dd`,
   `workspace_merge_gate` persisted verdict + `describePersistedGateVerdict` on
   `GET /merge-status`), inherited on this branch from master. No code change made;
   closing as a duplicate rather than re-implementing. See the dated section below.
5. **#905–#907** (In Progress) — the merge-train batching/persistence/one-review-per-train trio.

### Deferred on machine load, with the reason

`fleet gate --count 4` returns **BLOCKED: room for 0** (2026-08-27 ~21:21): RAM 100%, only
0.06 GB truly free of 28 GB, actively swapping at ~2,148 hard faults/sec; CPU fine at 18%.
The full suite is not deferred out of preference — starting it here takes the box down along
with every other session on it. Run it when `fleet gate` clears, capped (`--maxWorkers=4`).

### Operator flag — RESOLVED, not open (corrected 2026-08-27)

Earlier passes recorded `packages/server/kanban.db` as a **schema-only stub** causing a
split-brain with the home-fallback DB. **That file does not exist any more** (checked
2026-08-27), so there is no second database to address by mistake: the CLI and the server both
open `C:\Users\pwegner\.agentic-kanban\kanban.db`, which is the real board (192 MB, live).
The `[db] opening ... (source: home-fallback)` line the CLI prints on every invocation is the
NORMAL path now, not a warning about a stub — do not re-file this as a defect.

## Archive

Passes older than 2026-09-01 have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so it records what each session believed at the time. Look there for the
2026-08-25..28 waves (#924, #807, #903, #901, #857, #874, #887, #899/#898/#897, #894, #881, the
26-ticket direct-master batch, #859's root cause, the UI overflow sweep), and before them the #680
gate-hermeticity history, the "batch 1 of N" true-state table (#691), the 2026-08-21/22/23 waves,
the adversarial review, and the hook-cost investigations.
