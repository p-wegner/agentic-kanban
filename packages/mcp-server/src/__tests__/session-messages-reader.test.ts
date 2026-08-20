// @covers shared.session-messages.readSessionMessages [correctness,transcript]
//
// #507. The ".out file for stdout, else session_messages" rule was forked across four
// row-fetching call sites; it now lives in `shared/lib/session-messages.ts`. These tests
// live in mcp-server because that is where the seeded-DB harness is — shared has no
// equivalent, and the alternative (a second harness) is the duplication this ticket is
// about.
//
// The subtle part, and the reason the helper returns `{ messages, total }` rather than a
// bare array: `read_terminal` reports the count BEFORE the limit. A helper that returned
// only the page would have silently changed that number.
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as schema from "@agentic-kanban/shared/schema";
import { readSessionMessages } from "@agentic-kanban/shared/lib/session-messages";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

const written: string[] = [];

/** Write the per-session .out file the detached-agent path streams stdout to. */
function writeStdoutFile(sessionId: string, content: string) {
  const path = join(tmpdir(), `kanban-session-${sessionId}.out`);
  writeFileSync(path, content, "utf-8");
  written.push(path);
}

afterEach(() => {
  for (const p of written.splice(0)) {
    try { rmSync(p, { force: true }); } catch { /* best-effort */ }
  }
});

/** A session with the given message rows, in insertion order. */
async function seedSession(
  db: TestDb,
  rows: Array<{ type: string; data: string; exitCode?: string }>,
): Promise<string> {
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  const issueId = randomUUID();
  const projectId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(schema.issues).values({
    id: issueId, issueNumber: 1, title: "I", priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId, issueId, branch: "b", status: "idle",
    workingDir: "/tmp/ws", createdAt: now,
  });
  await db.insert(schema.sessions).values({
    id: sessionId, workspaceId, status: "completed", startedAt: now,
  });
  for (const r of rows) {
    await db.insert(schema.sessionMessages).values({
      sessionId, type: r.type, data: r.data, exitCode: r.exitCode, createdAt: now,
    });
  }
  return sessionId;
}

describe("readSessionMessages — no .out file (historical session)", () => {
  it("returns every row from the DB, chronologically", async () => {
    const { db } = createTestDb();
    const sessionId = await seedSession(db, [
      { type: "stdout", data: "one" },
      { type: "stdout", data: "two" },
      { type: "exit", data: "", exitCode: "0" },
    ]);

    const { messages, total } = await readSessionMessages(db, sessionId);
    expect(messages.map((m) => m.data)).toEqual(["one", "two", ""]);
    expect(total).toBe(3);
  });

  it("limit returns the NEWEST page, still chronological, with total unlimited", async () => {
    const { db } = createTestDb();
    const sessionId = await seedSession(db, [
      { type: "stdout", data: "a" },
      { type: "stdout", data: "b" },
      { type: "stdout", data: "c" },
    ]);

    const { messages, total } = await readSessionMessages(db, sessionId, { limit: 2 });
    expect(messages.map((m) => m.data)).toEqual(["b", "c"]);
    // The point of the `{ messages, total }` shape — 3, not 2.
    expect(total).toBe(3);
  });
});

describe("readSessionMessages — .out file present (detached agent)", () => {
  it("serves stdout from the file and MERGES the non-stdout DB rows", async () => {
    const { db } = createTestDb();
    const sessionId = await seedSession(db, [
      { type: "stdout", data: "STALE DB STDOUT" },
      { type: "exit", data: "", exitCode: "0" },
    ]);
    writeStdoutFile(sessionId, "FRESH FILE STDOUT");

    const { messages, total } = await readSessionMessages(db, sessionId);
    expect(messages[0]).toEqual({ type: "stdout", data: "FRESH FILE STDOUT" });
    // The exit row must survive: it is what tells a reader how the session ended.
    expect(messages.some((m) => m.type === "exit")).toBe(true);
    // The DB's own stdout row is superseded, not appended.
    expect(messages.some((m) => m.data === "STALE DB STDOUT")).toBe(false);
    expect(total).toBe(2);
  });

  it("total counts the merged set, not the DB rows", async () => {
    const { db } = createTestDb();
    const sessionId = await seedSession(db, [
      { type: "stdout", data: "x" },
      { type: "stderr", data: "warn" },
      { type: "exit", data: "", exitCode: "1" },
    ]);
    writeStdoutFile(sessionId, "file");

    // 1 synthetic stdout + stderr + exit = 3 (the DB's stdout row is replaced).
    const { messages, total } = await readSessionMessages(db, sessionId, { limit: 1 });
    expect(total).toBe(3);
    expect(messages).toHaveLength(1);
  });
});
