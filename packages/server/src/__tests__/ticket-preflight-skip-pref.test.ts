/**
 * `skip_preflight` must be enforced SERVER-SIDE.
 *
 * The launch form was the only gate, so every other caller (CLI, MCP, butler, a second
 * browser tab) still paid for the AI ticket check after the operator turned preflight off.
 * These tests pin the route behavior: with the pref on, the endpoint returns a skipped
 * verdict and never reaches `runTicketPreflight` (which would spawn a Claude CLI call).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createIssuesRoute } from "../routes/issues.js";
// `skipped` is set by the route (issues.ts) but is not declared on PreflightResponse,
// hence the intersection at the two read sites below.
import type { PreflightResponse } from "@agentic-kanban/shared";

const runTicketPreflight = vi.hoisted(() => vi.fn());

vi.mock("../services/ticket-preflight.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ticket-preflight.service.js")>();
  return { ...actual, runTicketPreflight };
});

async function seed(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: `p-${projectId.slice(0, 8)}`, repoPath: `/tmp/${projectId}`,
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now,
  });
  const issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId, issueNumber: 1, title: "Some ticket", statusId, projectId, createdAt: now, updatedAt: now,
  });
  return { projectId, issueId };
}

describe("POST /api/issues/:id/preflight — skip_preflight", () => {
  const { db } = createTestDb();
  const app = new Hono();
  app.route("/api/issues", createIssuesRoute(db));
  let ids: Awaited<ReturnType<typeof seed>>;

  beforeEach(async () => {
    runTicketPreflight.mockReset();
    runTicketPreflight.mockResolvedValue({
      verdict: "ready", questions: [], summary: "checked", looksComplex: false,
    });
    ids = await seed(db);
    await db.delete(schema.preferences);
  });

  function post(body: unknown) {
    return app.request(`/api/issues/${ids.issueId}/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("skips the AI check and reports the skip when skip_preflight is true", async () => {
    await db.insert(schema.preferences).values({
      key: "skip_preflight", value: "true", updatedAt: new Date().toISOString(),
    });

    const res = await post({ projectId: ids.projectId });
    expect(res.status).toBe(200);
    const body = await res.json() as PreflightResponse & { skipped?: boolean };

    expect(body.skipped).toBe(true);
    expect(body.verdict).toBe("ready");
    expect(body.summary).toMatch(/skip_preflight/);
    expect(runTicketPreflight).not.toHaveBeenCalled();
  });

  it("runs the check when the pref is absent (default off)", async () => {
    const res = await post({ projectId: ids.projectId });
    expect(res.status).toBe(200);
    const body = await res.json() as PreflightResponse & { skipped?: boolean };

    expect(body.skipped).toBeUndefined();
    expect(runTicketPreflight).toHaveBeenCalledTimes(1);
  });

  it("runs the check when skip_preflight is explicitly false", async () => {
    await db.insert(schema.preferences).values({
      key: "skip_preflight", value: "false", updatedAt: new Date().toISOString(),
    });

    const res = await post({ projectId: ids.projectId });
    expect(res.status).toBe(200);
    expect(runTicketPreflight).toHaveBeenCalledTimes(1);
  });
});
