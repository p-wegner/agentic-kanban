/**
 * The status topology a project is born with — one list, one row builder (#563).
 *
 * `initializeProjectStatuses` used to own the only real copy, return `void`, and be
 * reachable from server code alone. So 137 test files hand-seeded `project_statuses`
 * instead, and the seeds DRIFTED from production: 43 marked "In Progress" as the
 * default column (production: "Todo"), 27 omitted "Backlog" entirely, 16 omitted
 * "AI Reviewed", and the MCP seed had no "Backlog" either. A suite asserting on a
 * topology production never creates is a suite that can pass while the board is broken.
 *
 * This module is deliberately PURE — it builds rows and hands them back rather than
 * inserting them — so the server repository, the server test helpers and the
 * mcp-server test helpers can all share it without any of them depending on the
 * others' database handle.
 */

export interface ProjectStatusSeed {
  name: string;
  sortOrder: number;
  isDefault: boolean;
}

export interface ProjectStatusRow extends ProjectStatusSeed {
  id: string;
  projectId: string;
  createdAt: string;
}

/** The columns every new project gets. Backlog sorts BEFORE Todo, hence -1. */
export const DEFAULT_PROJECT_STATUSES: readonly ProjectStatusSeed[] = [
  { name: "Backlog", sortOrder: -1, isDefault: false },
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "AI Reviewed", sortOrder: 3, isDefault: false },
  { name: "Done", sortOrder: 4, isDefault: false },
  { name: "Cancelled", sortOrder: 5, isDefault: false },
];

/**
 * Materialise the seed list into insertable rows with fresh ids.
 *
 * `globalThis.crypto.randomUUID` rather than `node:crypto` — this module sits in the
 * client-reachable `lib` barrel, and a node-only import there breaks the browser build.
 */
export function buildProjectStatusRows(
  projectId: string,
  now: string,
  seeds: readonly ProjectStatusSeed[] = DEFAULT_PROJECT_STATUSES,
): ProjectStatusRow[] {
  return seeds.map((seed) => ({
    id: globalThis.crypto.randomUUID(),
    projectId,
    name: seed.name,
    sortOrder: seed.sortOrder,
    isDefault: seed.isDefault,
    createdAt: now,
  }));
}

/** `{ Todo: "<id>", "In Progress": "<id>", … }` — what callers actually want back. */
export function statusIdsByName(rows: readonly ProjectStatusRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.name, row.id]));
}

/** The name of the column a new issue lands in when none is given. */
export function defaultStatusName(seeds: readonly ProjectStatusSeed[] = DEFAULT_PROJECT_STATUSES): string {
  return (seeds.find((s) => s.isDefault) ?? seeds[0]).name;
}
