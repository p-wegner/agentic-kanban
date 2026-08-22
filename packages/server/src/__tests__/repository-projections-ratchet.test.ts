// @gate:always-run — recursively walks the repositories tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The repository layer's shared projections are a DOWN-only ring (#732).
 *
 * #732 named the repository layer as the second duplication cluster. Re-measured here with
 * token-windowed clone detection, the largest clone runs between repository files were the
 * `select({...})` PROJECTIONS, not the query logic: the same column lists re-spelled per
 * accessor, per table. `repositories/projections.ts` declares them once.
 *
 * This suite is the disclosure channel that keeps the win (CLAUDE.md, #691). It enforces two
 * properties a one-off refactor commit cannot:
 *
 *   1. **Every shared projection has at least two real production callers.** #591 landed a
 *      shared helper with zero non-test callers and is remembered as a failure; a projection
 *      that drops to one caller should be inlined back, not left standing as evidence of an
 *      extraction that did not happen.
 *   2. **No raw re-spelling comes back.** The column runs the extraction removed are frozen
 *      at ZERO outside `projections.ts`, so pasting a sibling accessor's projection fails
 *      here instead of quietly restoring the duplication.
 */
const repositoriesDir = path.join(import.meta.dirname!, "..", "repositories");
const PROJECTIONS_FILE = "projections.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(repositoriesDir, f).split(path.sep).join("/");
const files = walk(repositoriesDir);
const readCache = new Map<string, string>();
const read = (f: string) => {
  let cached = readCache.get(f);
  if (cached === undefined) readCache.set(f, (cached = fs.readFileSync(f, "utf8")));
  return cached;
};

/** The projections `projections.ts` exports, and the minimum callers each must keep. */
const SHARED_PROJECTIONS = [
  "issueIdentityColumns",
  "issueTextColumns",
  "issueTriageColumns",
  "sessionLifecycleColumns",
  "issueDependencyColumns",
  "projectStatusIdName",
  "preferenceKeyValueColumns",
];

/**
 * The exact column runs the extraction removed, as normalised consecutive lines. Frozen at
 * zero occurrences OUTSIDE `projections.ts` — this is the ratchet, not a style preference.
 */
const REMOVED_RUNS: Record<string, string[]> = {
  issueIdentityColumns: ["id: issues.id,", "issueNumber: issues.issueNumber,", "title: issues.title,"],
  sessionLifecycleColumns: [
    "id: sessions.id,",
    "workspaceId: sessions.workspaceId,",
    "status: sessions.status,",
    "startedAt: sessions.startedAt,",
    "endedAt: sessions.endedAt,",
  ],
  issueDependencyColumns: [
    "id: issueDependencies.id,",
    "issueId: issueDependencies.issueId,",
    "dependsOnId: issueDependencies.dependsOnId,",
    "type: issueDependencies.type,",
  ],
};

/** One-line projections that were spelled inline. Also frozen at zero. */
const REMOVED_INLINE: Record<string, string> = {
  projectStatusIdName: ".select({ id: projectStatuses.id, name: projectStatuses.name })",
  preferenceKeyValueColumns: ".select({ key: preferences.key, value: preferences.value })",
};

describe("repository projections (#732)", () => {
  it("the scan reaches the repositories tree and finds projections.ts", () => {
    // A path typo would make every assertion below vacuously green.
    expect(files.length).toBeGreaterThan(80);
    expect(files.map(rel)).toContain(PROJECTIONS_FILE);
  });

  it("every shared projection is exported from projections.ts", () => {
    const source = read(path.join(repositoriesDir, PROJECTIONS_FILE));
    const missing = SHARED_PROJECTIONS.filter((n) => !new RegExp(`^export const ${n}\\b`, "m").test(source));
    expect(missing, `not exported — rename here too:\n${missing.join("\n")}`).toEqual([]);
  });

  it("no shared projection has fewer than two production callers (#591)", () => {
    const consumers = files.filter((f) => rel(f) !== PROJECTIONS_FILE);
    const thin = SHARED_PROJECTIONS.map((name) => {
      const callers = consumers.filter((f) => new RegExp(`\\b${name}\\b`).test(read(f))).map(rel);
      return { name, callers };
    }).filter((p) => p.callers.length < 2);
    expect(
      thin,
      "A shared projection with fewer than two callers is the #591 failure mode — inline it\n" +
        "back into its one caller rather than leaving a helper nobody shares:\n" +
        thin.map((p) => `${p.name}: ${p.callers.length} caller(s) [${p.callers.join(", ")}]`).join("\n"),
    ).toEqual([]);
  });

  it("no removed column run is re-spelled outside projections.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (rel(file) === PROJECTIONS_FILE) continue;
      const lines = read(file).split(/\r?\n/).map((l) => l.trim());
      for (const [name, run] of Object.entries(REMOVED_RUNS)) {
        for (let i = 0; i + run.length <= lines.length; i++) {
          if (run.every((want, k) => lines[i + k] === want)) {
            offenders.push(`${rel(file)}:${i + 1} re-spells ${name}`);
          }
        }
      }
    }
    expect(
      offenders,
      "Spread the shared projection instead of re-listing its columns:\n" +
        "  .select({ ...issueIdentityColumns, statusName: projectStatuses.name })\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("no removed inline projection is re-spelled outside projections.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (rel(file) === PROJECTIONS_FILE) continue;
      const text = read(file);
      for (const [name, snippet] of Object.entries(REMOVED_INLINE)) {
        if (text.includes(snippet)) offenders.push(`${rel(file)} re-spells ${name}`);
      }
    }
    expect(offenders, `use .select(${"<the shared constant>"}):\n${offenders.join("\n")}`).toEqual([]);
  });

  /**
   * The other half of #732's repository work: SIX repositories declared the byte-identical
   * `{id, name}` status list under six different names, and the copies had already drifted
   * (one ordered by `sortOrder`, five did not). One implementation now; the six old names
   * are one-line delegations.
   */
  it("the project-status id/name query is spelled in exactly one place", () => {
    const query = ".from(projectStatuses)";
    const marker = ".select(projectStatusIdName)";
    const spellers = files.filter((f) => {
      const t = read(f);
      return t.includes(marker) && t.includes(query);
    }).map(rel);
    expect(
      spellers.sort(),
      "call listProjectStatusIdNames() instead of re-spelling the query. The one accepted\n" +
        "extra site reads inside a transaction, which the accessor's `database: Database`\n" +
        "seam cannot take (#604):\n" + spellers.join("\n"),
    ).toEqual(["backlog-snapshot.repository.ts", "project-status.repository.ts"]);
  });
});
