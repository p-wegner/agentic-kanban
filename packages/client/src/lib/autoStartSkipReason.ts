/**
 * #919 — rendering the per-issue auto-start skip reason.
 *
 * The board records WHY the monitor last declined to start a ticket (`AutoStartSkipReason`,
 * `startup/monitor-auto-start.ts`). The token alone is not an answer for a human — `wip_cap`
 * does not say what to do about it — so each one carries a plain-language label plus the
 * remedy, which is the whole point of surfacing it: "why is #57 not running" is asked in
 * order to decide whether to act.
 *
 * A token this map does not know is rendered verbatim rather than dropped: the server's
 * vocabulary can grow ahead of a client build, and showing an unfamiliar reason is strictly
 * better than showing none.
 */

export interface AutoStartSkipDisplay {
  /** Short label for the badge. */
  label: string;
  /** What it means and what to do, for the tooltip. */
  detail: string;
  /** `hold` = the board is waiting on capacity; `decline` = it will not start this ticket. */
  kind: "hold" | "decline";
}

const REASONS: Record<string, AutoStartSkipDisplay> = {
  wip_cap: {
    label: "WIP cap",
    detail: "The project is already running its full WIP target. Raise the WIP limit (Strategy Bullseye → Agents, or the project's wip_limit) or wait for a ticket to land.",
    kind: "hold",
  },
  machine_saturated: {
    label: "Machine saturated",
    detail: "The board host has no RAM/CPU headroom for another agent and no eligible fleet worker could take the overflow. Free capacity, or pair a worker for this project.",
    kind: "hold",
  },
  contention_gate: {
    label: "File contention",
    detail: "This ticket is predicted to touch a file another in-flight ticket is already editing, so it is held one cycle to avoid a conflicting worktree.",
    kind: "hold",
  },
  cycle_start_cap: {
    label: "Cycle start cap",
    detail: "The project had already launched its maximum new workspaces for this cycle. It starts on a later cycle; raise maxNewStartsPerCycle to widen the batch.",
    kind: "hold",
  },
  verify_gate_running: {
    label: "Gate running",
    detail: "A verify/build/smoke gate holds the build semaphore right now, so new builder starts are deferred for this cycle so the gate's result stays trustworthy.",
    kind: "hold",
  },
  no_available_worker: {
    label: "No worker",
    detail: "The project dispatches builders to fleet workers in STRICT mode and no connected worker has free capacity. The ticket stays queued rather than running on the board host.",
    kind: "hold",
  },
  create_in_flight: {
    label: "Start in flight",
    detail: "Another automatic starter is already provisioning a workspace for this ticket. Not a failure — that launch is the one that counts.",
    kind: "hold",
  },
  no_auto_start_tag: {
    label: "no-auto-start",
    detail: "This ticket carries the `no-auto-start` tag, so the monitor will never launch it. Remove the tag, or start it by hand.",
    kind: "decline",
  },
  feature_type_excluded: {
    label: "Type excluded",
    detail: "The monitor does not auto-start this issue type on this project. Enable hands-off mode for the project, or change the issue type.",
    kind: "decline",
  },
  already_merged: {
    label: "Already merged",
    detail: "This ticket's work already landed on the base branch; the monitor reconciled its status instead of starting a duplicate workspace.",
    kind: "decline",
  },
  loop_unit_reopen_declined: {
    label: "Loop unit merged",
    detail: "This is a plugin-loop unit whose workspace already merged. A loop that wants another pass mints a fresh unit; reopening this one cannot be represented in the loop.",
    kind: "decline",
  },
};

/**
 * The display for a persisted skip reason, or `null` when there is none. An unknown token is
 * rendered verbatim as a `decline` — see the module header.
 */
export function describeAutoStartSkipReason(reason: string | null | undefined): AutoStartSkipDisplay | null {
  if (!reason) return null;
  return REASONS[reason] ?? { label: reason, detail: `The monitor declined to start this ticket: ${reason}.`, kind: "decline" };
}
