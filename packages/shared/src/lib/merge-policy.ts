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

/** Why a project's effective auto-merge is what it is — the first rule that decides wins. */
export type AutoMergeSource =
  /** `auto_merge_disabled_<projectId>` is "true": this project opted out. */
  | "project_disabled"
  /** The global `auto_merge` is off. */
  | "global_off"
  /** On, but merge strategy `direct` reserves merging for a human. */
  | "direct_strategy"
  /** On, owned by automation, and this project has not opted out. */
  | "enabled"
  /**
   * #1207 — configured on, but the same-failure circuit breaker has paused it: N consecutive
   * gate runs failed with the identical normalised signature. NOT decided by this pure
   * resolver (the breaker lives in `runtime_state`, not in prefs) — it is overlaid by the
   * reader that knows the breaker, today `getAutopilotStatus`.
   */
  | "paused_same_failure";

export interface EffectiveAutoMerge {
  enabled: boolean;
  source: AutoMergeSource;
  owner: MergeStrategy | "off";
  /** Unchanged `auto_merge_in_review` semantics — reported, not folded into `enabled`. */
  autoMergeInReview: boolean;
}

/**
 * THE effective auto-merge answer for ONE project (#1102): the global `auto_merge` AND NOT
 * `auto_merge_disabled_<projectId>` — and not a `direct` strategy, which reserves merging for a
 * human. The toolbar Autopilot chip, `GET /api/projects/:id/autopilot`, the exit workflow and the
 * monitor all ask this, so "will this project auto-merge?" has one answer instead of a global
 * toggle in one place and a per-project kill-switch parsed by hand in two others.
 *
 * `source` names the most specific rule that decided: a project opt-out is reported even when
 * the global switch is also off, since that is the one the per-project toggle can change.
 */
export function resolveAutoMerge(prefMap: Map<string, string>, projectId: string): EffectiveAutoMerge {
  const policy = resolveMergePolicy(prefMap, projectId);
  const source: AutoMergeSource = !policy.allowedForProject
    ? "project_disabled"
    : policy.owner === "off"
      ? "global_off"
      : policy.owner === "direct"
        ? "direct_strategy"
        : "enabled";
  return { enabled: source === "enabled", source, owner: policy.owner, autoMergeInReview: policy.autoMergeInReview };
}

/**
 * Every project whose effective auto-merge is off by its OWN opt-out — the set the monitor and
 * the exit workflow pass down. Derived from {@link resolveAutoMerge}, not a second key parse.
 */
export function listAutoMergeDisabledProjectIds(prefMap: Map<string, string>): Set<string> {
  const ids = new Set<string>();
  for (const key of prefMap.keys()) {
    const projectId = autoMergeDisabledPref.projectIdOf(key);
    if (projectId !== null && resolveAutoMerge(prefMap, projectId).source === "project_disabled") ids.add(projectId);
  }
  return ids;
}

/** Some automation owns merging — i.e. not off, and not reserved for a human. */
export function isAutomaticMergeEnabled(prefMap: Map<string, string>): boolean {
  const { owner } = resolveMergePolicy(prefMap);
  return owner !== "off" && owner !== "direct";
}
