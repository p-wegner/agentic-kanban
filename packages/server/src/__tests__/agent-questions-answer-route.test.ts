// @covers agentQuestions.answer.deadWorkspace [api, error, boundary]
//
// Answering a pending question sends a follow-up turn to the workspace that asked
// it. When that workspace is closed (the common case for a `clarify_or_propose` ask — the
// agent exits seconds after asking and its direct workspace is closed with workingDir
// null), the turn used to fail deep inside the session manager with "Workspace has no
// working directory; run setup first". That reads like a setup step the user could take;
// in reality the agent is gone and the only way out is to dismiss. The route now refuses
// up front with 409 + `canDismiss`, which is what the card renders a Dismiss button from.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createAgentQuestionsRoute } from "../routes/agent-questions.js";
import { createTestDb } from "./helpers/test-db.js";
import type { SessionManager } from "../services/session.manager.js";
import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";

type WorkspaceSeed = { status: string; closedAt?: string | null; workingDir?: string | null };

async function appWithWorkspace(seed: WorkspaceSeed | null) {
  const { db } = createTestDb();
  await db.insert(projects).values({ id: "proj-1", name: "p", repoPath: "/tmp/p" });
  await db.insert(projectStatuses).values({ id: "st-1", projectId: "proj-1", name: "In Progress", sortOrder: 1 });
  await db.insert(issues).values({ id: "issue-1", issueNumber: 656, title: "--help", statusId: "st-1", projectId: "proj-1" });
  if (seed) {
    await db.insert(workspaces).values({
      id: "ws-1",
      issueId: "issue-1",
      branch: "master",
      isDirect: true,
      status: seed.status,
      closedAt: seed.closedAt ?? null,
      workingDir: seed.workingDir ?? null,
    });
  }
  // The 409 path returns before the session manager is touched; anything that reaches it
  // is a bug in the guard, so a throwing stub is the assertion.
  const getSessionManager = () => {
    throw new Error("session manager must not be reached for a dead workspace");
  };
  const app = new Hono();
  app.route("/projects", createAgentQuestionsRoute(db, getSessionManager as unknown as () => SessionManager));
  return app;
}

function answerRequest() {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "ws-1",
      questions: [{ question: "What should happen with it?", options: [{ label: "Close/delete as noise" }] }],
      answers: [{ selectedLabels: ["Close/delete as noise"] }],
    }),
  };
}

describe("POST agent-questions/:toolUseId/answer — workspace no longer answerable", () => {
  it("refuses with 409 + canDismiss when the asking workspace is closed", async () => {
    const app = await appWithWorkspace({ status: "closed", closedAt: new Date().toISOString() });
    const res = await app.request("/projects/proj-1/agent-questions/mcp-clarify-1/answer", answerRequest());
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; canDismiss: boolean };
    expect(body.canDismiss).toBe(true);
    expect(body.error).toContain("closed");
    // The old failure mode leaked a setup instruction the user could not act on.
    expect(body.error).not.toContain("run setup first");
  });

  it("refuses with 409 + canDismiss when the workspace row is gone entirely", async () => {
    const app = await appWithWorkspace(null);
    const res = await app.request("/projects/proj-1/agent-questions/mcp-clarify-1/answer", answerRequest());
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; canDismiss: boolean };
    expect(body.canDismiss).toBe(true);
    expect(body.error).toContain("deleted");
  });

  it("refuses with 409 when the workspace is open but has no working directory", async () => {
    const app = await appWithWorkspace({ status: "active", workingDir: null });
    const res = await app.request("/projects/proj-1/agent-questions/mcp-clarify-1/answer", answerRequest());
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; canDismiss: boolean };
    expect(body.canDismiss).toBe(true);
    expect(body.error).toContain("no working directory");
  });
});
