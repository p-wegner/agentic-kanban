/**
 * The issue domain's closed vocabularies, as runtime arrays (#570).
 *
 * `types/api/issue.ts` declares `IssueType`/`IssueEstimate`/artifact `type` as TYPE-ONLY
 * unions, and the types barrel is `export type *` — so no runtime array can live there, and
 * every layer that needs one at RUNTIME (a zod enum, a validation `Set`, a `<option>` list)
 * re-listed the literals by hand. They disagreed, and the disagreements were invisible:
 *
 * - Four client `<select>`s listed THREE types, omitting `chore` — so an issue created as a
 *   chore through MCP rendered an empty select, with no error anywhere.
 * - `routes/issue-export-import.ts` accepted FIVE, including `epic`, which is not in the
 *   shared type at all.
 * - `mcp-server/tools/create-issues-batch.ts` validated nothing (`z.string()`).
 *
 * Precedent: `DEPENDENCY_TYPES`, `START_MODE_VALUES`, `WORKFLOW_NODE_TYPES`, `DRIVE_STATUSES`
 * all live as `as const` arrays with the type derived from the array, not beside it. That
 * direction matters — a derived type cannot drift from the list the code actually iterates.
 *
 * Pure (no node builtins), so the lib barrel can re-export it as a value.
 */

export const ISSUE_TYPES = ["task", "bug", "feature", "chore"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const ISSUE_ESTIMATES = ["XS", "S", "M", "L", "XL"] as const;
export type IssueEstimate = (typeof ISSUE_ESTIMATES)[number];

/**
 * Artifact kinds. `video` is storable but deliberately not offered everywhere — the CLI
 * formatter and the MCP attach tool narrow with `Exclude<IssueArtifactType, "video">`
 * rather than keeping a shorter parallel list.
 */
export const ISSUE_ARTIFACT_TYPES = ["image", "text", "link", "video"] as const;
export type IssueArtifactType = (typeof ISSUE_ARTIFACT_TYPES)[number];

/**
 * `epic` is NOT an issue type — it is a TAG (`seed.ts` seeds it as one).
 *
 * The export/import route accepted it as a type, which is the one place the two models
 * disagreed. #570 resolves that in favour of the tag: importing `epic` as a type would
 * create issues whose type no client can render (the same failure `chore` already had).
 * Kept as a named constant rather than an inline literal so the decision is greppable.
 */
export const ISSUE_TYPE_ALIASES_REJECTED = ["epic"] as const;

export function isIssueType(value: unknown): value is IssueType {
  return typeof value === "string" && (ISSUE_TYPES as readonly string[]).includes(value);
}

export function isIssueEstimate(value: unknown): value is IssueEstimate {
  return typeof value === "string" && (ISSUE_ESTIMATES as readonly string[]).includes(value);
}

/**
 * Display label for an issue type ("task" → "Task").
 *
 * Three of the four client selects capitalized their labels by writing them out; the fourth
 * (WorkflowBuilder) shows the raw value. Deriving the capitalized form means adding a fifth
 * issue type needs no edit in any of them — which was the whole reason `chore` had been
 * missing from all four.
 */
export function issueTypeLabel(type: IssueType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}
