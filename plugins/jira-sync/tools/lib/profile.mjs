// Mirrors the board's own scaffold gate (countScaffoldPlaceholders): a TODO:
// marker outside inline code is treated as "a human has not decided this yet".
// Our own commands re-check it directly because they can run standalone
// (bootstrap/selftest) as well as through the board.

import { existsSync, readFileSync } from "node:fs";

export function countTodos(text) {
  return (text.replace(/`[^`\n]*`/g, "").match(/TODO:/g) ?? []).length;
}

/**
 * Returns `{ ok: true }` when the profile has no outstanding TODOs, or
 * `{ ok: false, reason }` otherwise. A missing file reads as "filled in" —
 * same rule the board applies — because deciding a project has no profile at
 * all is a different problem than "the human hasn't finished filling it in".
 */
export function checkProfile(profilePath) {
  // No path to check (e.g. running standalone, outside the board) reads the
  // same as a missing file: nothing to gate on.
  if (!profilePath || !existsSync(profilePath)) return { ok: true };
  const todos = countTodos(readFileSync(profilePath, "utf8"));
  if (todos > 0) return { ok: false, reason: `${todos} unfilled TODO(s) in the profile — a human decides scope` };
  return { ok: true };
}
