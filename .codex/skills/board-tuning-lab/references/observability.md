# Dimension: observability / monitoring UI

Tune what the board **shows a human** who is watching many workspaces across many
repos: is a stall, a stranded sibling, a leaked stack, or a stuck review visible
at a glance, or only by hand-querying the API? The gap class here is *the board
knows but doesn't surface it.* Prior UI-design work: sessions `1ca809da`
(multi-repo monitoring UI features) and `9c8a75f0` (design UI for multiproject
monitoring) — mine those for the feature backlog before inventing new ones.

## Instrument

**`playwright-cli`** — the ground truth is what the Monitor view actually renders,
not what the API returns (rule 2). For each friction item: reproduce the
underlying condition on a fixture, open the monitor/board view, screenshot at full
render, and judge whether a human would *notice* the problem without opening
devtools. Baseline = screenshot before the fix; proof = screenshot after. Pair
with `snapshot.py` to know the true state the UI *should* be showing.

## Fixture

Reuse the multi-repo fixture (`references/multirepo.md`) — observability only
matters when there's enough going on to lose track. Then **manufacture the
conditions worth surfacing**, one per probe:

- A **stalled** workspace (launch, then let it sit / kill its agent — a transcript
  ~1s with zero tokens is the stale signature).
- A **stranded sibling** (sibling-only ticket driven to "Done" with work unmerged).
- A **leaked stack** (kill a run mid-drive so containers orphan).
- A **stuck review** (mark-ready, never merge).
- A **healthy** control that must NOT raise any alarm (negative control).

## Seed the mix

Tickets aren't the instrument here — *states* are. Drive a handful of normal
tickets to populate the board, then induce the abnormal states above by hand.
The question is always "does the UI distinguish healthy from each failure mode?"

## Friction checklist

- **Multi-workspace health at a glance** — can you see, without clicking in, which
  workspaces are progressing vs stalled vs waiting-on-review vs failed?
- **Per-repo status in the row** — for a multi-repo workspace, does the row show
  per-repo merge/stranded state (the `repo-merge-status` data) or only a scalar?
- **Stall detection surfaced** — the server can detect a stale/launch-failed
  session; does the UI flag it, or does it look identical to a busy one?
- **Stack/lifecycle visibility** — are a workspace's running containers / ports
  shown? Are orphaned `ak-*` stacks after a killed run visible anywhere?
- **Monitor decisions legible** — when the in-process monitor relaunches/merges/
  nudges, is that action shown with a reason, or silent?
- **Negative control** — the healthy workspace shows calm/green, no false alarm.

## Fix locus

Client monitor/board views (`packages/client/src/**` monitor components) fed by
existing server signals — prefer surfacing data the API *already* computes
(`repo-merge-status`, session status, stack state) over adding new backend
computation. If a signal genuinely isn't computed, that's a separate `feature`
ticket. Verify each fix with a before/after `playwright-cli` screenshot.

## Memory

Cross-link [[multirepo-leading-repo-blindspot]] (#76 board conflict badge, #78
HANDOFF.md were early observability fixes) and any UI-design decision records.
