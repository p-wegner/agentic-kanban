/**
 * Canonical accessor for the global `auto_review` preference.
 *
 * Ticket #946: the same key was read with OPPOSITE defaults across the codebase —
 * default-ON via `!== "false"` (exit-workflow, stranded-review reconciler, all client
 * reads) and default-OFF via `=== "true"` (project-runtime-config → drive status /
 * preflight). With the key UNSET the drive dashboard/preflight reported review OFF
 * while the exit workflow actually ran reviews — behaviour and the surfaced status
 * disagreed. Same class of bug as `auto_merge` (#866, see auto-merge-pref.ts).
 *
 * The canonical default is ON. It matches the settings registry
 * (`auto_review: { default: "true" }` in settings-registry.ts) and the actual runtime
 * behaviour (exit-workflow). Every consumer MUST read the key through this accessor
 * so the unset-key behaviour is identical across server + client.
 *
 * Pure (no I/O, no Node builtins) → safe to consume from the client bundle too, though
 * it is exported via a deep subpath rather than the lib barrel to keep the barrel lean.
 */
export const AUTO_REVIEW_PREF_KEY = "auto_review";

/** The canonical default when the `auto_review` pref is unset: enabled. */
export const AUTO_REVIEW_DEFAULT_ENABLED = true;

/**
 * Resolve the global `auto_review` toggle from a raw preference value.
 *
 * Unset/null (or any value other than the explicit string "false") ⇒ enabled, because
 * the canonical default is ON. Only the literal "false" disables it. Use this
 * everywhere instead of hand-rolling `=== "true"` / `!== "false"`.
 */
export function isAutoReviewEnabled(value: string | null | undefined): boolean {
  if (value === undefined || value === null) return AUTO_REVIEW_DEFAULT_ENABLED;
  return value !== "false";
}
