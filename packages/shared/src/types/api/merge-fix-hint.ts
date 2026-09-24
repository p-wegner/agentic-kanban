/**
 * The fix hint a failed pre-merge gate can carry (#1250): a stale shrink-only ratchet baseline
 * is a one-line edit, and the gate names it instead of leaving it in the verify log. Produced by
 * `server/src/services/merge-failure-fix-hint.ts`, read by `GET /api/workspaces/:id/merge-status`
 * and the client's merge error panel. One declaration, so the two sides cannot drift (#569).
 */
export interface MergeFixHintEdit {
  /** Repo-relative path of the baseline file to edit. */
  baselineFile: string;
  /** The entry key (`<file>::<fn>` for the nloc rings, the `const` name for the runtime ratchet). */
  key: string;
  /** The value the baseline holds now; null when the failure text did not state it. */
  from: number | null;
  /** The value the ratchet asked for. */
  to: number;
}

export interface MergeFixHint {
  kind: "bank-shrinks";
  edits: MergeFixHintEdit[];
  /** One operator line, e.g. `stale baseline: lower a.tsx::A 416 -> 371 in packages/client/…`. */
  summary: string;
}
