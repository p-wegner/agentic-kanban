// The merge-policy resolver moved to `shared/lib/merge-policy` (#546) so a SERVICE can read
// it without importing `startup/`. This facade keeps the import path every consumer — and
// every suite that mocks it — already uses.
export {
  resolveMergeStrategy,
  resolveMergePolicy,
  isAutomaticMergeEnabled,
  MERGE_STRATEGY_PREF_KEY,
} from "@agentic-kanban/shared/lib/merge-policy";
export type { MergeStrategy, MergePolicy } from "@agentic-kanban/shared/lib/merge-policy";
