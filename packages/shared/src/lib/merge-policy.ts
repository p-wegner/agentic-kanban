/**
 * Merge policy: who, if anyone, may merge a reviewed workspace (#546).
 *
 * Lives beside `auto-merge-pref` (its other input) rather than in `startup/`, because the
 * answer is needed by a SERVICE too — `project-runtime-config` had its own fourth version
 * of the predicate, and importing the startup module from a service would invert the
 * layering. `startup/merge-strategy.ts` re-exports this, so the existing importers and the
 * suites that mock that path are unaffected.
 *
 * Pure (prefMap in, decision out) — no I/O, no Node builtins.
 */
import { isAutoMergeEnabled } from "./auto-merge-pref.js";
import { getBool } from "./settings-registry.js";
import { projectPref } from "./dynamic-preference-keys.js";

export const MERGE_STRATEGY_PREF_KEY = "merge_strategy";

const autoMergeDisabledPref = projectPref("auto_merge_disabled");

export type MergeStrategy = "direct" | "monitor" | "merge_queue";

export function resolveMergeStrategy(prefMap: Map<string, string>): MergeStrategy {
  const configured = prefMap.get(MERGE_STRATEGY_PREF_KEY);
  if (configured === "direct" || configured === "monitor" || configured === "merge_queue") {
    return configured;
  }

  // Preserve legacy behavior: the in-process monitor owned merges when enabled;
  // otherwise the lightweight queue orchestrator owned reviewed workspaces.
  return getBool(prefMap, "auto_monitor") ? "monitor" : "merge_queue";
}

/**
 * Who owns merging, and is this project opted out?
 *
 * The answer combines four preferences and used to be recomputed with THREE different
 * owner predicates: `strategy !== "direct"` (exit-workflow), `&& strategy === "monitor"`
 * (the monitor setup), `&& strategy === "merge_queue"` (the queue orchestrator), plus a
 * fourth that read `auto_merge` ALONE and so disagreed with all of them. The per-project
 * kill-switch was then inlined at eight more call sites.
 *
 * `owner` is the single answer: `"off"` when `auto_merge` is off at all, otherwise the
 * configured strategy — `"direct"` meaning a human merges, so no automation owns it.
 * `allowedForProject` is the per-project `auto_merge_disabled_<id>` kill-switch, and is
 * `true` when no project is named (a global question).
 */
export interface MergePolicy {
  owner: MergeStrategy | "off";
  allowedForProject: boolean;
  autoMergeInReview: boolean;
}

export function resolveMergePolicy(prefMap: Map<string, string>, projectId?: string | null): MergePolicy {
  const owner = isAutoMergeEnabled(prefMap) ? resolveMergeStrategy(prefMap) : "off";
  return {
    owner,
    allowedForProject: projectId ? prefMap.get(autoMergeDisabledPref.key(projectId)) !== "true" : true,
    autoMergeInReview: getBool(prefMap, "auto_merge_in_review"),
  };
}

/** Some automation owns merging — i.e. not off, and not reserved for a human. */
export function isAutomaticMergeEnabled(prefMap: Map<string, string>): boolean {
  const { owner } = resolveMergePolicy(prefMap);
  return owner !== "off" && owner !== "direct";
}
