/**
 * The encoding of a workflow edge's `condition` string, and how an edge reads on canvas (#722).
 *
 * A condition is stored as a single string, and one of them is PARAMETERIZED:
 * `diff_touches:<glob>`. So the value shown in the condition `<select>` is not the stored
 * value — it is the part before the colon — and switching to `diff_touches` has to
 * re-attach the glob the user already typed. Every function here is a projection of that
 * one string: split it, read its argument, rebuild it, or render it into the canvas label
 * beside the edge's own name.
 */

/** Conditions an edge may carry. `diff_touches` is stored with a `:<glob>` argument. */
export const EDGE_CONDITIONS = [
  "manual",
  "auto_on_exit_0",
  "tests_pass",
  "tests_fail",
  "diff_clean",
  "diff_touches",
] as const;

/** The condition without its argument — i.e. the value the condition `<select>` shows. */
export function edgeConditionBase(condition: string): string {
  const idx = condition.indexOf(":");
  return idx === -1 ? condition : condition.slice(0, idx);
}

/** The glob argument of a `diff_touches:<glob>` condition ("" for any other condition). */
export function readDiffTouchesGlob(condition: string): string {
  return edgeConditionBase(condition) === "diff_touches" ? condition.slice("diff_touches:".length) : "";
}

/** Build a `diff_touches` condition carrying the given glob. */
export function writeDiffTouchesCondition(glob: string): string {
  return `diff_touches:${glob}`;
}

/** The canvas label for an edge: its name plus its condition, or "manual" if it has neither. */
export function edgeLabel(label: string | null | undefined, condition: string | null | undefined): string {
  const parts = [label, condition && condition !== "manual" ? `[${condition}]` : ""].filter(Boolean);
  return parts.join(" ") || "manual";
}
