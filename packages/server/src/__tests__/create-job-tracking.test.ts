import { beforeEach, describe, expect, it } from "vitest";
import {
  completeCreateJob,
  failCreateJob,
  getCreateJob,
  resetCreateJobs,
  startCreateJob,
} from "../services/create-job.service.js";

/**
 * #269: a workspace creation's verdict outlives the HTTP request that started it — on real
 * projects provisioning runs 8+ minutes (worktree + per-worktree dependency install +
 * context packer), so "my client timed out" must stop being indistinguishable from
 * "the launch failed".
 */
describe("create job tracking", () => {
  beforeEach(() => resetCreateJobs());

  it("has no record for an unknown job id", () => {
    expect(getCreateJob("create-nope-1")).toBeNull();
  });

  it("records a running job, then its success, workspaceId, and duration", () => {
    const job = startCreateJob("issue-1", new Date(Date.now() - 5000).toISOString());
    expect(getCreateJob(job.jobId)?.state).toBe("running");
    expect(getCreateJob(job.jobId)?.issueId).toBe("issue-1");

    completeCreateJob(job.jobId, { id: "ws-1", status: "active", branch: "feature/ak-1-x" } as never);

    const done = getCreateJob(job.jobId);
    expect(done?.state).toBe("succeeded");
    expect(done?.workspaceId).toBe("ws-1");
    expect((done?.result as { branch?: string }).branch).toBe("feature/ak-1-x");
    expect(done?.finishedAt).toBeTruthy();
    expect(done?.durationMs).toBeGreaterThanOrEqual(4000);
  });

  it("maps a RESOLVED error-status result to a failed job (createWorkspace rarely throws)", () => {
    const job = startCreateJob("issue-2");
    completeCreateJob(job.jobId, { id: "ws-2", status: "error", error: "worktree creation failed: boom" });

    const failed = getCreateJob(job.jobId);
    expect(failed?.state).toBe("failed");
    expect(failed?.error).toContain("worktree creation failed");
    // The result payload is still attached so a poller sees the full row-shaped response.
    expect((failed?.result as { status?: string }).status).toBe("error");
  });

  it("records a thrown failure (WorkspaceError path) with its message", () => {
    const job = startCreateJob("issue-3");
    failCreateJob(job.jobId, new Error("Issue not found"));

    const failed = getCreateJob(job.jobId);
    expect(failed?.state).toBe("failed");
    expect(failed?.error).toBe("Issue not found");
    expect(failed?.result).toBeUndefined();
  });

  it("keeps concurrent creations for the SAME issue separate (unlike merge jobs, keyed by jobId)", () => {
    const a = startCreateJob("issue-4");
    const b = startCreateJob("issue-4");
    completeCreateJob(a.jobId, { id: "ws-a", status: "active" });
    failCreateJob(b.jobId, new Error("branch collision"));

    expect(getCreateJob(a.jobId)?.state).toBe("succeeded");
    expect(getCreateJob(b.jobId)?.state).toBe("failed");
  });

  it("does not let a late second settlement clobber a finished job", () => {
    const job = startCreateJob("issue-5");
    completeCreateJob(job.jobId, { id: "ws-5", status: "active" });
    failCreateJob(job.jobId, new Error("late duplicate settle"));

    const current = getCreateJob(job.jobId);
    expect(current?.state).toBe("succeeded");
    expect(current?.error).toBeUndefined();
  });

  it("bounds retained finished jobs instead of growing forever, never evicting running ones", () => {
    const running = startCreateJob("issue-running");
    const finished: string[] = [];
    for (let i = 0; i < 120; i++) {
      const job = startCreateJob(`issue-bulk-${i}`);
      completeCreateJob(job.jobId, { id: `ws-bulk-${i}`, status: "active" });
      finished.push(job.jobId);
    }
    expect(getCreateJob(finished[0])).toBeNull();
    expect(getCreateJob(finished[119])?.state).toBe("succeeded");
    expect(getCreateJob(running.jobId)?.state).toBe("running");
  });
});
