import { describe, it, expect } from "vitest";
import {
  extractJsonArray,
  coerceRecommendation,
  computeStaleness,
  markDismissed,
  markAnswered,
  isAnswered,
  listPendingQuestionsForProject,
  tryAutoAnswer,
  type StalenessInput,
  type AgentQuestion,
  type AgentQuestionRecommendation,
} from "../services/agent-questions.service.js";
import { createTestDb } from "./helpers/test-db.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import {
  projects,
  projectStatuses,
  issues,
  workspaces,
  sessions,
  sessionMessages,
} from "@agentic-kanban/shared/schema";

const HOUR = 60 * 60 * 1000;
const NOW = "2026-05-28T12:00:00.000Z";

function freshInput(over: Partial<StalenessInput> = {}): StalenessInput {
  return {
    workspaceStatus: "active",
    workspaceClosedAt: null,
    readyForMerge: false,
    issueStatusName: "In Progress",
    questionSessionStartedAt: "2026-05-28T11:00:00.000Z",
    latestSessionStartedAt: "2026-05-28T11:00:00.000Z",
    askedAt: "2026-05-28T11:30:00.000Z",
    now: NOW,
    ...over,
  };
}

describe("extractJsonArray", () => {
  it("parses a plain JSON array", () => {
    const r = extractJsonArray('[{"recommendedOptionIndexes":[0],"rationale":"x"}]');
    expect(Array.isArray(r)).toBe(true);
  });

  it("strips ```json fences", () => {
    const r = extractJsonArray('```json\n[{"a":1}]\n```');
    expect(r).toEqual([{ a: 1 }]);
  });

  it("strips bare ``` fences", () => {
    const r = extractJsonArray('```\n[1,2,3]\n```');
    expect(r).toEqual([1, 2, 3]);
  });

  it("tolerates leading prose", () => {
    const r = extractJsonArray('Sure! Here you go: [{"x":1}] cheers');
    expect(r).toEqual([{ x: 1 }]);
  });

  it("throws on empty input", () => {
    expect(() => extractJsonArray("")).toThrow();
  });

  it("throws when no array is present", () => {
    expect(() => extractJsonArray("nope, no JSON here")).toThrow();
  });
});

describe("coerceRecommendation", () => {
  it("returns null for non-objects", () => {
    expect(coerceRecommendation(null, 3, false)).toBe(null);
    expect(coerceRecommendation("string", 3, false)).toBe(null);
  });

  it("clamps single-select to one index", () => {
    const r = coerceRecommendation(
      { recommendedOptionIndexes: [0, 1], rationale: "pick first" },
      3,
      false,
    );
    expect(r?.recommendedOptionIndexes).toEqual([0]);
  });

  it("keeps multiple indexes for multi-select", () => {
    const r = coerceRecommendation(
      { recommendedOptionIndexes: [0, 2], rationale: "both" },
      3,
      true,
    );
    expect(r?.recommendedOptionIndexes).toEqual([0, 2]);
  });

  it("filters out-of-range indexes", () => {
    const r = coerceRecommendation(
      { recommendedOptionIndexes: [0, 5, -1, 2], rationale: "x" },
      3,
      true,
    );
    expect(r?.recommendedOptionIndexes).toEqual([0, 2]);
  });

  it("accepts freeText alone", () => {
    const r = coerceRecommendation(
      { recommendedOptionIndexes: [], freeText: "something else", rationale: "no fit" },
      3,
      false,
    );
    expect(r?.recommendedOptionIndexes).toEqual([]);
    expect(r?.freeText).toBe("something else");
  });

  it("truncates very long rationales", () => {
    const long = "x".repeat(500);
    const r = coerceRecommendation(
      { recommendedOptionIndexes: [0], rationale: long },
      2,
      false,
    );
    expect((r?.rationale.length ?? 0)).toBeLessThanOrEqual(240);
  });

  it("returns null when there's nothing usable", () => {
    expect(coerceRecommendation({ recommendedOptionIndexes: [99] }, 2, false)).toBe(null);
  });
});

describe("computeStaleness", () => {
  it("returns null for a fresh question", () => {
    expect(computeStaleness(freshInput())).toBe(null);
  });

  it("flags a closed workspace as merged", () => {
    const s = computeStaleness(freshInput({ workspaceStatus: "closed", workspaceClosedAt: "2026-05-28T11:45:00.000Z" }));
    expect(s?.reason).toBe("workspace-merged");
    expect(s?.label).toBe("stale — workspace merged");
    expect(s?.at).toBe("2026-05-28T11:45:00.000Z");
  });

  it("flags readyForMerge + closedAt as merged even when status is not closed", () => {
    const s = computeStaleness(freshInput({ readyForMerge: true, workspaceClosedAt: "2026-05-28T11:45:00.000Z" }));
    expect(s?.reason).toBe("workspace-merged");
  });

  it("flags an issue in a terminal status as issue-done", () => {
    expect(computeStaleness(freshInput({ issueStatusName: "Done" }))?.reason).toBe("issue-done");
    expect(computeStaleness(freshInput({ issueStatusName: "Cancelled" }))?.reason).toBe("issue-done");
  });

  it("flags a question superseded by a newer session", () => {
    const s = computeStaleness(freshInput({
      questionSessionStartedAt: "2026-05-28T10:00:00.000Z",
      latestSessionStartedAt: "2026-05-28T11:00:00.000Z",
    }));
    expect(s?.reason).toBe("superseded");
    expect(s?.at).toBe("2026-05-28T11:00:00.000Z");
  });

  it("does not flag superseded when the question is in the latest session", () => {
    expect(computeStaleness(freshInput({
      questionSessionStartedAt: "2026-05-28T11:00:00.000Z",
      latestSessionStartedAt: "2026-05-28T11:00:00.000Z",
    }))).toBe(null);
  });

  it("flags a question older than 24h as a time-based fallback", () => {
    const s = computeStaleness(freshInput({ askedAt: new Date(new Date(NOW).getTime() - 25 * HOUR).toISOString() }));
    expect(s?.reason).toBe("older-than-24h");
  });

  it("keeps a question under 24h fresh", () => {
    const s = computeStaleness(freshInput({ askedAt: new Date(new Date(NOW).getTime() - 23 * HOUR).toISOString() }));
    expect(s).toBe(null);
  });

  it("prioritizes workspace-merged over issue-done and superseded", () => {
    const s = computeStaleness(freshInput({
      workspaceStatus: "closed",
      workspaceClosedAt: "2026-05-28T11:45:00.000Z",
      issueStatusName: "Done",
      questionSessionStartedAt: "2026-05-28T10:00:00.000Z",
      latestSessionStartedAt: "2026-05-28T11:00:00.000Z",
    }));
    expect(s?.reason).toBe("workspace-merged");
  });
});

describe("markDismissed / isAnswered", () => {
  it("dismiss stores { dismissed: true, dismissedAt } and counts as resolved", async () => {
    const { db } = createTestDb();
    expect(await isAnswered("tu-1", db)).toBe(false);
    await markDismissed("tu-1", "2026-05-28T11:45:00.000Z", db);
    expect(await isAnswered("tu-1", db)).toBe(true);
    const raw = await getPreference("agent_question_answered_tu-1", db);
    expect(JSON.parse(raw!)).toEqual({ dismissed: true, dismissedAt: "2026-05-28T11:45:00.000Z" });
  });

  it("answered (legacy '1') also counts as resolved", async () => {
    const { db } = createTestDb();
    await markAnswered("tu-2", db);
    expect(await isAnswered("tu-2", db)).toBe(true);
    expect(await getPreference("agent_question_answered_tu-2", db)).toBe("1");
  });
});

describe("listPendingQuestionsForProject — dismiss + staleness integration", () => {
  /** Seed a project with one issue/workspace/session that denied an AskUserQuestion. */
  async function seed(db: ReturnType<typeof createTestDb>["db"], opts: {
    toolUseId: string;
    workspaceStatus?: string;
    workspaceClosedAt?: string | null;
    statusName?: string;
    sessionStartedAt?: string;
    sessionEndedAt?: string;
  }) {
    const projectId = "proj-1";
    const statusId = `status-${opts.statusName ?? "InProgress"}`;
    await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/tmp/p" }).onConflictDoNothing();
    await db.insert(projectStatuses).values({ id: statusId, projectId, name: opts.statusName ?? "In Progress", sortOrder: 1 }).onConflictDoNothing();
    const issueId = `issue-${opts.toolUseId}`;
    await db.insert(issues).values({ id: issueId, issueNumber: 7, title: "T", statusId, projectId });
    const workspaceId = `ws-${opts.toolUseId}`;
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/x",
      status: opts.workspaceStatus ?? "active",
      closedAt: opts.workspaceClosedAt ?? null,
    });
    const sessionId = `sess-${opts.toolUseId}`;
    await db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      status: "stopped",
      startedAt: opts.sessionStartedAt ?? "2026-05-28T11:00:00.000Z",
      endedAt: opts.sessionEndedAt ?? "2026-05-28T11:30:00.000Z",
    });
    const resultLine = JSON.stringify({
      type: "result",
      permission_denials: [{
        tool_name: "AskUserQuestion",
        tool_use_id: opts.toolUseId,
        tool_input: { questions: [{ question: "Pick one?", options: [{ label: "A" }, { label: "B" }] }] },
      }],
    });
    await db.insert(sessionMessages).values({ sessionId, type: "stdout", data: resultLine });
    return { projectId, workspaceId, issueId, sessionId };
  }

  it("lists a pending question and hides it once dismissed", async () => {
    const { db } = createTestDb();
    const { projectId } = await seed(db, { toolUseId: "tu-a" });

    let pending = await listPendingQuestionsForProject(projectId, db);
    expect(pending.map((p) => p.toolUseId)).toContain("tu-a");
    expect(pending.find((p) => p.toolUseId === "tu-a")?.staleness).toBe(null);

    await markDismissed("tu-a", "2026-05-28T11:45:00.000Z", db);
    pending = await listPendingQuestionsForProject(projectId, db);
    expect(pending.map((p) => p.toolUseId)).not.toContain("tu-a");
  });

  it("computes a workspace-merged staleness badge for a closed workspace", async () => {
    const { db } = createTestDb();
    const { projectId } = await seed(db, {
      toolUseId: "tu-b",
      workspaceStatus: "closed",
      workspaceClosedAt: "2026-05-28T11:45:00.000Z",
    });
    const pending = await listPendingQuestionsForProject(projectId, db);
    expect(pending.find((p) => p.toolUseId === "tu-b")?.staleness?.reason).toBe("workspace-merged");
  });

  it("computes an issue-done staleness badge when the issue is in a terminal status", async () => {
    const { db } = createTestDb();
    const { projectId } = await seed(db, { toolUseId: "tu-c", statusName: "Done" });
    const pending = await listPendingQuestionsForProject(projectId, db);
    expect(pending.find((p) => p.toolUseId === "tu-c")?.staleness?.reason).toBe("issue-done");
  });

  it("computes a superseded staleness badge when a newer session has run", async () => {
    const { db } = createTestDb();
    const { projectId, workspaceId } = await seed(db, {
      toolUseId: "tu-d",
      sessionStartedAt: "2026-05-28T10:00:00.000Z",
      sessionEndedAt: "2026-05-28T10:30:00.000Z",
    });
    // A newer session, no question — supersedes the older question-bearing one.
    await db.insert(sessions).values({
      id: "sess-newer",
      workspaceId,
      status: "stopped",
      startedAt: "2026-05-28T11:00:00.000Z",
      endedAt: "2026-05-28T11:30:00.000Z",
    });
    const pending = await listPendingQuestionsForProject(projectId, db);
    expect(pending.find((p) => p.toolUseId === "tu-d")?.staleness?.reason).toBe("superseded");
  });
});

describe("tryAutoAnswer", () => {
  const questions: AgentQuestion[] = [
    { question: "Which approach?", options: [{ label: "A" }, { label: "B" }, { label: "C" }], multiSelect: false },
  ];
  const goodRecs: AgentQuestionRecommendation[] = [
    { recommendedOptionIndexes: [1], rationale: "B is better" },
  ];

  it("does NOT auto-answer when butler_auto_answer pref is off (default)", async () => {
    const { db } = createTestDb();
    const sent: string[] = [];
    await tryAutoAnswer("tu-aa1", "ws-1", questions, goodRecs, async (_, c) => { sent.push(c); }, db);
    expect(sent).toHaveLength(0);
    expect(await isAnswered("tu-aa1", db)).toBe(false);
  });

  it("auto-answers when pref is on and all recs are non-null", async () => {
    const { db } = createTestDb();
    await setPreference("butler_auto_answer", "true", db);
    const sent: string[] = [];
    await tryAutoAnswer("tu-aa2", "ws-2", questions, goodRecs, async (_, c) => { sent.push(c); }, db);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("B");
    expect(await isAnswered("tu-aa2", db)).toBe(true);
  });

  it("skips auto-answer when any recommendation is null", async () => {
    const { db } = createTestDb();
    await setPreference("butler_auto_answer", "true", db);
    const sent: string[] = [];
    const partialRecs = [null] as Array<AgentQuestionRecommendation | null>;
    await tryAutoAnswer("tu-aa3", "ws-3", questions, partialRecs, async (_, c) => { sent.push(c); }, db);
    expect(sent).toHaveLength(0);
    expect(await isAnswered("tu-aa3", db)).toBe(false);
  });

  it("skips auto-answer for single-select with empty recommendedOptionIndexes and no freeText", async () => {
    const { db } = createTestDb();
    await setPreference("butler_auto_answer", "true", db);
    const sent: string[] = [];
    const noWinnerRecs: AgentQuestionRecommendation[] = [{ recommendedOptionIndexes: [], rationale: "unclear" }];
    await tryAutoAnswer("tu-aa4", "ws-4", questions, noWinnerRecs, async (_, c) => { sent.push(c); }, db);
    expect(sent).toHaveLength(0);
    expect(await isAnswered("tu-aa4", db)).toBe(false);
  });

  it("auto-answers with freeText when no option selected but freeText provided", async () => {
    const { db } = createTestDb();
    await setPreference("butler_auto_answer", "true", db);
    const sent: string[] = [];
    const freeTextRecs: AgentQuestionRecommendation[] = [{ recommendedOptionIndexes: [], freeText: "custom reply", rationale: "none fit" }];
    await tryAutoAnswer("tu-aa5", "ws-5", questions, freeTextRecs, async (_, c) => { sent.push(c); }, db);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("custom reply");
    expect(await isAnswered("tu-aa5", db)).toBe(true);
  });

  it("does not mark answered when sendTurn throws", async () => {
    const { db } = createTestDb();
    await setPreference("butler_auto_answer", "true", db);
    await tryAutoAnswer("tu-aa6", "ws-6", questions, goodRecs, async () => { throw new Error("network error"); }, db);
    expect(await isAnswered("tu-aa6", db)).toBe(false);
  });
});
