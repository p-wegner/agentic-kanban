import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

// Control the two impure externals getWorkspaceRisk reaches: git (changed files)
// and the on-disk session .out reader. Everything else runs against a real
// in-memory libsql DB through the actual repositories.
vi.mock("../services/git.service.js", () => ({
  getChangedFileNames: vi.fn(),
}));
vi.mock("../repositories/session.repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/session.repository.js")>()),
  readSessionStdoutFile: vi.fn(),
}));

import { getWorkspaceRisk } from "../services/workspace-risk.service.js";
import { getChangedFileNames } from "../services/git.service.js";
import { readSessionStdoutFile } from "../repositories/session.repository.js";

const mockGetChangedFileNames = vi.mocked(getChangedFileNames);
const mockReadSessionStdoutFile = vi.mocked(readSessionStdoutFile);

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** One JSONL line that countAskFollowupQuestions counts as a pending question. */
const QUESTION_LINE = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "ask_followup_question" }] },
});

async function seedProject(db: TestDb, opts?: { defaultBranch?: string }) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inProgress = randomUUID();
  const done = randomUUID();
  const cancelled = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: "Test",
    repoPath: "/tmp/repo",
    defaultBranch: opts?.defaultBranch ?? "main",
    createdAt: now,
    updatedAt: now,
  } as any);
  await db.insert(schema.projectStatuses).values([
    { id: inProgress, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: now },
    { id: done, projectId, name: "Done", sortOrder: 2, isDefault: false, createdAt: now },
    { id: cancelled, projectId, name: "Cancelled", sortOrder: 3, isDefault: false, createdAt: now },
  ]);

  return { projectId, statuses: { inProgress, done, cancelled }, now };
}

let issueCounter = 0;
async function seedIssue(
  db: TestDb,
  projectId: string,
  statusId: string,
  opts?: { issueNumber?: number; title?: string },
) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber: opts?.issueNumber ?? ++issueCounter,
    title: opts?.title ?? "Issue",
    issueType: "bug",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  return issueId;
}

async function seedWorkspace(
  db: TestDb,
  issueId: string,
  opts?: {
    status?: string;
    branch?: string;
    workingDir?: string | null;
    baseBranch?: string | null;
    isDirect?: boolean;
    conflictCacheCheckedAt?: string;
    conflictCacheHasConflicts?: boolean;
    conflictCacheFiles?: string;
    diffStatCacheCheckedAt?: string;
    diffStatCacheFilesChanged?: number;
    diffStatCacheInsertions?: number;
    diffStatCacheDeletions?: number;
  },
) {
  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  const branch = opts?.branch ?? `feature/${randomUUID().slice(0, 8)}`;
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch,
    status: opts?.status ?? "active",
    workingDir: opts?.workingDir === undefined ? `/tmp/${branch}` : opts.workingDir,
    baseBranch: opts?.baseBranch === undefined ? "main" : opts.baseBranch,
    isDirect: opts?.isDirect ?? false,
    conflictCacheCheckedAt: opts?.conflictCacheCheckedAt ?? null,
    conflictCacheHasConflicts: opts?.conflictCacheHasConflicts ?? null,
    conflictCacheFiles: opts?.conflictCacheFiles ?? null,
    diffStatCacheCheckedAt: opts?.diffStatCacheCheckedAt ?? null,
    diffStatCacheFilesChanged: opts?.diffStatCacheFilesChanged ?? null,
    diffStatCacheInsertions: opts?.diffStatCacheInsertions ?? null,
    diffStatCacheDeletions: opts?.diffStatCacheDeletions ?? null,
    createdAt: now,
    updatedAt: now,
  } as any);
  return workspaceId;
}

async function seedSession(
  db: TestDb,
  workspaceId: string,
  opts: {
    status?: string;
    startedMsAgo: number;
    endedMsAgo?: number;
    exitCode?: string | null;
    stats?: string | null;
    triggerType?: string | null;
  },
) {
  const sessionId = randomUUID();
  await db.insert(schema.sessions).values({
    id: sessionId,
    workspaceId,
    status: opts.status ?? "stopped",
    startedAt: ago(opts.startedMsAgo),
    endedAt: opts.endedMsAgo === undefined ? null : ago(opts.endedMsAgo),
    exitCode: opts.exitCode ?? null,
    stats: opts.stats ?? null,
    triggerType: opts.triggerType ?? null,
  } as any);
  return sessionId;
}

async function seedSessionMessage(db: TestDb, sessionId: string, data: string) {
  await db.insert(schema.sessionMessages).values({ sessionId, type: "stdout", data } as any);
}

describe("getWorkspaceRisk (orchestration)", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
    mockGetChangedFileNames.mockReset();
    mockGetChangedFileNames.mockResolvedValue([]);
    mockReadSessionStdoutFile.mockReset();
    mockReadSessionStdoutFile.mockReturnValue(undefined as any);
  });

  it("throws NotFoundError when the project does not exist", async () => {
    await expect(getWorkspaceRisk(randomUUID(), db)).rejects.toThrow(/Project .* not found/);
  });

  it("returns an empty response shape with the projectId and a generatedAt string", async () => {
    const { projectId } = await seedProject(db);
    const res = await getWorkspaceRisk(projectId, db);
    expect(res.projectId).toBe(projectId);
    expect(typeof res.generatedAt).toBe("string");
    expect(res.entries).toEqual([]);
  });

  it("excludes issues in terminal (Done/Cancelled) statuses", async () => {
    const { projectId, statuses } = await seedProject(db);
    const doneIssue = await seedIssue(db, projectId, statuses.done);
    const cancelledIssue = await seedIssue(db, projectId, statuses.cancelled);
    await seedWorkspace(db, doneIssue, { status: "active" });
    await seedWorkspace(db, cancelledIssue, { status: "active" });

    const res = await getWorkspaceRisk(projectId, db);
    expect(res.entries).toEqual([]);
  });

  it("excludes closed workspaces (only active/reviewing/fixing/idle are scored)", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    await seedWorkspace(db, issue, { status: "closed" });

    const res = await getWorkspaceRisk(projectId, db);
    expect(res.entries).toEqual([]);
  });

  it("builds a clean entry (no signals) for an idle workspace with no sessions", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress, { issueNumber: 42, title: "Fix the thing" });
    const wsId = await seedWorkspace(db, issue, { status: "idle", branch: "feature/clean" });

    const res = await getWorkspaceRisk(projectId, db);
    expect(res.entries).toHaveLength(1);
    const e = res.entries[0];
    expect(e.workspaceId).toBe(wsId);
    expect(e.issueId).toBe(issue);
    expect(e.issueNumber).toBe(42);
    expect(e.issueTitle).toBe("Fix the thing");
    expect(e.issueStatusName).toBe("In Progress");
    expect(e.branch).toBe("feature/clean");
    expect(e.workspaceStatus).toBe("idle");
    expect(e.riskLevel).toBe("none");
    expect(e.riskScore).toBe(0);
    expect(e.signals).toEqual([]);
    expect(e.changedFiles).toEqual([]);
    // idle workspaces are NOT git-queried
    expect(mockGetChangedFileNames).not.toHaveBeenCalled();
  });

  it("parses cached conflicts into a high-severity conflicts signal", async () => {
    const { projectId, statuses, now } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    await seedWorkspace(db, issue, {
      status: "idle",
      conflictCacheCheckedAt: now,
      conflictCacheHasConflicts: true,
      conflictCacheFiles: JSON.stringify(["src/a.ts", "src/b.ts"]),
    });

    const res = await getWorkspaceRisk(projectId, db);
    const conflict = res.entries[0].signals.find((s) => s.key === "conflicts");
    expect(conflict).toBeDefined();
    expect(conflict?.severity).toBe("high");
    expect(conflict?.value).toBe(2);
    expect(res.entries[0].riskScore).toBe(4);
  });

  it("treats malformed conflictCacheFiles JSON as zero conflicting files (still flagged)", async () => {
    const { projectId, statuses, now } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    await seedWorkspace(db, issue, {
      status: "idle",
      conflictCacheCheckedAt: now,
      conflictCacheHasConflicts: true,
      conflictCacheFiles: "{not json",
    });

    const res = await getWorkspaceRisk(projectId, db);
    const conflict = res.entries[0].signals.find((s) => s.key === "conflicts");
    expect(conflict).toBeDefined();
    expect(conflict?.value).toBe(0);
    expect(res.entries[0].riskScore).toBe(4);
  });

  it("parses cached diff-stats into an uncommitted-changes signal", async () => {
    const { projectId, statuses, now } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    await seedWorkspace(db, issue, {
      status: "idle",
      diffStatCacheCheckedAt: now,
      diffStatCacheFilesChanged: 8,
      diffStatCacheInsertions: 50,
      diffStatCacheDeletions: 20,
    });

    const res = await getWorkspaceRisk(projectId, db);
    const uncommitted = res.entries[0].signals.find((s) => s.key === "uncommitted");
    expect(uncommitted).toBeDefined();
    expect(uncommitted?.severity).toBe("medium");
    expect(uncommitted?.value).toBe(8);
  });

  it("counts a stopped non-zero-exit session as a launch failure", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    const wsId = await seedWorkspace(db, issue, { status: "idle" });
    // stopped, real token output, exitCode 1 -> session-error failure (not zero-output)
    await seedSession(db, wsId, {
      status: "stopped",
      startedMsAgo: 30 * MIN,
      endedMsAgo: 25 * MIN,
      exitCode: "1",
      stats: JSON.stringify({ inputTokens: 100, outputTokens: 50 }),
    });

    const res = await getWorkspaceRisk(projectId, db);
    const failures = res.entries[0].signals.find((s) => s.key === "failures");
    expect(failures).toBeDefined();
    expect(failures?.value).toBe(1);
    expect(failures?.severity).toBe("medium");
  });

  it("counts a sub-second session as a zero-output failure", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    const wsId = await seedWorkspace(db, issue, { status: "idle" });
    await seedSession(db, wsId, {
      status: "stopped",
      startedMsAgo: 30 * MIN,
      endedMsAgo: 30 * MIN - 500, // 500ms duration
      exitCode: "0",
      stats: JSON.stringify({ inputTokens: 1000, outputTokens: 200 }),
    });

    const res = await getWorkspaceRisk(projectId, db);
    expect(res.entries[0].signals.find((s) => s.key === "failures")?.value).toBe(1);
  });

  it("counts a stopped session with null stats as a zero-output failure even past 1s", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    const wsId = await seedWorkspace(db, issue, { status: "idle" });
    await seedSession(db, wsId, {
      status: "stopped",
      startedMsAgo: 30 * MIN,
      endedMsAgo: 25 * MIN, // 5 min duration
      exitCode: "0",
      stats: null,
    });

    const res = await getWorkspaceRisk(projectId, db);
    expect(res.entries[0].signals.find((s) => s.key === "failures")?.value).toBe(1);
  });

  it("does NOT count a healthy completed session (real tokens, exit 0, >1s) as a failure", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    const wsId = await seedWorkspace(db, issue, { status: "idle" });
    await seedSession(db, wsId, {
      status: "stopped",
      startedMsAgo: 30 * MIN,
      endedMsAgo: 25 * MIN,
      exitCode: "0",
      stats: JSON.stringify({ inputTokens: 1000, outputTokens: 200 }),
    });

    const res = await getWorkspaceRisk(projectId, db);
    expect(res.entries[0].signals.find((s) => s.key === "failures")).toBeUndefined();
    expect(res.entries[0].riskScore).toBe(0);
  });

  it("flags 3+ failures as high severity", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    const wsId = await seedWorkspace(db, issue, { status: "idle" });
    for (let i = 0; i < 3; i++) {
      await seedSession(db, wsId, {
        status: "stopped",
        startedMsAgo: (40 - i) * MIN,
        endedMsAgo: (40 - i) * MIN - 200,
        exitCode: "0",
        stats: JSON.stringify({ inputTokens: 5, outputTokens: 5 }),
      });
    }
    const res = await getWorkspaceRisk(projectId, db);
    const failures = res.entries[0].signals.find((s) => s.key === "failures");
    expect(failures?.value).toBe(3);
    expect(failures?.severity).toBe("high");
  });

  it("skips analytics-noise sessions (skill:board-monitor) in failure counting", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    const wsId = await seedWorkspace(db, issue, { status: "idle" });
    // would be a failure, but is noise -> excluded
    await seedSession(db, wsId, {
      status: "stopped",
      startedMsAgo: 30 * MIN,
      endedMsAgo: 25 * MIN,
      exitCode: "1",
      stats: null,
      triggerType: "skill:board-monitor",
    });

    const res = await getWorkspaceRisk(projectId, db);
    expect(res.entries[0].signals.find((s) => s.key === "failures")).toBeUndefined();
  });

  it("counts pending questions from the DB fallback when no .out file exists", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    const wsId = await seedWorkspace(db, issue, { status: "active" });
    const sessionId = await seedSession(db, wsId, { status: "running", startedMsAgo: 10 * MIN });
    await seedSessionMessage(db, sessionId, QUESTION_LINE);
    // readSessionStdoutFile returns undefined by default -> DB fallback

    const res = await getWorkspaceRisk(projectId, db);
    const questions = res.entries[0].signals.find((s) => s.key === "questions");
    expect(questions).toBeDefined();
    expect(questions?.value).toBe(1);
    expect(questions?.severity).toBe("high");
  });

  it("prefers the .out file over the DB for pending-question counting", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    const wsId = await seedWorkspace(db, issue, { status: "active" });
    const sessionId = await seedSession(db, wsId, { status: "running", startedMsAgo: 10 * MIN });
    // DB has ONE question, the .out file reports TWO -> the file wins, DB ignored for this session
    await seedSessionMessage(db, sessionId, QUESTION_LINE);
    mockReadSessionStdoutFile.mockImplementation((sid: string) =>
      (sid === sessionId ? `${QUESTION_LINE}\n${QUESTION_LINE}` : undefined) as any,
    );

    const res = await getWorkspaceRisk(projectId, db);
    expect(res.entries[0].signals.find((s) => s.key === "questions")?.value).toBe(2);
  });

  it("does not count pending questions for non-running latest sessions", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    const wsId = await seedWorkspace(db, issue, { status: "active" });
    const sessionId = await seedSession(db, wsId, {
      status: "stopped",
      startedMsAgo: 30 * MIN,
      endedMsAgo: 25 * MIN,
      exitCode: "0",
      stats: JSON.stringify({ inputTokens: 5, outputTokens: 5 }),
    });
    await seedSessionMessage(db, sessionId, QUESTION_LINE);

    const res = await getWorkspaceRisk(projectId, db);
    expect(res.entries[0].signals.find((s) => s.key === "questions")).toBeUndefined();
  });

  it("computes changed-file overlap across active workspaces from git", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issueA = await seedIssue(db, projectId, statuses.inProgress);
    const issueB = await seedIssue(db, projectId, statuses.inProgress);
    await seedWorkspace(db, issueA, { status: "active", workingDir: "/tmp/wsA" });
    await seedWorkspace(db, issueB, { status: "active", workingDir: "/tmp/wsB" });
    mockGetChangedFileNames.mockImplementation(async (workingDir: string) =>
      workingDir === "/tmp/wsA" ? ["src/shared.ts", "src/a.ts"] : ["src/shared.ts", "src/b.ts"],
    );

    const res = await getWorkspaceRisk(projectId, db);
    for (const e of res.entries) {
      const overlap = e.signals.find((s) => s.key === "overlap");
      expect(overlap).toBeDefined();
      expect(overlap?.severity).toBe("low");
      expect(overlap?.value).toBe(1);
      expect(e.changedFiles).toContain("src/shared.ts");
    }
  });

  it("tolerates a git failure for one workspace without crashing", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    await seedWorkspace(db, issue, { status: "active", workingDir: "/tmp/broken" });
    mockGetChangedFileNames.mockRejectedValue(new Error("git exploded"));

    const res = await getWorkspaceRisk(projectId, db);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].changedFiles).toEqual([]);
    expect(res.entries[0].signals.find((s) => s.key === "overlap")).toBeUndefined();
  });

  it("diffs a non-direct workspace against its base branch, falling back to the default branch", async () => {
    const { projectId, statuses } = await seedProject(db, { defaultBranch: "develop" });
    const issueA = await seedIssue(db, projectId, statuses.inProgress);
    await seedWorkspace(db, issueA, { status: "active", workingDir: "/tmp/wsBase", baseBranch: "release/1" });
    const issueB = await seedIssue(db, projectId, statuses.inProgress);
    await seedWorkspace(db, issueB, { status: "active", workingDir: "/tmp/wsDefault", baseBranch: null });

    await getWorkspaceRisk(projectId, db);

    const refByDir = new Map(mockGetChangedFileNames.mock.calls.map((c) => [c[0], c[1]]));
    expect(refByDir.get("/tmp/wsBase")).toBe("release/1");
    expect(refByDir.get("/tmp/wsDefault")).toBe("develop"); // null baseBranch -> project default branch
  });

  it("diffs a direct workspace against HEAD", async () => {
    const { projectId, statuses } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    await seedWorkspace(db, issue, { status: "active", workingDir: "/tmp/wsDirect", isDirect: true });

    await getWorkspaceRisk(projectId, db);

    const call = mockGetChangedFileNames.mock.calls.find((c) => c[0] === "/tmp/wsDirect");
    expect(call?.[1]).toBe("HEAD");
  });

  it("falls back to an empty changed-file list from the diff-stat cache when git yields nothing", async () => {
    const { projectId, statuses, now } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statuses.inProgress);
    await seedWorkspace(db, issue, {
      status: "active",
      workingDir: "/tmp/wsCache",
      diffStatCacheCheckedAt: now,
      diffStatCacheFilesChanged: 6,
    });
    mockGetChangedFileNames.mockRejectedValue(new Error("git down"));

    const res = await getWorkspaceRisk(projectId, db);
    expect(res.entries[0].changedFiles).toEqual([]);
    // the cached diff-stat still drives the uncommitted signal even without filenames
    expect(res.entries[0].signals.find((s) => s.key === "uncommitted")?.value).toBe(6);
  });

  it("uses startedAt for a running session's staleness and endedAt for a stopped one", async () => {
    const { projectId, statuses } = await seedProject(db);
    // running session started 5h ago -> stale (uses startedAt)
    const runIssue = await seedIssue(db, projectId, statuses.inProgress);
    const runWs = await seedWorkspace(db, runIssue, { status: "active", workingDir: null });
    await seedSession(db, runWs, { status: "running", startedMsAgo: 5 * HOUR });
    // stopped session started 5h ago but ENDED 30m ago -> not stale (uses endedAt)
    const stopIssue = await seedIssue(db, projectId, statuses.inProgress);
    const stopWs = await seedWorkspace(db, stopIssue, { status: "idle" });
    await seedSession(db, stopWs, {
      status: "stopped",
      startedMsAgo: 5 * HOUR,
      endedMsAgo: 30 * MIN,
      exitCode: "0",
      stats: JSON.stringify({ inputTokens: 5, outputTokens: 5 }),
    });

    const res = await getWorkspaceRisk(projectId, db);
    const runEntry = res.entries.find((e) => e.workspaceId === runWs)!;
    const stopEntry = res.entries.find((e) => e.workspaceId === stopWs)!;
    expect(runEntry.signals.find((s) => s.key === "age")?.severity).toBe("high");
    expect(stopEntry.signals.find((s) => s.key === "age")).toBeUndefined();
  });

  it("sorts entries by risk score descending, then issue number ascending", async () => {
    const { projectId, statuses } = await seedProject(db);
    // high-risk workspace: conflicts (score 4)
    const hi = await seedIssue(db, projectId, statuses.inProgress, { issueNumber: 10 });
    await seedWorkspace(db, hi, {
      status: "idle",
      conflictCacheCheckedAt: new Date().toISOString(),
      conflictCacheHasConflicts: true,
      conflictCacheFiles: JSON.stringify(["x.ts"]),
    });
    // two zero-score workspaces, issue numbers 5 and 7 -> ascending tie-break
    const lo1 = await seedIssue(db, projectId, statuses.inProgress, { issueNumber: 7 });
    const lo1Ws = await seedWorkspace(db, lo1, { status: "idle" });
    const lo2 = await seedIssue(db, projectId, statuses.inProgress, { issueNumber: 5 });
    const lo2Ws = await seedWorkspace(db, lo2, { status: "idle" });

    const res = await getWorkspaceRisk(projectId, db);
    expect(res.entries).toHaveLength(3);
    expect(res.entries[0].issueNumber).toBe(10); // highest score first
    expect(res.entries[0].riskScore).toBe(4);
    // tie at score 0 -> issue 5 before issue 7
    expect(res.entries[1].workspaceId).toBe(lo2Ws);
    expect(res.entries[2].workspaceId).toBe(lo1Ws);
  });
});
