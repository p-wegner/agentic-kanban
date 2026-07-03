/**
 * Tests for the agent-questions performance fixes:
 *  - closed workspaces are excluded from the scan (behavior-preserving)
 *  - .out transcript files are parsed as JSONL lines (latent-bug fix: file-backed
 *    sessions previously could never surface questions) and only the tail is read
 *  - per-project response cache with explicit invalidation paths
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import {
  listPendingQuestionsForProject,
  invalidateAgentQuestionsCache,
  markAnswered,
  markDismissed,
  setCachedRecommendations,
} from "../services/agent-questions.service.js";
import { readSessionStdoutFileTail } from "../lib/session-output-reader.js";
import { sessionOutputPath } from "../lib/session-paths.js";
import { createTestDb } from "./helpers/test-db.js";
import { setRuntimeState } from "../repositories/runtime-state.repository.js";
import {
  projects,
  projectStatuses,
  issues,
  workspaces,
  sessions,
  sessionMessages,
} from "@agentic-kanban/shared/schema";

type Db = ReturnType<typeof createTestDb>["db"];

const PROJECT_ID = "proj-perf";

// Unique per-issue number: migration 0094 enforces UNIQUE(project_id, issue_number)
// and seed() shares one PROJECT_ID across calls. Start at 100 so seeded numbers never
// collide with the explicit issueNumber 2/3 literals used elsewhere in this file.
let seedIssueNumber = 100;

function ts(offsetMs: number) {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Pre-cache a recommendation for a toolUseId WITHOUT touching the response
 *  cache (raw pref write) — keeps listPendingQuestionsForProject from firing the
 *  fire-and-forget background butler recommendation, whose completion would
 *  invalidate the cache at a nondeterministic time. */
async function primeRecommendationPref(toolUseId: string, db: Db) {
  await setRuntimeState(
    `agent_question_recommendation_${toolUseId}`,
    JSON.stringify({ recommendations: [null] }),
    db,
  );
}

function denialResultLine(toolUseId: string): string {
  return JSON.stringify({
    type: "result",
    permission_denials: [{
      tool_name: "AskUserQuestion",
      tool_use_id: toolUseId,
      tool_input: { questions: [{ question: "Pick one?", options: [{ label: "A" }, { label: "B" }] }] },
    }],
  });
}

/** Seed one issue+workspace+stopped session for PROJECT_ID; optionally with a
 *  question-bearing stdout row in session_messages. Pre-caches a recommendation
 *  for the toolUseId so listPendingQuestionsForProject does not fire the
 *  background butler recommendation (keeps tests deterministic). */
async function seed(db: Db, opts: {
  key: string;
  toolUseId?: string;
  workspaceStatus?: string;
  workspaceClosedAt?: string | null;
  withDbQuestion?: boolean;
}) {
  const statusId = "status-perf";
  await db.insert(projects).values({ id: PROJECT_ID, name: "p", repoPath: "/tmp/p" }).onConflictDoNothing();
  await db.insert(projectStatuses).values({ id: statusId, projectId: PROJECT_ID, name: "In Progress", sortOrder: 1 }).onConflictDoNothing();
  const issueId = `issue-${opts.key}`;
  await db.insert(issues).values({ id: issueId, issueNumber: seedIssueNumber++, title: "T", statusId, projectId: PROJECT_ID });
  const workspaceId = `ws-${opts.key}`;
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: `feature/${opts.key}`,
    status: opts.workspaceStatus ?? "active",
    closedAt: opts.workspaceClosedAt ?? null,
  });
  const sessionId = `sess-${opts.key}`;
  await db.insert(sessions).values({
    id: sessionId,
    workspaceId,
    status: "stopped",
    startedAt: ts(-60 * 60 * 1000),
    endedAt: ts(-30 * 60 * 1000),
  });
  if (opts.withDbQuestion !== false && opts.toolUseId) {
    await db.insert(sessionMessages).values({ sessionId, type: "stdout", data: denialResultLine(opts.toolUseId) });
  }
  if (opts.toolUseId) {
    await setCachedRecommendations(opts.toolUseId, [null], db);
  }
  return { issueId, workspaceId, sessionId };
}

afterEach(() => {
  invalidateAgentQuestionsCache();
});

describe("closed-workspace exclusion", () => {
  it("still surfaces questions from non-closed workspaces while skipping closed ones", async () => {
    const { db } = createTestDb();
    await seed(db, { key: "open-1", toolUseId: "tu-open-1" });
    await seed(db, {
      key: "closed-1",
      toolUseId: "tu-closed-1",
      workspaceStatus: "closed",
      workspaceClosedAt: ts(-10 * 60 * 1000),
    });

    const pending = await listPendingQuestionsForProject(PROJECT_ID, db);
    expect(pending.map((p) => p.toolUseId)).toContain("tu-open-1");
    expect(pending.map((p) => p.toolUseId)).not.toContain("tu-closed-1");
  });
});

describe("readSessionStdoutFileTail", () => {
  const cleanupIds: string[] = [];
  afterEach(() => {
    for (const id of cleanupIds.splice(0)) {
      rmSync(sessionOutputPath(id), { force: true });
    }
  });

  it("returns null for a missing file", () => {
    expect(readSessionStdoutFileTail(`tail-missing-${Date.now()}`)).toBe(null);
  });

  it("returns the whole content when the file fits in maxBytes", () => {
    const id = `tail-small-${Date.now()}`;
    cleanupIds.push(id);
    writeFileSync(sessionOutputPath(id), "line1\nline2\n", "utf-8");
    expect(readSessionStdoutFileTail(id, 1024)).toBe("line1\nline2\n");
  });

  it("returns only complete trailing lines when the file exceeds maxBytes", () => {
    const id = `tail-big-${Date.now()}`;
    cleanupIds.push(id);
    const content = `${"x".repeat(100)}\n${"y".repeat(20)}\nFINAL\n`;
    writeFileSync(sessionOutputPath(id), content, "utf-8");
    const tail = readSessionStdoutFileTail(id, 30);
    expect(tail).toBe(`${"y".repeat(20)}\nFINAL\n`);
  });
});

describe("JSONL .out file extraction", () => {
  const cleanupIds: string[] = [];
  afterEach(() => {
    for (const id of cleanupIds.splice(0)) {
      rmSync(sessionOutputPath(id), { force: true });
    }
  });

  it("surfaces a question from a multi-line .out transcript (line-split parse)", async () => {
    const { db } = createTestDb();
    const key = `outfile-${Date.now()}`;
    const { sessionId } = await seed(db, { key, toolUseId: "tu-outfile-1", withDbQuestion: false });
    cleanupIds.push(sessionId);
    // Multi-line JSONL transcript: the result event with the denial is the LAST
    // line. Passing the whole file as one "line" (the old behavior) can never
    // JSON.parse, so this question used to be invisible.
    const fileContent = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working..." }] } }),
      denialResultLine("tu-outfile-1"),
    ].join("\n") + "\n";
    writeFileSync(sessionOutputPath(sessionId), fileContent, "utf-8");

    const pending = await listPendingQuestionsForProject(PROJECT_ID, db);
    const q = pending.find((p) => p.toolUseId === "tu-outfile-1");
    expect(q).toBeDefined();
    expect(q?.sessionId).toBe(sessionId);
    expect(q?.questions[0]).toMatchObject({ question: "Pick one?" });
  });
});

describe("response cache + invalidation", () => {
  it("serves the cached result until invalidated for the project", async () => {
    const { db } = createTestDb();
    await seed(db, { key: "cache-a", toolUseId: "tu-cache-a" });

    const first = await listPendingQuestionsForProject(PROJECT_ID, db);
    expect(first.map((p) => p.toolUseId)).toContain("tu-cache-a");

    // New question inserted directly into the DB — no invalidation path fires.
    await seed(db, { key: "cache-b", toolUseId: "tu-cache-b" });
    // seed() calls setCachedRecommendations which clears the cache; re-prime it.
    const reprimed = await listPendingQuestionsForProject(PROJECT_ID, db);
    expect(reprimed.map((p) => p.toolUseId)).toContain("tu-cache-b");

    // Insert a third question without ANY invalidation (raw DB writes only).
    await primeRecommendationPref("tu-cache-c", db);
    await db.insert(issues).values({ id: "issue-cache-c", issueNumber: 3, title: "T", statusId: "status-perf", projectId: PROJECT_ID });
    await db.insert(workspaces).values({ id: "ws-cache-c", issueId: "issue-cache-c", branch: "feature/cache-c", status: "active" });
    await db.insert(sessions).values({ id: "sess-cache-c", workspaceId: "ws-cache-c", status: "stopped", startedAt: ts(-60 * 60 * 1000), endedAt: ts(-30 * 60 * 1000) });
    await db.insert(sessionMessages).values({ sessionId: "sess-cache-c", type: "stdout", data: denialResultLine("tu-cache-c") });

    const cachedHit = await listPendingQuestionsForProject(PROJECT_ID, db);
    expect(cachedHit.map((p) => p.toolUseId)).not.toContain("tu-cache-c");
    expect(cachedHit).toBe(reprimed); // same cached array instance

    invalidateAgentQuestionsCache(PROJECT_ID);
    const recomputed = await listPendingQuestionsForProject(PROJECT_ID, db);
    expect(recomputed.map((p) => p.toolUseId)).toContain("tu-cache-c");
  });

  it("markAnswered and markDismissed invalidate the cache", async () => {
    const { db } = createTestDb();
    await seed(db, { key: "inv-a", toolUseId: "tu-inv-a" });
    await seed(db, { key: "inv-b", toolUseId: "tu-inv-b" });

    let pending = await listPendingQuestionsForProject(PROJECT_ID, db);
    expect(pending.map((p) => p.toolUseId)).toEqual(expect.arrayContaining(["tu-inv-a", "tu-inv-b"]));

    await markAnswered("tu-inv-a", db);
    pending = await listPendingQuestionsForProject(PROJECT_ID, db);
    expect(pending.map((p) => p.toolUseId)).not.toContain("tu-inv-a");

    await markDismissed("tu-inv-b", ts(0), db);
    pending = await listPendingQuestionsForProject(PROJECT_ID, db);
    expect(pending.map((p) => p.toolUseId)).not.toContain("tu-inv-b");
  });

  it("does not serve a cache entry computed against a different Database instance", async () => {
    const { db: db1 } = createTestDb();
    await seed(db1, { key: "iso-1", toolUseId: "tu-iso-1" });
    const fromDb1 = await listPendingQuestionsForProject(PROJECT_ID, db1);
    expect(fromDb1.map((p) => p.toolUseId)).toContain("tu-iso-1");

    // Fresh empty DB, same project id: must recompute, not reuse db1's cache.
    const { db: db2 } = createTestDb();
    const fromDb2 = await listPendingQuestionsForProject(PROJECT_ID, db2);
    expect(fromDb2).toEqual([]);
  });

  it("bypasses the cache (read and write) when nowOverride is provided", async () => {
    const { db } = createTestDb();
    await seed(db, { key: "now-a", toolUseId: "tu-now-a" });
    const cachedResult = await listPendingQuestionsForProject(PROJECT_ID, db);
    expect(cachedResult.map((p) => p.toolUseId)).toContain("tu-now-a");

    // Raw DB insert (no invalidation): a nowOverride call must see it (cache read skipped)...
    await primeRecommendationPref("tu-now-b", db);
    await db.insert(issues).values({ id: "issue-now-b", issueNumber: 2, title: "T", statusId: "status-perf", projectId: PROJECT_ID });
    await db.insert(workspaces).values({ id: "ws-now-b", issueId: "issue-now-b", branch: "feature/now-b", status: "active" });
    await db.insert(sessions).values({ id: "sess-now-b", workspaceId: "ws-now-b", status: "stopped", startedAt: ts(-60 * 60 * 1000), endedAt: ts(-30 * 60 * 1000) });
    await db.insert(sessionMessages).values({ sessionId: "sess-now-b", type: "stdout", data: denialResultLine("tu-now-b") });

    const withOverride = await listPendingQuestionsForProject(PROJECT_ID, db, undefined, new Date().toISOString());
    expect(withOverride.map((p) => p.toolUseId)).toContain("tu-now-b");

    // ...and must not have replaced the cached entry (cache write skipped).
    const stillCached = await listPendingQuestionsForProject(PROJECT_ID, db);
    expect(stillCached).toBe(cachedResult);
  });
});
