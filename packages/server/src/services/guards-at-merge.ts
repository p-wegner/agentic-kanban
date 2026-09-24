import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { resolveRiskPosture, type RiskPosture } from "./risk-posture.service.js";

/**
 * Which `@gate:always-run` guard suites a MERGE gate forces (#1232): the whole floor, or only the
 * suites whose declared `when:` territory the diff intersects.
 *
 * Where a merge's time went, measured 2026-09-24 under the `iterate` posture (tier `impact`) on a
 * 3-file client change: arch 43s, typecheck 19s, tests 118s — and of the 118s the impact
 * selection itself was ~2 files. The rest was the unconditional `@gate:always-run` floor
 * (`BASELINE_TOTAL_MS = 585_000` in `always-run-guard-runtime-ratchet.test.ts`): 26 shared +
 * 120 server + 12 client guard suites run for a change that touched none of their territory.
 *
 * Under `iterate` and `flow` (#1240) those guards are exactly the kind of check that can run
 * once per release-candidate sweep instead of once per merge: a guard that fails on the base is
 * a heal ticket (decision 019), not a lost branch. So the level derives the mode — `iterate` and
 * `flow` -> `intersecting`, every other level -> `all` — and `standard`/`strict`/`fast`/`sprint`
 * are byte-for-byte untouched: `all` emits no env var and changes no message.
 *
 * A gate-side READ of the posture rather than a field on the posture table, deliberately:
 * the table (`risk-posture.service.ts`) is being edited for the red-base veto in parallel
 * (#1233), and this is one derived fact with one consumer.
 */
export type GuardsAtMerge = "all" | "intersecting";

export const GUARDS_AT_MERGE_VALUES: readonly GuardsAtMerge[] = ["all", "intersecting"];

// #496: built from the registry, so an unregistered prefix is a COMPILE error.
const guardsAtMergePrefDef = projectPref("guards_at_merge");

/** `guards_at_merge_<projectId>` — the per-project override of the posture-derived mode. */
export function guardsAtMergePrefKey(projectId: string): string {
  return guardsAtMergePrefDef.key(projectId);
}

/** The mode a posture LEVEL derives. The one place the level -> mode rule is written. */
export function guardsAtMergeForPosture(posture: Pick<RiskPosture, "level">): GuardsAtMerge {
  return posture.level === "iterate" || posture.level === "flow" ? "intersecting" : "all";
}

export interface ResolvedGuardsAtMerge {
  guardsAtMerge: GuardsAtMerge;
  /** `pref` when `guards_at_merge_<id>` decided, `posture` when the level did. */
  source: "pref" | "posture";
  posture: RiskPosture;
}

/**
 * The effective mode for a project — a pure prefMap resolver in the `resolveStartPolicy` shape.
 *
 * The explicit pref WINS when set and parseable (either direction: an operator may pin `all` on
 * an `iterate` project that wants every merge to pay the floor, or `intersecting` on a `standard`
 * one). An unparseable value is ignored with a warning and the posture decides — the fail-open
 * direction, since `all` is the mode that runs MORE and a typo must not silently narrow a gate.
 */
export function resolveGuardsAtMerge(prefMap: Map<string, string>, projectId: string): ResolvedGuardsAtMerge {
  const posture = resolveRiskPosture(prefMap, projectId);
  const raw = prefMap.get(guardsAtMergePrefKey(projectId))?.trim().toLowerCase();
  if (raw !== undefined && raw !== "") {
    if ((GUARDS_AT_MERGE_VALUES as readonly string[]).includes(raw)) {
      return { guardsAtMerge: raw as GuardsAtMerge, source: "pref", posture };
    }
    console.warn(
      `[guards-at-merge] ignoring unrecognized guards_at_merge override '${raw}' for project ${projectId} — ` +
        `the values are 'all' and 'intersecting'; posture '${posture.level}' decides (#1232)`,
    );
  }
  return { guardsAtMerge: guardsAtMergeForPosture(posture), source: "posture", posture };
}

/**
 * What the verify runner is told (`KANBAN_TEST_GUARDS`, read by `scripts/test-mine.mjs`).
 * Empty for `all` so a non-`iterate`/`flow` project's env is byte-identical to before #1232; the runner's
 * default is `all` anyway, and a variable that is always present trains the reader to skip it.
 */
export function guardsAtMergeEnv(mode: GuardsAtMerge | undefined): Record<string, string> {
  return mode === "intersecting" ? { KANBAN_TEST_GUARDS: "intersecting" } : {};
}
