/**
 * How a placement decision RECORDS itself (#801) — extracted from
 * `worker-fleet.service.ts` in #1027, which pushed that file past the god-module cohesion
 * ceiling (#889). Three one-line constructors with a shared rationale is exactly the kind
 * of thing that belongs beside the resolver rather than inside it.
 *
 * `explainPlacement` re-derives the chain against LIVE state, which answers "why is this
 * not dispatching now" and cannot answer "why did that session run on the host last
 * Tuesday": the prefs, the fleet and the repo shape have all moved. So the deciding step
 * is stamped onto the decision where it is MADE, and the caller persists it on the session
 * row. The ids are the same `PlacementCheckId`s the explanation uses, deliberately — a
 * historical record and a live explanation that disagreed on vocabulary would be two
 * answers to one question.
 */
import type { Placement } from "./agent-dispatch.service.js";
import type { PlacementReason, PlacementReasonId } from "../lib/placement-explain.types.js";

export function because(id: PlacementReasonId, detail: string): PlacementReason {
  return { id, detail };
}

export function hostBecause(id: PlacementReasonId, detail: string): Placement {
  return { kind: "host", reason: because(id, detail) };
}

/**
 * The host WON the ranked comparison (#938) — a different thing from every `hostBecause`
 * exit, and it has its own helper for exactly that reason.
 *
 * `placement-chain-parity.test.ts` counts `return hostBecause("<id>"` occurrences in the
 * resolver and demands one declared chain check per id, because a `hostBecause` exit IS a
 * guard that refused remote dispatch for a reason an operator can go and change. This exit
 * is not a guard: nothing refused anything, the host simply had more headroom, and it flips
 * back to remote the moment the numbers move. Routing it through `hostBecause` would force
 * a fictional entry into `docs/worker-fleet.md` §7's "nothing dispatches" checklist telling
 * an operator to go fix a setting that does not exist.
 */
export function hostWinsRanking(detail: string): Placement {
  return { kind: "host", reason: because("host_has_headroom", detail) };
}
