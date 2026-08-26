import { beforeEach, describe, expect, it } from "vitest";
import {
  completeMergeJob,
  failMergeJob,
  getMergeJob,
  isZombieMergeJob,
  MERGE_JOB_ZOMBIE_AFTER_MS,
  resetMergeJobs,
  startMergeJob,
} from "../services/merge-job.service.js";

/**
 * The point of this registry is that a merge's verdict outlives the HTTP request that started
 * it — on this repo the pre-merge gate runs 30-45 minutes, so "my client timed out" must stop
 * being indistinguishable from "the merge failed".
 */
describe("merge job tracking", () => {
  beforeEach(() => resetMergeJobs());

  it("has no record for a workspace that never merged", () => {
    expect(getMergeJob("ws-unknown")).toBeNull();
  });

  it("records a running job, then its success and duration", () => {
    const job = startMergeJob("ws-1", new Date(Date.now() - 5000).toISOString());
    expect(getMergeJob("ws-1")?.state).toBe("running");

    completeMergeJob(job.jobId, "ws-1", { merged: true, sha: "abc" });

    const done = getMergeJob("ws-1");
    expect(done?.state).toBe("succeeded");
    expect(done?.result).toEqual({ merged: true, sha: "abc" });
    expect(done?.finishedAt).toBeTruthy();
    // The duration is the number that tells an operator what the gate actually cost.
    expect(done?.durationMs).toBeGreaterThanOrEqual(4000);
  });

  it("records a failure with its message and machine-readable reason", () => {
    const job = startMergeJob("ws-2");
    const err = Object.assign(new Error("Pre-merge gate failed (verify) — merge withheld."), {
      details: { mergeReason: "pre_merge_gate_failed" },
    });

    failMergeJob(job.jobId, "ws-2", err);

    const failed = getMergeJob("ws-2");
    expect(failed?.state).toBe("failed");
    expect(failed?.error).toContain("Pre-merge gate failed");
    // Without this, the 300-char-truncated message (#221) is all a caller ever sees.
    expect(failed?.reason).toBe("pre_merge_gate_failed");
  });

  it("does not let a STALE completion clobber a newer running merge", () => {
    // The exact race a retry produces: attempt 1 is abandoned, attempt 2 starts, then
    // attempt 1's promise finally settles. Attempt 2 must remain the live record.
    const first = startMergeJob("ws-3");
    const second = startMergeJob("ws-3");
    expect(getMergeJob("ws-3")?.jobId).toBe(second.jobId);

    completeMergeJob(first.jobId, "ws-3", { merged: true });

    const current = getMergeJob("ws-3");
    expect(current?.jobId).toBe(second.jobId);
    expect(current?.state).toBe("running");
    expect(current?.result).toBeUndefined();
  });

  it("keeps each workspace's job separate", () => {
    const a = startMergeJob("ws-a");
    const b = startMergeJob("ws-b");
    completeMergeJob(a.jobId, "ws-a", { merged: true });
    failMergeJob(b.jobId, "ws-b", new Error("conflict"));

    expect(getMergeJob("ws-a")?.state).toBe("succeeded");
    expect(getMergeJob("ws-b")?.state).toBe("failed");
  });

  it("bounds retained finished jobs instead of growing forever", () => {
    for (let i = 0; i < 120; i++) {
      const job = startMergeJob(`ws-bulk-${i}`);
      completeMergeJob(job.jobId, `ws-bulk-${i}`, { merged: true });
    }
    // Early entries evicted; the most recent survive.
    expect(getMergeJob("ws-bulk-0")).toBeNull();
    expect(getMergeJob("ws-bulk-119")?.state).toBe("succeeded");
  });

  /**
   * The eviction list is keyed by workspaceId while the map holds at most ONE job per workspace,
   * so a workspace that merged twice used to occupy two slots pointing at the same key. When the
   * OLDER duplicate reached the cap and shifted out, the eviction deleted the entry holding the
   * NEWER (still-poll-able) verdict — and the surviving duplicate then evicted nothing, so the
   * bound leaked by one at the same time. A workspace merged twice is routine (fix-and-merge,
   * a retried merge after a gate failure), not exotic.
   */
  it("does not lose a re-merged workspace's verdict when its older duplicate is evicted", () => {
    // Finish ws-twice ONCE, early enough that its first slot is what the cap pushes out.
    const first = startMergeJob("ws-twice");
    completeMergeJob(first.jobId, "ws-twice", { merged: true, attempt: 1 });

    // Fill the retention window most of the way.
    for (let i = 0; i < 45; i++) {
      const job = startMergeJob(`ws-filler-${i}`);
      completeMergeJob(job.jobId, `ws-filler-${i}`, { merged: true });
    }

    // Merge the same workspace a SECOND time — this is the record a caller polls for.
    const second = startMergeJob("ws-twice");
    failMergeJob(second.jobId, "ws-twice", new Error("conflict on retry"));
    expect(getMergeJob("ws-twice")?.jobId).toBe(second.jobId);

    // Push past the 50-job cap so the oldest entries are evicted.
    for (let i = 0; i < 20; i++) {
      const job = startMergeJob(`ws-late-${i}`);
      completeMergeJob(job.jobId, `ws-late-${i}`, { merged: true });
    }

    const survivor = getMergeJob("ws-twice");
    expect(survivor).not.toBeNull();
    expect(survivor!.jobId).toBe(second.jobId);
    expect(survivor!.state).toBe("failed");
    expect(survivor!.error).toContain("conflict on retry");
  });
});

/**
 * #903 — a merge job whose verify children died (or whose process wedged outright) must not
 * sit `"running"` forever: `mergeWorkspaceDeduped` made every retry join the same dead promise,
 * and only a backend restart ever cleared it. `getMergeJob` self-heals a stuck job into
 * `"failed"` once it has been `"running"` for longer than any legitimate gate chain could take.
 */
describe("merge job zombie detection (#903)", () => {
  beforeEach(() => resetMergeJobs());

  it("isZombieMergeJob is false for a running job well within the budget", () => {
    const job = startMergeJob("ws-live", new Date(Date.now() - 5000).toISOString());
    expect(isZombieMergeJob(job)).toBe(false);
  });

  it("isZombieMergeJob is false for a job that already finished, however old", () => {
    const job = startMergeJob("ws-done", new Date(Date.now() - MERGE_JOB_ZOMBIE_AFTER_MS * 5).toISOString());
    completeMergeJob(job.jobId, "ws-done", { merged: true });
    const done = getMergeJob("ws-done")!;
    expect(isZombieMergeJob(done)).toBe(false);
  });

  it("isZombieMergeJob is true once a running job exceeds the zombie budget", () => {
    const startedAt = new Date(Date.now() - (MERGE_JOB_ZOMBIE_AFTER_MS + 60_000)).toISOString();
    const job = startMergeJob("ws-stuck", startedAt);
    expect(isZombieMergeJob(job)).toBe(true);
  });

  it("getMergeJob self-heals a zombied running job into failed, with a machine-readable reason", () => {
    const startedAt = new Date(Date.now() - (MERGE_JOB_ZOMBIE_AFTER_MS + 60_000)).toISOString();
    startMergeJob("ws-zombie", startedAt);

    const healed = getMergeJob("ws-zombie");
    expect(healed?.state).toBe("failed");
    expect(healed?.reason).toBe("merge_job_zombied");
    expect(healed?.error).toContain("zombied");
    expect(healed?.finishedAt).toBeTruthy();
  });

  it("a healed zombie stays failed on a later read (does not re-heal or flip state)", () => {
    const startedAt = new Date(Date.now() - (MERGE_JOB_ZOMBIE_AFTER_MS + 60_000)).toISOString();
    startMergeJob("ws-zombie-2", startedAt);
    const first = getMergeJob("ws-zombie-2");
    const second = getMergeJob("ws-zombie-2");
    expect(first?.state).toBe("failed");
    expect(second?.state).toBe("failed");
    expect(second?.finishedAt).toBe(first?.finishedAt);
  });

  it("a genuinely long-running (not zombied) job survives a read unchanged", () => {
    // Just under the budget: a slow-but-alive multi-hour verify chain must not be misreported.
    const startedAt = new Date(Date.now() - (MERGE_JOB_ZOMBIE_AFTER_MS - 60_000)).toISOString();
    const job = startMergeJob("ws-slow", startedAt);
    expect(getMergeJob("ws-slow")?.state).toBe("running");
    expect(getMergeJob("ws-slow")?.jobId).toBe(job.jobId);
  });
});
