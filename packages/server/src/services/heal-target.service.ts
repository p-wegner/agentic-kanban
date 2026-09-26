/**
 * Heal target after a flush (#1249, decision 020 part 4): where does a flush's red get healed —
 * the release candidate, or master directly? Both shapes must keep merging while the heal is
 * open; the only question this module answers is WHICH shape a project uses, in ONE function the
 * flush, the sweep hook and the observability record all call, so the three can never disagree.
 *
 *  - `rc`: the flush cuts `rc/<date>` and sweeps it (#1238); heal tickets are rc-based (#1239);
 *    green promotes and merges back. Right for a project on the rc cadence.
 *  - `master`: the flush sweeps master itself; heal tickets are ordinary master-based workspaces
 *    tagged `heal`; the merge-back is a no-op — `flush-state.ts`'s `applyFlushTransition` already
 *    collapses `healed -> merged-back` in one step for a `sweepTarget: "master"` record. Right
 *    for a project with no promotion at all, or one that promotes rarely: one branch, no retarget
 *    dance.
 *
 * The default derives from whether the project has a promotion cadence configured
 * (`promote_cadence_<id>`, #1238): a project already on the rc cadence gets the rc shape for
 * free; a project that has never touched that knob gets the cheaper master shape. Either is
 * overridable via `heal_target_<projectId>`.
 */
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { FlushState } from "@agentic-kanban/shared/types";
import { parsePromoteCadence } from "./promote-cadence.service.js";

export type HealTarget = "rc" | "master";

const healTargetPrefDef = projectPref("heal_target");

export function healTargetPrefKey(projectId: string): string {
  return healTargetPrefDef.key(projectId);
}

function isHealTarget(v: string | null | undefined): v is HealTarget {
  return v === "rc" || v === "master";
}

/**
 * The ONE resolver every consumer of "where does this project heal" calls — the flush trigger
 * (which shape to cut), the sweep hook (which branch to sweep) and the observability record
 * (what `sweepTarget` a new `FlushRecord` gets) must never derive this independently, or a
 * project could get an rc-shaped flush record swept as if it were master-shaped.
 *
 * Pure prefMap resolver: `heal_target_<projectId>` wins when set to a recognised value; an
 * unparseable override is IGNORED (falls through to the derived default) rather than failing
 * closed to `master` — `master` is not universally the safer default (a project actually on the
 * rc cadence wants rc), so "ignore and derive" is the correct fail-open here, unlike a boolean
 * gate where failing closed is safe.
 */
export function resolveHealTarget(prefMap: Map<string, string>, projectId: string): HealTarget {
  const explicit = prefMap.get(healTargetPrefKey(projectId));
  if (isHealTarget(explicit)) return explicit;

  const cadenceRaw = prefMap.get(`promote_cadence_${projectId}`);
  const cadence = parsePromoteCadence(cadenceRaw);
  return cadence.kind === "daily" ? "rc" : "master";
}

/**
 * A heal ticket's dedupe key, per decision 020 part 4 item 2: keyed to the FLUSH TAG, never the
 * rc — the master shape has no rc to key against, and keying both shapes the same way is what
 * lets the observability record and the heal-ticket-per-signature machinery (#1233) share one
 * lookup regardless of which target a project uses.
 */
export function healTicketKey(flushTag: string, failureSignature: string): string {
  return `${flushTag}::${failureSignature}`;
}

/**
 * Does an open heal ticket ever hold or pause merges? Both shapes must keep merging while a heal
 * is open (decision 020 part 4 item 4) — this always answers false. Kept as a named function
 * (rather than inlining `false` at each call site) so a caller's intent is legible and a future
 * change has one place to make it, the same shape `resolveBaseRedVeto`'s posture check documents
 * its own non-holding cases.
 */
export function healOpenBlocksMerging(_target: HealTarget, _flushState: FlushState): false {
  return false;
}
