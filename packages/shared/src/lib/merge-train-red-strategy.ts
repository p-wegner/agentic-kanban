// What a merge train does when its assembled tree goes red (#1277). Pure and client-safe: the
// server resolves it at run time, the Settings page renders and writes the same keys.
//
//   agent-fix            one directed fix agent in the train worktree; a second red is final
//   agent-fix-then-bisect  (default) the fix agent first, then today's control arm + bisect
//   bisect               today's behaviour, no agent
//
// Every key is per-project and goes through the preference layer (auditable, never an env var).

import { projectPref } from "./dynamic-preference-keys.js";

export const MERGE_TRAIN_RED_STRATEGIES = ["agent-fix", "bisect", "agent-fix-then-bisect"] as const;
export type MergeTrainRedStrategy = (typeof MERGE_TRAIN_RED_STRATEGIES)[number];

export const MERGE_TRAIN_RED_STRATEGY_DEFAULT: MergeTrainRedStrategy = "agent-fix-then-bisect";

export const MERGE_TRAIN_AGENT_FIX_DEFAULT_MAX_TURNS = 1;
export const MERGE_TRAIN_AGENT_FIX_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
export const MERGE_TRAIN_AGENT_FIX_DEFAULT_COST_CAP_USD = 2;

export const mergeTrainRedStrategyPref = projectPref("merge_train_red_strategy");
export const mergeTrainAgentFixMaxTurnsPref = projectPref("merge_train_agent_fix_max_turns");
export const mergeTrainAgentFixTimeoutMsPref = projectPref("merge_train_agent_fix_timeout_ms");
export const mergeTrainAgentFixCostCapUsdPref = projectPref("merge_train_agent_fix_cost_cap_usd");

/** The caps that stop a fix agent burning forever; tripping any one falls back to bisect. */
export interface MergeTrainAgentFixCaps {
  maxTurns: number;
  timeoutMs: number;
  costCapUsd: number;
}

export interface MergeTrainRedPolicy {
  strategy: MergeTrainRedStrategy;
  /** Does a red train get a fix agent before anything else? */
  agentFix: boolean;
  /** May a failed (or capped) fix agent fall through to the control arm + bisect? */
  bisectAfter: boolean;
  caps: MergeTrainAgentFixCaps;
}

/** Case-sensitive on purpose: an unknown value falls back to the default rather than being coerced. */
export function parseMergeTrainRedStrategy(raw: string | null | undefined): MergeTrainRedStrategy {
  const value = raw?.trim();
  return (MERGE_TRAIN_RED_STRATEGIES as readonly string[]).includes(value ?? "")
    ? (value as MergeTrainRedStrategy)
    : MERGE_TRAIN_RED_STRATEGY_DEFAULT;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** prefMap -> the red-handling policy for one project. Pure and synchronous. */
export function resolveMergeTrainRedPolicy(prefMap: Map<string, string>, projectId: string): MergeTrainRedPolicy {
  const strategy = parseMergeTrainRedStrategy(prefMap.get(mergeTrainRedStrategyPref.key(projectId)));
  return {
    strategy,
    agentFix: strategy !== "bisect",
    bisectAfter: strategy !== "agent-fix",
    caps: {
      maxTurns: Math.floor(positiveNumber(prefMap.get(mergeTrainAgentFixMaxTurnsPref.key(projectId)), MERGE_TRAIN_AGENT_FIX_DEFAULT_MAX_TURNS)),
      timeoutMs: Math.floor(positiveNumber(prefMap.get(mergeTrainAgentFixTimeoutMsPref.key(projectId)), MERGE_TRAIN_AGENT_FIX_DEFAULT_TIMEOUT_MS)),
      costCapUsd: positiveNumber(prefMap.get(mergeTrainAgentFixCostCapUsdPref.key(projectId)), MERGE_TRAIN_AGENT_FIX_DEFAULT_COST_CAP_USD),
    },
  };
}
