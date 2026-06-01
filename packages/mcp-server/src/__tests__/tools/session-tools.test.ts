import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { registerGetSessionTranscript } from "../../tools/get-session-transcript.js";
import { registerSearchSessions } from "../../tools/search-sessions.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedIssue, seedProject } from "../helpers/seed.js";

async function seedSession(
  db: ReturnType<typeof setupTool>["db"],
  opts: {
    projectName?: string;
    issueNumber?: number;
    issueTitle?: string;
    branch?: string;
    executor?: string;
    messages?: string[];
  } = {},
) {
  const { projectId, statusIds } = await seedProject(db, opts.projectName ?? "Session Search Project");
  const { id: issueId, issueNumber } = await seedIssue(db, projectId, statusIds["Done"], {
    issueNumber: opts.issueNumber ?? 1,
    title: opts.issueTitle ?? "Session issue",
  });
  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: opts.branch ?? "feature/session-search",
    status: "closed",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.sessions).values({
    id: sessionId,
    workspaceId,
    executor: opts.executor ?? "claude-code",
    status: "completed",
    providerSessionId: "provider-session-1",
    startedAt: now,
    endedAt: now,
  });
  for (const data of opts.messages ?? ["Implemented NeedleSearch and fixed retry handling"]) {
    await db.insert(schema.sessionMessages).values({
      sessionId,
      type: "stdout",
      data,
      createdAt: now,
    });
  }

  return { projectId, issueId, issueNumber, workspaceId, sessionId };
}

describe("session MCP tools", () => {
  it("retrieves a session transcript directly by board session id", async () => {
    const { invoke, db } = setupTool(registerGetSessionTranscript);
    const { sessionId, workspaceId } = await seedSession(db, {
      issueNumber: 287,
      issueTitle: "Ticket implementation",
      messages: ["First note", "Second note"],
    });

    const data = parseResult(await invoke({ sessionId }));

    expect(data.sessionId).toBe(sessionId);
    expect(data.workspaceId).toBe(workspaceId);
    expect(data.issueNumber).toBe(287);
    expect(data.issueTitle).toBe("Ticket implementation");
    expect(data.providerSessionId).toBe("provider-session-1");
    expect(data.messages.map((m: any) => m.data)).toEqual(["First note", "Second note"]);
  });

  it("searches session transcripts globally and filters by issue number", async () => {
    const { invoke, db } = setupTool(registerSearchSessions);
    const target = await seedSession(db, {
      projectName: "Target Project",
      issueNumber: 287,
      issueTitle: "AK-287",
      executor: "codex",
      messages: ["NeedleSearch problem: migration conflict"],
    });
    await seedSession(db, {
      projectName: "Other Project",
      issueNumber: 288,
      messages: ["NeedleSearch unrelated result"],
    });

    const data = parseResult(await invoke({ query: "NeedleSearch", issueNumber: 287 }));

    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toMatchObject({
      sessionId: target.sessionId,
      projectName: "Target Project",
      issueNumber: 287,
      issueTitle: "AK-287",
      executor: "codex",
    });
    expect(data.results[0].snippet).toContain("NeedleSearch");
  });
});
