// The dynamic (per-project / per-name) preference-key table and matcher moved to
// @agentic-kanban/shared/lib/dynamic-preference-keys (#989) so the MCP server's
// `set_preference` tool can enforce the same key allow-list as the settings route.
// This module re-exports it so existing server imports keep working — add new
// per-project prefixes in the SHARED module, not here.
export {
  PROJECT_SCOPED_KEY_PREFIXES,
  FREEFORM_SUFFIX_KEY_PREFIXES,
  isProjectScopedDynamicKey,
  isBoardStrategyPreferenceKey,
  START_MODE_VALUES,
} from "@agentic-kanban/shared/lib/dynamic-preference-keys";
