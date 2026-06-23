import { PREF_MERGE_STRATEGY } from "../constants/preference-keys.js";
import { isAutoMergeEnabled } from "@agentic-kanban/shared/lib/auto-merge-pref";

export type MergeStrategy = "direct" | "monitor" | "merge_queue";

export function resolveMergeStrategy(prefMap: Map<string, string>): MergeStrategy {
  const configured = prefMap.get(PREF_MERGE_STRATEGY);
  if (configured === "direct" || configured === "monitor" || configured === "merge_queue") {
    return configured;
  }

  // Preserve legacy behavior: the in-process monitor owned merges when enabled;
  // otherwise the lightweight queue orchestrator owned reviewed workspaces.
  return prefMap.get("auto_monitor") === "true" ? "monitor" : "merge_queue";
}

export function isAutomaticMergeEnabled(prefMap: Map<string, string>): boolean {
  return isAutoMergeEnabled(prefMap) && resolveMergeStrategy(prefMap) !== "direct";
}
