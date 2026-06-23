/**
 * Canonical accessor for the global `auto_merge` preference.
 *
 * Ticket #866: the same key was read with OPPOSITE defaults across the codebase —
 * default-ON via `!== "false"` (merge orchestrator, merge-strategy) and default-OFF
 * via `=== "true"` (monitor setup, drive status/preflight, board-status, stall warning,
 * the MCP get_board_status projection). With the key UNSET the merge engine considered
 * auto-merge ENABLED while the monitor / board-status UI considered it DISABLED —
 * behaviour and the surfaced status disagreed.
 *
 * The canonical default is ON. It matches the client `DEFAULT_SETTINGS`
 * (`auto_merge: "true"` in settings-shared.ts / SettingsPanel.shared.tsx), the only
 * place a default was previously declared. Every consumer MUST read the key through
 * this accessor so the unset-key behaviour is identical across server + MCP.
 *
 * Pure (no I/O, no Node builtins) → safe to consume from the client bundle too, though
 * it is exported via a deep subpath rather than the lib barrel to keep the barrel lean.
 */
export const AUTO_MERGE_PREF_KEY = "auto_merge";

/** The canonical default when the `auto_merge` pref is unset: enabled. */
export const AUTO_MERGE_DEFAULT_ENABLED = true;

/**
 * Resolve the global `auto_merge` toggle from a preference map (key → value).
 *
 * Unset (or any value other than the explicit string "false") ⇒ enabled, because
 * the canonical default is ON. Only the literal "false" disables it. Use this
 * everywhere instead of hand-rolling `=== "true"` / `!== "false"`.
 */
export function isAutoMergeEnabled(prefMap: Map<string, string>): boolean {
  const raw = prefMap.get(AUTO_MERGE_PREF_KEY);
  if (raw === undefined) return AUTO_MERGE_DEFAULT_ENABLED;
  return raw !== "false";
}
