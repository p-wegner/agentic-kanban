import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createIssueService } from "../services/issue.service.js";

describe("{{issueNumber}} in a new issue's description (#1709)", () => {
  it("is replaced by the number the issue receives", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    await db.insert(schema.projects).values({ id: projectId, name: "Tok", repoPath: "/tmp/tok", repoName: "tok", defaultBranch: "main", createdAt: now, updatedAt: now });
    await db.insert(schema.projectStatuses).values({ id: randomUUID(), projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now });
    const svc = createIssueService({ database: db });
    const issue = await svc.createIssue({ projectId, title: "t", description: 'send "ticket": {{issueNumber}}' });
    expect(issue.description).toBe(`send "ticket": ${issue.issueNumber}`);
  });
});
