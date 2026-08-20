/**
 * perf(G2) — /sessions/:id/summary memoizes parseSessionSummary keyed on
 * (sessionId, .out size+mtime, max message id). A poll over an unchanged
 * transcript must be a memo HIT (no re-parse — asserted via the miss counter,
 * which increments exactly once per actual parse); any change to the file or
 * the message rows invalidates the key.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, appendFileSync, rmSync, utimesSync } from "node:fs";
import { sessionOutputPath } from "@agentic-kanban/shared/lib/session-files";
import { projects, projectStatuses, issues, workspaces, sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  getSessionSummaryData,
  clearSessionSummaryMemo,
  getSessionSummaryMemoStats,
} from "../repositories/session/stats.js";

type Db = ReturnType<typeof createTestDb>["db"];

let seedIssueNumber = 800;
const createdFiles: string[] = [];

beforeEach(() => clearSessionSummaryMemo());
afterEach(() => {
  for (const f of createdFiles.splice(0)) {
    try { rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

async function seedSession(db: Db, key: string, stats?: string): Promise<string> {
  const projectId = `proj-memo-${key}`;
  const statusId = `status-memo-${key}`;
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/tmp/p" }).onConflictDoNothing();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 1 }).onConflictDoNothing();
  const issueId = `issue-memo-${key}`;
  await db.insert(issues).values({ id: issueId, issueNumber: seedIssueNumber++, title: "T", statusId, projectId });
  const workspaceId = `ws-memo-${key}`;
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: `feature/memo-${key}`, status: "active" });
  const sessionId = `sess-memo-${key}-${process.pid}-${Date.now()}`;
  await db.insert(sessions).values({ id: sessionId, workspaceId, status: "stopped", stats: stats ?? null });
  return sessionId;
}

function writeOutFile(sessionId: string, content: string): string {
  const p = sessionOutputPath(sessionId);
  writeFileSync(p, content, "utf-8");
  createdFiles.push(p);
  return p;
}

const editLine = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/tmp/a.ts" } }] },
});

describe("getSessionSummaryData memoization", () => {
  it("does not re-parse on an unchanged transcript (memo hit) and still returns a full summary", async () => {
    const { db } = createTestDb();
    const sid = await seedSession(db, "hit");
    writeOutFile(sid, `${editLine}\n`);

    const first = await getSessionSummaryData(sid, db);
    expect(first).not.toBeNull();
    expect(first!.filesEdited).toContain("/tmp/a.ts");
    expect(getSessionSummaryMemoStats()).toMatchObject({ hits: 0, misses: 1 });

    const second = await getSessionSummaryData(sid, db);
    expect(getSessionSummaryMemoStats()).toMatchObject({ hits: 1, misses: 1 });
    expect(second!.filesEdited).toEqual(first!.filesEdited);
  });

  it("re-parses when the .out file changes", async () => {
    const { db } = createTestDb();
    const sid = await seedSession(db, "grow");
    const p = writeOutFile(sid, `${editLine}\n`);
    await getSessionSummaryData(sid, db);

    appendFileSync(p, `${editLine.replace("/tmp/a.ts", "/tmp/b.ts")}\n`);
    // Force a distinct mtime as well (some filesystems have coarse mtime).
    utimesSync(p, new Date(), new Date(Date.now() + 5000));

    const after = await getSessionSummaryData(sid, db);
    expect(getSessionSummaryMemoStats()).toMatchObject({ hits: 0, misses: 2 });
    expect(after!.filesEdited).toContain("/tmp/b.ts");
  });

  it("re-parses when a new message row lands (DB-fallback sessions)", async () => {
    const { db } = createTestDb();
    const sid = await seedSession(db, "dbrows");
    await db.insert(sessionMessages).values({ sessionId: sid, type: "stdout", data: editLine });
    const first = await getSessionSummaryData(sid, db);
    expect(first!.filesEdited).toContain("/tmp/a.ts");

    await db.insert(sessionMessages).values({
      sessionId: sid,
      type: "stdout",
      data: editLine.replace("/tmp/a.ts", "/tmp/c.ts"),
    });
    const second = await getSessionSummaryData(sid, db);
    expect(getSessionSummaryMemoStats()).toMatchObject({ hits: 0, misses: 2 });
    expect(second!.filesEdited).toContain("/tmp/c.ts");
  });

  it("agentSummary fallback from stats applies on memo hits too (cache is never mutated)", async () => {
    const { db } = createTestDb();
    const sid = await seedSession(db, "fold", JSON.stringify({ agentSummary: "from stats" }));
    writeOutFile(sid, `{"type":"system","subtype":"init"}\n`);

    const first = await getSessionSummaryData(sid, db);
    expect(first!.agentSummary).toBe("from stats");
    const second = await getSessionSummaryData(sid, db);
    expect(getSessionSummaryMemoStats()).toMatchObject({ hits: 1, misses: 1 });
    expect(second!.agentSummary).toBe("from stats");
  });
});
