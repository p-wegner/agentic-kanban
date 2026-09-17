import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { getIssueComments } from "../repositories/issue-comments.repository.js";
import { riskPosturePrefKey } from "../services/risk-posture.service.js";
import { reviewModePref } from "../services/review-mode-pref.js";
import {
  buildTrainReviewProtocol,
  parseTrainReviewVerdict,
  resolveTrainReviewDecision,
  runTrainReview,
  type TrainReviewMember,
} from "../services/merge-train-review.service.js";

/**
 * #1194 — train-scoped review. The pure halves (decision, verdict parsing, attribution) are
 * pinned without a DB; `runTrainReview` is exercised against a real test DB with the agent
 * runner injected, because the claims that matter are WHERE a finding lands (the right
 * ticket's comments) and WHO gets sided (only under a blocking posture).
 */
const PID = "proj-1";
const prefs = (o: Record<string, string> = {}) => new Map(Object.entries(o));

const member = (over: Partial<TrainReviewMember> & { workspaceId: string }): TrainReviewMember => ({
  branch: `feature/${over.workspaceId}`,
  issueId: `issue-${over.workspaceId}`,
  issueNumber: null,
  changedFiles: [],
  ...over,
});

describe("resolveTrainReviewDecision (#1194)", () => {
  it("fast (train-only) reviews the train and sides on a blocking finding", () => {
    const d = resolveTrainReviewDecision(prefs({ [riskPosturePrefKey(PID)]: "fast" }), PID);
    expect(d).toMatchObject({ run: true, blocking: true, thorough: false });
  });

  it("sprint reviews the train but only comments — proposal §4's 'comment instead of a rejection'", () => {
    const d = resolveTrainReviewDecision(prefs({ [riskPosturePrefKey(PID)]: "sprint" }), PID);
    expect(d).toMatchObject({ run: true, blocking: false });
    expect(d.reason).toMatch(/advisory/);
  });

  it("standard reviews per ticket, so the train is not reviewed again", () => {
    const d = resolveTrainReviewDecision(prefs({ [riskPosturePrefKey(PID)]: "standard" }), PID);
    expect(d.run).toBe(false);
    expect(d.reason).toMatch(/per ticket/);
  });

  it("an explicit review_mode=per-train pref turns the train review on under any posture", () => {
    const d = resolveTrainReviewDecision(prefs({ [riskPosturePrefKey(PID)]: "standard", [reviewModePref.key(PID)]: "per-train" }), PID);
    expect(d).toMatchObject({ run: true, blocking: true });
  });
});

describe("parseTrainReviewVerdict (#1194)", () => {
  const w1 = member({ workspaceId: "w1", issueNumber: 11, changedFiles: ["src/a.ts", "src/shared.ts"] });
  const w2 = member({ workspaceId: "w2", issueNumber: 22, changedFiles: ["src/b.ts", "src/shared.ts"] });

  it("attributes by the reviewer's explicit member reference first, then by the file's unique owner", () => {
    const reply = `Looks mostly fine.

\`\`\`json
{
  "summary": "one real bug",
  "findings": [
    { "member": "#22", "severity": "critical", "file": "src/a.ts", "message": "explicit ref wins over the file owner" },
    { "severity": "MAJOR", "file": "./src/b.ts", "message": "no member named — the file says w2" },
    { "member": "feature/w1", "severity": "MINOR", "file": "src/a.ts", "message": "branch name works too" }
  ]
}
\`\`\``;
    const v = parseTrainReviewVerdict(reply, [w1, w2]);
    expect(v.summary).toBe("one real bug");
    expect(v.findings.map((f) => [f.workspaceId, f.severity, f.file])).toEqual([
      ["w2", "CRITICAL", "src/a.ts"],
      ["w2", "MAJOR", "src/b.ts"],
      ["w1", "MINOR", "src/a.ts"],
    ]);
    // w1's only finding is MINOR — not blocking. w2 has two blocking ones, joined into one reason.
    expect(v.blocking.map((b) => b.workspaceId)).toEqual(["w2"]);
    expect(v.blocking[0].reason).toContain("CRITICAL src/a.ts");
    expect(v.blocking[0].reason).toContain("MAJOR src/b.ts");
  });

  it("leaves a finding unattributed when the file belongs to two members and no member is named", () => {
    const v = parseTrainReviewVerdict(
      `{"findings":[{"severity":"MAJOR","file":"src/shared.ts","message":"ambiguous"}]}`,
      [w1, w2],
    );
    expect(v.findings[0].workspaceId).toBeNull();
    expect(v.blocking).toEqual([]);
  });

  it("drops an entry with no recognisable severity and keeps the rest; a clean train is an empty list", () => {
    const v = parseTrainReviewVerdict(
      `{"findings":[{"member":"#11","message":"no severity"},{"member":"#11","severity":"MAJOR","message":"kept"}]}`,
      [w1, w2],
    );
    expect(v.findings).toHaveLength(1);
    expect(v.blocking.map((b) => b.workspaceId)).toEqual(["w1"]);
    expect(parseTrainReviewVerdict(`{"findings":[]}`, [w1, w2])).toMatchObject({ findings: [], blocking: [] });
  });

  it("throws on a reply with no JSON at all — the caller reports a failed review, not a clean one", () => {
    expect(() => parseTrainReviewVerdict("I could not review this.", [w1])).toThrow();
  });

  it("the protocol names every member with its branch so the reviewer can attribute", () => {
    const text = buildTrainReviewProtocol([w1, w2]);
    expect(text).toContain("#11");
    expect(text).toContain("`feature/w2`");
    expect(text).toMatch(/Do NOT edit files/);
  });
});

describe("runTrainReview (#1194)", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => { for (const d of disposers.splice(0)) d(); });

  async function seed(db: TestDb) {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: "P", repoPath: "C:/nope", repoName: "r", defaultBranch: "main", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 0, isDefault: true, createdAt: now });
    const members: TrainReviewMember[] = [];
    for (const n of [1, 2]) {
      const issueId = randomUUID();
      const workspaceId = randomUUID();
      await db.insert(issues).values({ id: issueId, issueNumber: n, title: `Issue ${n}`, description: `AC for ${n}`, priority: "medium", sortOrder: n, statusId, projectId, createdAt: now, updatedAt: now });
      await db.insert(workspaces).values({ id: workspaceId, issueId, branch: `f${n}`, workingDir: null, baseBranch: "main", status: "idle", isDirect: false, provider: "claude", createdAt: now, updatedAt: now });
      members.push({ workspaceId, issueId, issueNumber: n, branch: `f${n}`, changedFiles: [`src/${n}.ts`] });
    }
    return { projectId, members };
  }

  it("blocking: a CRITICAL finding sides its member and lands on THAT ticket; the clean member gets nothing", async () => {
    const { db, dispose } = createTestDb();
    disposers.push(dispose);
    const { projectId, members } = await seed(db);
    const invoke = vi.fn(async (prompt: string, _opts: { cwd: string }) => {
      // The prompt carries the members block AND the diff context the test injected.
      expect(prompt).toContain("Train members (2)");
      expect(prompt).toContain("AC for 2");
      expect(prompt).toContain("INJECTED DIFF");
      return `\`\`\`json\n{"summary":"s","findings":[{"member":"#2","severity":"CRITICAL","file":"src/2.ts","message":"unchecked null"}]}\n\`\`\``;
    });
    const res = await runTrainReview(
      { projectId, trainLabel: "q1", trainRef: "kanban/train/q1", baseBranch: "main", gateWorktree: "C:/nope/wt", repoPath: "C:/nope", members, blocking: true, thorough: false },
      { database: db, invoke, buildContext: async () => "INJECTED DIFF" },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1]).toMatchObject({ cwd: "C:/nope/wt" });
    expect(res.sided.map((s) => s.workspaceId)).toEqual([members[1].workspaceId]);
    expect(res.evidence).toMatchObject({ status: "ran", findingCount: 1, blockingCount: 1, blocking: true, sidedWorkspaceIds: [members[1].workspaceId] });

    const onSided = await getIssueComments(members[1].issueId, db);
    expect(onSided).toHaveLength(1);
    expect(onSided[0].kind).toBe("merge-attempt");
    expect(onSided[0].body).toMatch(/pulled into a siding/);
    expect(onSided[0].body).toContain("unchecked null");
    expect(await getIssueComments(members[0].issueId, db)).toEqual([]);
  });

  it("advisory (sprint): the same finding is a comment only — nobody is sided", async () => {
    const { db, dispose } = createTestDb();
    disposers.push(dispose);
    const { projectId, members } = await seed(db);
    const res = await runTrainReview(
      { projectId, trainLabel: "q2", trainRef: "kanban/train/q2", baseBranch: "main", gateWorktree: "C:/nope/wt", repoPath: "C:/nope", members, blocking: false, thorough: false },
      {
        database: db,
        invoke: async () => `{"findings":[{"member":"#1","severity":"MAJOR","message":"leaky abstraction"}]}`,
        buildContext: async () => null,
      },
    );
    expect(res.sided).toEqual([]);
    expect(res.evidence).toMatchObject({ status: "ran", blockingCount: 1, blocking: false, sidedWorkspaceIds: [] });
    const c = await getIssueComments(members[0].issueId, db);
    expect(c).toHaveLength(1);
    expect(c[0].body).toMatch(/known debt/);
  });

  it("a reviewer that cannot run sides nobody and says so in the evidence", async () => {
    const { db, dispose } = createTestDb();
    disposers.push(dispose);
    const { projectId, members } = await seed(db);
    const res = await runTrainReview(
      { projectId, trainLabel: "q3", trainRef: "kanban/train/q3", baseBranch: "main", gateWorktree: "C:/nope/wt", repoPath: "C:/nope", members, blocking: true, thorough: false },
      { database: db, invoke: async () => { throw new Error("claude.exe timed out after 5ms"); }, buildContext: async () => null },
    );
    expect(res.sided).toEqual([]);
    expect(res.verdict).toBeNull();
    expect(res.evidence).toMatchObject({ status: "failed" });
    expect((res.evidence as { error: string }).error).toContain("timed out");
    expect(await getIssueComments(members[0].issueId, db)).toEqual([]);
  });

  it("reads the posture from the preferences table the way the runner does", async () => {
    // Guards the pref key spelling end to end: the runner resolves the decision from the DB.
    const { db, dispose } = createTestDb();
    disposers.push(dispose);
    const projectId = randomUUID();
    await db.insert(preferences).values({ key: riskPosturePrefKey(projectId), value: "fast" });
    const rows = await db.select().from(preferences);
    const d = resolveTrainReviewDecision(new Map(rows.map((r) => [r.key, r.value ?? ""])), projectId);
    expect(d.run).toBe(true);
  });
});
