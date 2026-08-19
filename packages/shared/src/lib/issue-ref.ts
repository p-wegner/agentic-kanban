/**
 * The ONE policy for "is this issue reference a number or an id" (#509).
 *
 * A ticket can be named two ways: by its per-project `issueNumber` (`42`, what CLAUDE.md
 * means by `#N`) or by its globally unique `id`. Five places decided that with their own
 * copy of `/^\d+$/` — two CLI handlers, two repository functions, and the `get_issue` MCP
 * tool — and each carried its own scoping comment because each had learned the same lesson
 * separately: #506 fixed an unscoped numeric lookup in the MCP tool, #506 fixed one in
 * `getIssueSummary`, and #509 fixed a `projectId!` non-null assertion in
 * `getIssueByNumberOrId` that turned a missing project into `project_id = undefined`.
 *
 * The decision itself is a pure string question, so it lives here — one regex, one place to
 * change if issue references ever grow a third spelling. The SCOPING consequence is stated
 * here too, since it is what every one of those bugs got wrong:
 *
 *   **A numeric reference is meaningless without a project.** Issue numbers are assigned per
 *   project (`MAX(issue_number) + 1`), so `where(issueNumber = 42)` matches a row in every
 *   project that has reached 42 and `.limit(1)` picks an arbitrary one. A caller resolving a
 *   `number` ref must supply a projectId — explicit, or the active project.
 *
 * This deliberately does NOT validate that an `id` ref looks like a UUID. Callers pass ids
 * straight from the DB, and a stricter check would turn a lookup that returns "not found"
 * into a parse error for no gain.
 */
export type IssueRef =
  | { kind: "number"; issueNumber: number }
  | { kind: "id"; issueId: string };

const NUMERIC_REF = /^\d+$/;

export function parseIssueRef(ref: string | number): IssueRef {
  if (typeof ref === "number") return { kind: "number", issueNumber: ref };
  return NUMERIC_REF.test(ref) ? { kind: "number", issueNumber: Number(ref) } : { kind: "id", issueId: ref };
}

/** Convenience for the many call sites that only branch on which kind it is. */
export function isNumericIssueRef(ref: string | number): boolean {
  return parseIssueRef(ref).kind === "number";
}
