// @gate:always-run — reads the migration SQL from packages/shared/drizzle, which is outside
// this suite's own import graph, so dependency-based test selection cannot see it.
/**
 * #668 — a project could hold two statuses with the same name.
 *
 * Observed on the real E2E board: a SECOND full set of default statuses, so the board rendered
 * two columns called "Todo" — one holding all 17 issues, one permanently empty — and every
 * by-name lookup (`statuses.find(s => s.name === "Todo")`, which is what the merge path, the
 * monitor and most specs do) silently picked whichever came first. Nothing enforced uniqueness
 * and the one unguarded seeding path appended rather than merged.
 *
 * These tests exercise migration 0125's HEALING half against a database that already has the
 * damage, because "add a unique index" is the easy part — the part that can go wrong is the
 * data it has to fix first, and getting that wrong dangles `issues.status_id`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIGRATION = join(
  import.meta.dirname!, "..", "..", "..", "shared", "drizzle", "0125_project_statuses_unique_name.sql",
);

function applyMigration(db: DatabaseSync) {
  const sql = readFileSync(MIGRATION, "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim();
    if (trimmed) db.exec(trimmed);
  }
}

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "status-unique-"));
  db = new DatabaseSync(join(dir, "test.db"));
  // Only the two tables the migration touches, with the columns it reads.
  db.exec(`CREATE TABLE project_statuses (
    id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE issues (
    id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, status_id TEXT NOT NULL,
    title TEXT NOT NULL)`);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedStatus(id: string, name: string, project = "p1") {
  db.prepare("INSERT INTO project_statuses (id, project_id, name, sort_order, created_at) VALUES (?,?,?,0,'2026-01-01')")
    .run(id, project, name);
}
function seedIssue(id: string, statusId: string, project = "p1") {
  db.prepare("INSERT INTO issues (id, project_id, status_id, title) VALUES (?,?,?,?)")
    .run(id, project, statusId, `issue ${id}`);
}
const statusNames = () =>
  db.prepare("SELECT name FROM project_statuses ORDER BY rowid").all().map((r) => (r as { name: string }).name);
const statusOf = (issueId: string) =>
  (db.prepare("SELECT status_id FROM issues WHERE id = ?").get(issueId) as { status_id: string }).status_id;

describe("migration 0125 — heal, then constrain", () => {
  it("collapses a duplicate name onto one row", () => {
    seedStatus("s1", "Todo");
    seedStatus("s2", "Todo");
    applyMigration(db);
    expect(statusNames()).toEqual(["Todo"]);
  });

  it("moves issues off the duplicate instead of orphaning them", () => {
    // The real shape: the SECOND row is the empty one, but issues can sit on either — the
    // migration must not assume which, or it deletes a status an issue still points at.
    seedStatus("keep", "Todo");
    seedStatus("dup", "Todo");
    seedIssue("i1", "keep");
    seedIssue("i2", "dup");
    applyMigration(db);
    expect(statusOf("i1")).toBe("keep");
    expect(statusOf("i2")).toBe("keep");
    // No issue points at a status that no longer exists.
    const dangling = db.prepare(
      "SELECT COUNT(*) AS n FROM issues LEFT JOIN project_statuses ON project_statuses.id = issues.status_id WHERE project_statuses.id IS NULL",
    ).get() as { n: number };
    expect(dangling.n).toBe(0);
  });

  it("heals a whole duplicated default set, the case actually observed", () => {
    const names = ["Backlog", "Todo", "In Progress", "In Review", "AI Reviewed", "Done", "Cancelled"];
    names.forEach((n, i) => seedStatus(`a${i}`, n));
    // The observed second set had NO Backlog — which is why it could not have come from the
    // canonical seed list, and is recorded here so the shape is not lost.
    names.slice(1).forEach((n, i) => seedStatus(`b${i}`, n));
    seedIssue("i1", "b0"); // an issue on the duplicate "Todo"
    applyMigration(db);
    expect(statusNames()).toEqual(names);
    expect(statusOf("i1")).toBe("a1");
  });

  it("leaves same-named statuses in DIFFERENT projects alone", () => {
    // Every project has a "Todo". The constraint is per project, not global.
    seedStatus("p1todo", "Todo", "p1");
    seedStatus("p2todo", "Todo", "p2");
    applyMigration(db);
    expect(statusNames()).toEqual(["Todo", "Todo"]);
  });

  it("is a no-op on a clean database", () => {
    ["Backlog", "Todo", "Done"].forEach((n, i) => seedStatus(`s${i}`, n));
    seedIssue("i1", "s1");
    applyMigration(db);
    expect(statusNames()).toEqual(["Backlog", "Todo", "Done"]);
    expect(statusOf("i1")).toBe("s1");
  });

  it("REFUSES a duplicate afterwards — the point of the whole exercise", () => {
    seedStatus("s1", "Todo");
    applyMigration(db);
    expect(() => seedStatus("s2", "Todo")).toThrow(/UNIQUE/i);
  });
});

/**
 * The bug the #668 index EXPOSED, pinned so it cannot come back.
 *
 * `resolveNewIssueDefaults` chose the status for a new issue with `limit(1)` and no ORDER BY,
 * so "which column does a new issue land in" was decided by whichever index the query planner
 * picked. Adding the unique index on (project_id, name) moved that from insertion order to
 * NAME order, and issues started landing in "AI Reviewed" instead of "Todo" — a visible,
 * user-facing change from a schema addition that should have had none.
 *
 * `is_default` exists precisely to name that column, and nothing was reading it.
 */
describe("#668 fallout — the default status is chosen, not stumbled upon", () => {
  it("is the is_default row, not the first one the index happens to return", () => {
    applyMigration(db);
    // Inserted in board order; alphabetically "AI Reviewed" sorts first, which is exactly
    // what the unique index made the planner return.
    seedStatus("s0", "Todo");
    seedStatus("s1", "In Progress");
    seedStatus("s2", "AI Reviewed");
    db.prepare("UPDATE project_statuses SET is_default = 1, sort_order = 0 WHERE id = 's0'").run();
    db.prepare("UPDATE project_statuses SET sort_order = 1 WHERE id = 's1'").run();
    db.prepare("UPDATE project_statuses SET sort_order = 3 WHERE id = 's2'").run();

    // The same ordering the repository now applies.
    const picked = db.prepare(
      "SELECT id FROM project_statuses WHERE project_id = 'p1' ORDER BY is_default DESC, sort_order ASC LIMIT 1",
    ).get() as { id: string };
    expect(picked.id).toBe("s0");

    // …and without the ORDER BY the planner is free to disagree, which is the whole point.
    const unordered = db.prepare(
      "SELECT id FROM project_statuses WHERE project_id = 'p1' LIMIT 1",
    ).get() as { id: string };
    expect(["s0", "s1", "s2"]).toContain(unordered.id);
  });

  it("falls back to the leftmost column when no row is marked default", () => {
    applyMigration(db);
    seedStatus("z", "Zeta");
    seedStatus("a", "Alpha");
    db.prepare("UPDATE project_statuses SET sort_order = 5 WHERE id = 'a'").run();
    db.prepare("UPDATE project_statuses SET sort_order = 1 WHERE id = 'z'").run();
    const picked = db.prepare(
      "SELECT id FROM project_statuses WHERE project_id = 'p1' ORDER BY is_default DESC, sort_order ASC LIMIT 1",
    ).get() as { id: string };
    expect(picked.id).toBe("z");
  });
});
