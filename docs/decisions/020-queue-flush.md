# 020 — The queue flush: when merges stall, land everything and heal afterwards

**Status:** accepted 2026-09-24, not yet implemented (#1246–#1249). Builds on 017 (risk posture)
and 019 (release-candidate promotion).

## The problem this answers

The merge queue exists to prove each change before it lands. When builders produce branches faster
than the gate can verify them, that proof becomes the bottleneck: the queue depth grows, the oldest
branch ages, every rebase invalidates a gate run, and the board looks busy while nothing lands.
Steve Yegge's answer in *The Shape of Things to Come* is to stop proving per change once the queue
cannot keep up: land everything at once, run the suite once on the result, and send agents after
whatever broke. The suite cost becomes per flush instead of per change, and the fixing is ordinary
ticket work. The reason for the action is throughput; anything that blocks merges afterwards
defeats it.

## The decision

1. **A flush is a train mode, not a new rung.** The merge train already assembles several branches
   into one gate run, orders them by the conflict graph, sides a member that cannot merge, and
   lands one merge commit. A flush is that train with **no size cap**, a gate reduced to
   **`check:arch` + `typecheck`**, **no bisect arm**, and the full suite deferred to the heal
   target. Typecheck stays mandatory because a non-compiling master breaks every builder's
   worktree, not just the release.
2. **It is an escape valve on the low rungs only.** `fast`, `sprint`, `iterate` and `flow` may
   flush; `strict` and `standard` refuse, because those rungs promise a green master and a flush
   makes master red on purpose.
3. **A flush is loud.** Landing commit tagged `flush/<date>-N`; ledger row `source: flush` so the
   miss-rate join counts flush reds apart from impact-selection misses; a comment on every member
   ticket; a `flush` badge on the delivery chip and a line in the tracker; the Sentinel names it.
   The operator can answer three questions at a glance: **did a flush happen**, **is its red
   healed**, and **is the healed state back on master**.
4. **Healing must not block merges, and does not need an rc.** The rc branch of decision 019 is
   what *promotion* needs: a green snapshot. A flush only needs its red healed somewhere that does
   not hold the queue, and visibly back on master. Two shapes satisfy that, chosen per project by
   `heal_target_<id>`:
   - **`rc`** — cut `rc/<date>` from the landing sha, sweep it, heal on it, promote, merge back
     (#1238/#1239 as is). Default when a promotion cadence is set.
   - **`master`** — sweep master itself, file heal tickets per failure signature as ordinary
     master-based workspaces (#1233's machinery), and the "merge-back" is a no-op: `healed` and
     `merged-back` collapse into one transition when the heal ticket lands. Default otherwise.
     Cheaper: one branch, no retargeting.
   Under both, the base-red veto returns no hold (`report` / `allow-*` policies), trains keep
   landing while heal tickets are open, and the flush record moves through
   `flushed → sweeping → red → healing → healed → merged-back` (or `abandoned`).
5. **The trigger is measured, then manual, then automatic.** A pressure signal (queue depth, age of
   the oldest waiting branch, arrivals per hour against gate runs per hour) is shown first;
   `queue_flush_<id>` is `off` by default, `manual` adds a Flush action to the delivery view and
   `pnpm cli -- queue flush`, `auto` fires the same path from the tick when the thresholds hold.
   Rails: a daily cap, no flush while a promotion sweep is in flight, a new flush supersedes a still
   red one and retargets its heal tickets.

## Why not just widen the train

A wider train still bisects on red and still runs the suite per train, so its cost grows with the
queue and its blame is per member. The flush drops both on purpose and gets its blame from the heal
ticket's range list instead (the merges since the last green, #1234), which is the same information
one train later and at zero gate cost.

## What we do not know yet

How often this queue actually stalls. The measured failure so far (#1228) was one deterministic red
re-gating 31 times, which #1230 fixed with backoff, not a queue that could not keep up. The pressure
signal (#1246) exists to answer that before `auto` is ever switched on.

## Tickets

| Part | Ticket |
|---|---|
| Pressure signal, flush record and its state machine, chip / tracker / Sentinel / ticket comments, `GET /api/projects/:id/flushes` | #1246 (lands first) |
| Flush train mode: no cap, arch + typecheck gate, no bisect, siding, tag, ledger source, refusal on strict/standard, no veto hold | #1247 |
| Trigger: `queue_flush_<id>`, thresholds, Flush action + CLI, `auto` from the tick, rails | #1248 |
| Heal target: `heal_target_<id>` = `rc` \| `master`, the master shape end to end, merges keep flowing under both | #1249 |

Related: 017 (posture rungs), 019 (rc promotion, heal on the candidate), `docs/integration-risk-ladder.md`
§ "Queue pressure: the flush".
