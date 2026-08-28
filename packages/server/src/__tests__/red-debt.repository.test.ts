/**
 * #915 — the red-debt ledger: one OPEN row per (project, suite), opened idempotently,
 * resolvable, and listable.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  openRedDebtEntry,
  getOpenRedDebtEntry,
  resolveRedDebtEntry,
  setRedDebtOwnerIssue,
  listRedDebt,
} from "../repositories/red-debt.repository.js";

async function seedProject(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Red Debt Project",
    repoPath: "/tmp/red-debt-project",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

describe("red-debt repository (#915)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("opens a new entry and reads it back", async () => {
    const projectId = await seedProject(db);
    const entry = await openRedDebtEntry(
      { projectId, suite: "server/foo.test.ts", sinceCommit: "abc123", tag: "real" },
      db,
    );
    expect(entry.suite).toBe("server/foo.test.ts");
    expect(entry.resolvedAt).toBeNull();
    expect(entry.tag).toBe("real");

    const found = await getOpenRedDebtEntry(projectId, "server/foo.test.ts", db);
    expect(found?.id).toBe(entry.id);
  });

  it("is idempotent — opening an already-open suite returns the SAME row, not a duplicate", async () => {
    const projectId = await seedProject(db);
    const first = await openRedDebtEntry(
      { projectId, suite: "server/foo.test.ts", sinceCommit: "abc123", tag: "real" },
      db,
    );
    const second = await openRedDebtEntry(
      { projectId, suite: "server/foo.test.ts", sinceCommit: "def456", tag: "flaky" },
      db,
    );
    expect(second.id).toBe(first.id);
    expect(second.sinceCommit).toBe("abc123");

    const all = await listRedDebt(projectId, {}, db);
    expect(all).toHaveLength(1);
  });

  it("resolving closes the entry and it drops out of the open-only listing", async () => {
    const projectId = await seedProject(db);
    await openRedDebtEntry({ projectId, suite: "server/foo.test.ts", sinceCommit: "abc123", tag: "real" }, db);

    await resolveRedDebtEntry(projectId, "server/foo.test.ts", db);

    expect(await getOpenRedDebtEntry(projectId, "server/foo.test.ts", db)).toBeNull();
    expect(await listRedDebt(projectId, {}, db)).toHaveLength(0);
    expect(await listRedDebt(projectId, { includeResolved: true }, db)).toHaveLength(1);
  });

  it("a resolved entry can be reopened as a fresh row (a new red streak)", async () => {
    const projectId = await seedProject(db);
    const first = await openRedDebtEntry({ projectId, suite: "server/foo.test.ts", sinceCommit: "abc123", tag: "real" }, db);
    await resolveRedDebtEntry(projectId, "server/foo.test.ts", db);

    const second = await openRedDebtEntry({ projectId, suite: "server/foo.test.ts", sinceCommit: "zzz999", tag: "real" }, db);
    expect(second.id).not.toBe(first.id);
    expect(second.sinceCommit).toBe("zzz999");
  });

  it("attaches an owner (pay-down) issue id", async () => {
    const projectId = await seedProject(db);
    const entry = await openRedDebtEntry({ projectId, suite: "server/foo.test.ts", sinceCommit: "abc123", tag: "real" }, db);
    await setRedDebtOwnerIssue(entry.id, "42", db);

    const rows = await listRedDebt(projectId, {}, db);
    expect(rows[0]?.ownerIssueId).toBe("42");
  });

  it("lists open-only entries newest-first, scoped to the project", async () => {
    const projectId = await seedProject(db);
    const otherProjectId = await seedProject(db);
    await openRedDebtEntry({ projectId, suite: "a.test.ts", sinceCommit: "sha1", tag: "real" }, db);
    await openRedDebtEntry({ projectId, suite: "b.test.ts", sinceCommit: "sha2", tag: "flaky" }, db);
    await openRedDebtEntry({ projectId: otherProjectId, suite: "c.test.ts", sinceCommit: "sha3", tag: "real" }, db);

    const rows = await listRedDebt(projectId, {}, db);
    expect(rows.map((r) => r.suite).sort()).toEqual(["a.test.ts", "b.test.ts"]);
  });
});
