import { describe, it, expect } from "vitest";
import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  insertIssueComment,
  getIssueComments,
} from "../repositories/issue-comments.repository.js";
import { createIssueCommentsService } from "../services/issue-comments.service.js";
import { writeAgentQuestionComment, formatAnswerMessage } from "../services/agent-questions.service.js";
import { formatClarificationsBlock, type PreflightClarification } from "../services/ticket-preflight.service.js";

type Db = ReturnType<typeof createTestDb>["db"];

async function seedIssue(db: Db, opts?: { withWorkspace?: boolean }) {
  const projectId = "proj-1";
  const statusId = "status-1";
  const issueId = "issue-1";
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/tmp/p" }).onConflictDoNothing();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 1 }).onConflictDoNothing();
  await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "T", statusId, projectId });
  let workspaceId: string | undefined;
  if (opts?.withWorkspace) {
    workspaceId = "ws-1";
    await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/x", status: "active" });
  }
  return { projectId, statusId, issueId, workspaceId };
}

describe("issue-comments repository", () => {
  it("inserts and lists comments ordered by createdAt with parsed payload", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedIssue(db);

    await insertIssueComment(
      { issueId, kind: "note", author: "user", body: "first", createdAt: "2026-01-01T00:00:00.000Z" },
      db,
    );
    await insertIssueComment(
      {
        issueId,
        kind: "preflight-clarification",
        author: "preflight",
        body: "second",
        payload: { clarifications: [{ question: "Q?", answer: "A." }] },
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      db,
    );

    const rows = await getIssueComments(issueId, db);
    expect(rows.map((r) => r.body)).toEqual(["first", "second"]);
    expect(rows[0].payload).toBeNull();
    expect(rows[1].payload).toContain("Q?");
  });
});

describe("issue-comments service", () => {
  it("addComment round-trips and listComments parses payload to an object", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedIssue(db);
    const svc = createIssueCommentsService({ database: db });

    await svc.addComment({
      issueId,
      kind: "agent-question",
      author: "user",
      body: "answered",
      payload: { toolUseId: "tu-1" },
    });

    const list = await svc.listComments(issueId);
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe("agent-question");
    expect(list[0].author).toBe("user");
    expect(list[0].payload).toEqual({ toolUseId: "tu-1" });
  });
});

describe("agent-question convergence", () => {
  it("writeAgentQuestionComment persists a durable agent-question comment resolved from the workspace", async () => {
    const { db } = createTestDb();
    const { issueId, workspaceId } = await seedIssue(db, { withWorkspace: true });

    const questions = [{ question: "Pick one?", options: [{ label: "A" }, { label: "B" }] }];
    const answers = [{ selectedLabels: ["A"] }];
    const body = formatAnswerMessage(questions, answers);

    await writeAgentQuestionComment(
      { toolUseId: "tu-9", workspaceId: workspaceId!, questions, answers, body, author: "user" },
      db,
    );

    const rows = await getIssueComments(issueId, db);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("agent-question");
    expect(rows[0].workspaceId).toBe(workspaceId);
    expect(rows[0].body).toContain("Pick one?");
    const payload = JSON.parse(rows[0].payload!);
    expect(payload.toolUseId).toBe("tu-9");
    expect(payload.answers).toEqual(answers);
  });

  it("writeAgentQuestionComment is a no-op (no throw) when the workspace is unknown", async () => {
    const { db } = createTestDb();
    await seedIssue(db);
    await expect(
      writeAgentQuestionComment(
        { toolUseId: "tu-x", workspaceId: "missing", questions: [], answers: [], body: "x", author: "butler" },
        db,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("preflight clarifications block", () => {
  it("renders answered Q&A as a markdown block, skipping the header only when present", () => {
    const clarifications: PreflightClarification[] = [
      { question: "Which DB?", answer: "SQLite" },
      { question: "Auth?", answer: "Local only" },
    ];
    const block = formatClarificationsBlock(clarifications);
    expect(block).toContain("## Clarifications from preflight");
    expect(block).toContain("**Q:** Which DB?");
    expect(block).toContain("**A:** SQLite");
    expect(block).toContain("**Q:** Auth?");
    expect(block).toContain("**A:** Local only");
  });
});
