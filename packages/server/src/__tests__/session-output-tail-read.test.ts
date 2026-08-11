/**
 * perf(G1) — /output repository path: metadata probe + bounded async tail read.
 *
 *  - getSessionOutputMeta reads NO transcript content: file size+mtime + max
 *    message id only (the route's pre-read ETag inputs).
 *  - getSessionOutput(?tail=) serves only the file tail (complete JSONL lines),
 *    while the full read still returns the whole file.
 *  - Non-stdout rows are filtered in SQL and appended after the stdout stream.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, appendFileSync, rmSync } from "node:fs";
import { sessionOutputPath } from "@agentic-kanban/shared/lib/session-files";
import { projects, projectStatuses, issues, workspaces, sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { getSessionOutput, getSessionOutputMeta } from "../repositories/session/messages.js";

type Db = ReturnType<typeof createTestDb>["db"];

let seedIssueNumber = 700;
const createdFiles: string[] = [];

afterEach(() => {
  for (const f of createdFiles.splice(0)) {
    try { rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

async function seedSession(db: Db, key: string): Promise<string> {
  const projectId = `proj-tail-${key}`;
  const statusId = `status-tail-${key}`;
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/tmp/p" }).onConflictDoNothing();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 1 }).onConflictDoNothing();
  const issueId = `issue-tail-${key}`;
  await db.insert(issues).values({ id: issueId, issueNumber: seedIssueNumber++, title: "T", statusId, projectId });
  const workspaceId = `ws-tail-${key}`;
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: `feature/tail-${key}`, status: "active" });
  const sessionId = `sess-tail-${key}-${process.pid}-${Date.now()}`;
  await db.insert(sessions).values({ id: sessionId, workspaceId, status: "stopped" });
  return sessionId;
}

function writeOutFile(sessionId: string, content: string): string {
  const p = sessionOutputPath(sessionId);
  writeFileSync(p, content, "utf-8");
  createdFiles.push(p);
  return p;
}

describe("getSessionOutputMeta", () => {
  it("returns file size/mtime + max message id without any content read", async () => {
    const { db } = createTestDb();
    const sid = await seedSession(db, "meta");
    const content = `{"type":"system"}\n{"type":"assistant"}\n`;
    writeOutFile(sid, content);
    await db.insert(sessionMessages).values({ sessionId: sid, type: "stderr", data: "boom" });
    await db.insert(sessionMessages).values({ sessionId: sid, type: "exit", data: null, exitCode: "0" });

    const meta = await getSessionOutputMeta(sid, db);
    expect(meta).not.toBeNull();
    expect(meta!.fileSize).toBe(Buffer.byteLength(content));
    expect(meta!.fileMtimeMs).toBeGreaterThan(0);
    expect(meta!.maxMessageId).toBeGreaterThan(0);
  });

  it("uses -1/-1 sentinels when the .out file is absent and 0 for no messages", async () => {
    const { db } = createTestDb();
    const sid = await seedSession(db, "meta-nofile");
    const meta = await getSessionOutputMeta(sid, db);
    expect(meta).toEqual({ fileSize: -1, fileMtimeMs: -1, maxMessageId: 0 });
  });

  it("returns null for a missing session", async () => {
    const { db } = createTestDb();
    expect(await getSessionOutputMeta("no-such-session", db)).toBeNull();
  });

  it("changes when the file grows or a message row lands (ETag invalidation signal)", async () => {
    const { db } = createTestDb();
    const sid = await seedSession(db, "meta-change");
    const p = writeOutFile(sid, "line one\n");
    const meta1 = await getSessionOutputMeta(sid, db);

    appendFileSync(p, "line two\n");
    const meta2 = await getSessionOutputMeta(sid, db);
    expect(meta2!.fileSize).toBeGreaterThan(meta1!.fileSize);

    await db.insert(sessionMessages).values({ sessionId: sid, type: "stderr", data: "x" });
    const meta3 = await getSessionOutputMeta(sid, db);
    expect(meta3!.maxMessageId).toBeGreaterThan(meta2!.maxMessageId);
  });
});

describe("getSessionOutput tail reads", () => {
  it("tailBytes serves only the file tail, complete lines only", async () => {
    const { db } = createTestDb();
    const sid = await seedSession(db, "tail");
    const lines = Array.from({ length: 100 }, (_, i) => `{"n":${i},"pad":"${"x".repeat(50)}"}`);
    writeOutFile(sid, lines.join("\n") + "\n");

    const full = await getSessionOutput(sid, db);
    expect(full!.messages).toHaveLength(1);
    expect(full!.messages[0].data).toContain(`"n":0`);
    expect(full!.messages[0].data).toContain(`"n":99`);

    const tail = await getSessionOutput(sid, db, { tailBytes: 512 });
    expect(tail!.messages).toHaveLength(1);
    const tailData = tail!.messages[0].data!;
    expect(tailData.length).toBeLessThanOrEqual(512);
    // Newest content present, oldest dropped.
    expect(tailData).toContain(`"n":99`);
    expect(tailData).not.toContain(`"n":0,`);
    // Complete lines only: the window's leading partial line is dropped.
    expect(tailData.startsWith(`{"`)).toBe(true);
  });

  it("appends non-stdout DB rows after the stdout stream (SQL-filtered)", async () => {
    const { db } = createTestDb();
    const sid = await seedSession(db, "tail-mixed");
    writeOutFile(sid, `{"type":"assistant"}\n`);
    // A stray stdout DB row must NOT be duplicated when the file is present.
    await db.insert(sessionMessages).values({ sessionId: sid, type: "stdout", data: "dup-stdout" });
    await db.insert(sessionMessages).values({ sessionId: sid, type: "exit", data: null, exitCode: "0" });

    const result = await getSessionOutput(sid, db, { tailBytes: 4096 });
    const types = result!.messages.map((m) => m.type);
    expect(types).toEqual(["stdout", "exit"]);
    expect(result!.messages[0].data).toContain("assistant");
    expect(result!.messages[1].exitCode).toBe(0);
  });

  it("falls back to DB rows (ascending) when no .out file exists", async () => {
    const { db } = createTestDb();
    const sid = await seedSession(db, "tail-dbonly");
    await db.insert(sessionMessages).values({ sessionId: sid, type: "stdout", data: "first" });
    await db.insert(sessionMessages).values({ sessionId: sid, type: "stdout", data: "second" });
    await db.insert(sessionMessages).values({ sessionId: sid, type: "exit", data: null, exitCode: "1" });

    const result = await getSessionOutput(sid, db);
    expect(result!.messages.map((m) => m.data ?? null)).toEqual(["first", "second", null]);
    expect(result!.messages[2].exitCode).toBe(1);
  });
});
