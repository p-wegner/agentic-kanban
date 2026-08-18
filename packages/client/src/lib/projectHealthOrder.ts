/**
 * Ordering for the Project Health overview (#637).
 *
 * The dialog is opened FROM a board, so the project the user is looking at is the one
 * they came to check — but it was rendered in whatever order the API returned, which
 * put it anywhere in the list (below several projects the user has no interest in, on a
 * board with many). Every entry already carries its project name and the active one is
 * already highlighted, so the fix is ordering, not filtering: the overview's value is
 * precisely that it shows the OTHER projects too.
 *
 * After the active project, warned projects come first — an unattended project with a
 * warning is the second thing worth seeing — and the API's order is otherwise preserved.
 */

export interface HealthOrderable {
  id: string;
  warnings: string[];
}

export function sortProjectHealth<T extends HealthOrderable>(
  projects: T[],
  activeProjectId: string | null | undefined,
): T[] {
  // Rank, then a stable sort on the index, so projects of equal rank keep the
  // server's order instead of being reshuffled on every render.
  const rank = (p: T) => (p.id === activeProjectId ? 0 : p.warnings.length > 0 ? 1 : 2);
  return projects
    .map((project, index) => ({ project, index }))
    .sort((a, b) => rank(a.project) - rank(b.project) || a.index - b.index)
    .map((entry) => entry.project);
}
