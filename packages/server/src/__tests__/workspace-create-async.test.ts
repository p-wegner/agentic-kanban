/**
 * #269: POST /api/workspaces blocked the HTTP request for its whole worktree-provisioning
 * pipeline (measured 8+ minutes live). `?async=1` must return 202 with a pollable
 * create-job id immediately, and the job must converge to the same verdict the
 * synchronous 201 body would have carried.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { GIT_HEAVY_TEST_TIMEOUT_MS } from "./helpers/timeouts.js";
import { resetCreateJobs } from "../services/create-job.service.js";
import {
  createTestApp,
  createProjectDirectly,
  createStatusDirectly,
} from "./helpers/api-test-helpers.js";

async function pollJob(app: ReturnType<typeof createTestApp>["app"], jobId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.request(`/api/workspaces/create-jobs/${jobId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { job: { state: string } | null };
    if (body.job && body.job.state !== "running") return body.job as {
      state: string; workspaceId?: string; error?: string; durationMs?: number;
      result?: { id?: string; branch?: string; workingDir?: string | null; status?: string };
    };
    if (Date.now() > deadline) throw new Error(`create job ${jobId} still running after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("POST /api/workspaces?async=1 (#269)", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let statusId: string;

  beforeAll(async () => {
    projectId = await createProjectDirectly(database, { name: "Async Create Project" });
    statusId = await createStatusDirectly(database, projectId, "Todo", 0);
    await createStatusDirectly(database, projectId, "In Progress", 1);
  });

  beforeEach(() => resetCreateJobs());

  async function createIssue(title: string): Promise<string> {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, statusId, projectId }),
    });
    const body = await res.json() as { id: string };
    return body.id;
  }

  it("returns 202 + jobId immediately and the job converges to the created workspace", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, async () => {
    const issueId = await createIssue("async create happy path");

    const res = await app.request("/api/workspaces?async=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/ak-async-happy" }),
    });
    expect(res.status).toBe(202);
    const accepted = await res.json() as { accepted: boolean; jobId: string; issueId: string; statusUrl: string };
    expect(accepted.accepted).toBe(true);
    expect(accepted.issueId).toBe(issueId);
    expect(accepted.statusUrl).toBe(`/api/workspaces/create-jobs/${accepted.jobId}`);
    // The 202 body carries no workspace row — that is the point; the job does.

    const job = await pollJob(app, accepted.jobId);
    expect(job.state).toBe("succeeded");
    expect(job.workspaceId).toBeTruthy();
    expect(job.result?.id).toBe(job.workspaceId);
    expect(job.result?.branch).toBe("feature/ak-async-happy");
    expect(job.result?.workingDir).toBeTruthy();

    // The durable record exists: the workspace row is fetchable like a sync create's.
    const wsRes = await app.request(`/api/workspaces/${job.workspaceId}`);
    expect(wsRes.status).toBe(200);
  });

  it("marks the job failed when the create throws (unknown issue), instead of a silent 202", async () => {
    const res = await app.request("/api/workspaces?async=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: "does-not-exist" }),
    });
    expect(res.status).toBe(202);
    const accepted = await res.json() as { jobId: string };

    const job = await pollJob(app, accepted.jobId, 10_000);
    expect(job.state).toBe("failed");
    expect(job.error).toContain("Issue not found");
  });

  it("GET create-jobs/:jobId returns job:null for an unknown id", async () => {
    const res = await app.request("/api/workspaces/create-jobs/create-nope-1");
    expect(res.status).toBe(200);
    const body = await res.json() as { job: unknown };
    expect(body.job).toBeNull();
  });

  it("stays synchronous (201 with the workspace row) without the flag", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, async () => {
    const issueId = await createIssue("sync create back-compat");
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, branch: "feature/ak-async-sync-compat" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; branch: string };
    expect(body.branch).toBe("feature/ak-async-sync-compat");
  });
});
