/**
 * #1250 — the merge tracker: one POST per merge door, a joined second click, and the terminal
 * handlers firing exactly once with the merge-error (fix hint included) or the refetch.
 *
 * The scheduler and the API seam are mocked; each poll tick is driven by hand through
 * `pollMergeStatus` so the state machine is asserted without timers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ apiFetch: vi.fn(), apiPost: vi.fn() }));
const scheduler = vi.hoisted(() => ({ started: [] as Array<{ intervalMs: number; stop: ReturnType<typeof vi.fn> }> }));

vi.mock("./api.js", () => ({ apiFetch: api.apiFetch, apiPost: api.apiPost }));
vi.mock("./pollScheduler.js", () => ({
  startStaggeredPoll: vi.fn((_fn: () => void, intervalMs: number) => {
    const handle = { intervalMs, stop: vi.fn() };
    scheduler.started.push(handle);
    return handle;
  }),
}));

import {
  MERGE_STATUS_POLL_MS,
  bankShrinksAndRetry,
  getMergeJobsSnapshot,
  isMergeTracked,
  mergeDoorHandlers,
  pollMergeStatus,
  resetMergeJobTracker,
  startAsyncMerge,
  subscribeMergeJobs,
} from "./mergeJobTracker.js";
import type { MergeStatusView } from "./mergeJobBadge.js";

const running: MergeStatusView = {
  job: { jobId: "job-1", state: "running", startedAt: new Date().toISOString(), attempts: [{ attempt: 1, phase: "verify", phaseSince: new Date().toISOString() }] },
};
const failed: MergeStatusView = {
  job: { jobId: "job-1", state: "failed", startedAt: new Date().toISOString(), attempts: [{ attempt: 1, outcome: "failed", detail: "FAIL nloc\nstale baseline: lower a::A 10 -> 9 in packages/client/src/__tests__/function-nloc-baseline.ts" }] },
  fixHint: { kind: "bank-shrinks", summary: "stale baseline: lower a::A 10 -> 9 in …", edits: [{ baselineFile: "packages/client/src/__tests__/function-nloc-baseline.ts", key: "a::A", from: 10, to: 9 }] },
};
const succeeded: MergeStatusView = { job: { jobId: "job-1", state: "succeeded", startedAt: new Date().toISOString(), attempts: [] } };

/**
 * Drive polls until `done` holds. The tracker's own immediate first poll may still be in
 * flight (its `finally` runs a microtask after the snapshot is published), and a tick that
 * overlaps one in flight is skipped by design — so a hand-driven tick is retried, never assumed.
 */
async function pollUntil(wsId: string, done: () => boolean): Promise<void> {
  await vi.waitFor(async () => {
    await pollMergeStatus(wsId);
    expect(done()).toBe(true);
  });
}

beforeEach(() => {
  resetMergeJobTracker();
  api.apiFetch.mockReset();
  api.apiPost.mockReset();
  scheduler.started.length = 0;
  api.apiPost.mockResolvedValue({ accepted: true, jobId: "job-1", statusUrl: "/api/workspaces/ws-1/merge-status" });
});

describe("startAsyncMerge", () => {
  it("posts ?async=1 once, tracks the job, polls at the sanctioned interval, and hands a failure (with its hint) to onFailed", async () => {
    api.apiFetch.mockResolvedValueOnce(running);
    const onFailed = vi.fn();
    const onSucceeded = vi.fn();
    const changes = vi.fn();
    subscribeMergeJobs(changes);

    const first = await startAsyncMerge("ws-1", { onFailed, onSucceeded });
    expect(first).toEqual({ joined: false, jobId: "job-1" });
    expect(api.apiPost).toHaveBeenCalledWith("/api/workspaces/ws-1/merge?async=1", {});
    expect(scheduler.started).toHaveLength(1);
    expect(scheduler.started[0]!.intervalMs).toBe(MERGE_STATUS_POLL_MS);
    // The immediate first poll ran (running) — the snapshot carries it, nothing is terminal yet.
    await vi.waitFor(() => expect(getMergeJobsSnapshot().get("ws-1")?.status).toEqual(running));
    expect(isMergeTracked("ws-1")).toBe(true);
    expect(onFailed).not.toHaveBeenCalled();

    // A second click while running JOINS: no POST, handlers replaced, caller told so.
    const onFailed2 = vi.fn();
    const second = await startAsyncMerge("ws-1", { onFailed: onFailed2, onSucceeded });
    expect(second).toEqual({ joined: true, jobId: "job-1" });
    expect(api.apiPost).toHaveBeenCalledTimes(1);

    api.apiFetch.mockResolvedValueOnce(failed);
    await pollUntil("ws-1", () => !isMergeTracked("ws-1"));
    expect(scheduler.started[0]!.stop).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
    expect(onFailed2).toHaveBeenCalledTimes(1);
    const error = onFailed2.mock.calls[0]![0];
    expect(error.wsId).toBe("ws-1");
    expect(error.message).toContain("stale baseline: lower a::A 10 -> 9");
    expect(error.fixHint?.edits).toEqual(failed.fixHint!.edits);
    expect(onSucceeded).not.toHaveBeenCalled();
    expect(changes).toHaveBeenCalled();
  });

  it("calls onSucceeded once the job succeeds, and stops polling", async () => {
    api.apiFetch.mockResolvedValueOnce(running).mockResolvedValueOnce(succeeded);
    const onSucceeded = vi.fn();
    await startAsyncMerge("ws-2", { onSucceeded });
    await vi.waitFor(() => expect(api.apiFetch).toHaveBeenCalledTimes(1));
    await pollUntil("ws-2", () => !isMergeTracked("ws-2"));
    expect(onSucceeded).toHaveBeenCalledTimes(1);
    expect(scheduler.started[0]!.stop).toHaveBeenCalled();
  });

  it("treats the absent shape as terminal: completed → success, anything else → failure with the server's message", async () => {
    api.apiFetch.mockResolvedValueOnce({ job: null, outcome: "completed", message: "stamped MERGED" });
    const a = { onSucceeded: vi.fn(), onFailed: vi.fn() };
    await startAsyncMerge("ws-3", a);
    await vi.waitFor(() => expect(a.onSucceeded).toHaveBeenCalledTimes(1));
    expect(a.onFailed).not.toHaveBeenCalled();

    api.apiFetch.mockResolvedValueOnce({ job: null, outcome: "interrupted", message: "the process running it died first" });
    const b = { onSucceeded: vi.fn(), onFailed: vi.fn() };
    await startAsyncMerge("ws-4", b);
    await vi.waitFor(() => expect(b.onFailed).toHaveBeenCalledTimes(1));
    expect(b.onFailed.mock.calls[0]![0].message).toContain("died first");
  });

  it("keeps polling through a transient fetch error, and tracks nothing when the POST itself fails", async () => {
    api.apiFetch.mockRejectedValueOnce(new Error("502")).mockResolvedValueOnce(succeeded);
    const onSucceeded = vi.fn();
    await startAsyncMerge("ws-5", { onSucceeded });
    await vi.waitFor(() => expect(api.apiFetch).toHaveBeenCalledTimes(1));
    expect(isMergeTracked("ws-5")).toBe(true);
    await pollUntil("ws-5", () => !isMergeTracked("ws-5"));
    expect(onSucceeded).toHaveBeenCalledTimes(1);

    api.apiPost.mockRejectedValueOnce(new Error("409 held"));
    await expect(startAsyncMerge("ws-6")).rejects.toThrow("409 held");
    expect(isMergeTracked("ws-6")).toBe(false);
  });
});

describe("bankShrinksAndRetry", () => {
  it("posts to /merge/bank-shrinks and tracks the re-triggered job", async () => {
    api.apiPost.mockResolvedValueOnce({ applied: [], committed: "abc123", jobId: "job-9", statusUrl: "…" });
    api.apiFetch.mockResolvedValueOnce({ ...running, job: { ...running.job!, jobId: "job-9" } });
    const result = await bankShrinksAndRetry("ws-1", {});
    expect(result).toEqual({ jobId: "job-9", committed: "abc123" });
    expect(api.apiPost).toHaveBeenCalledWith("/api/workspaces/ws-1/merge/bank-shrinks", {});
    expect(isMergeTracked("ws-1")).toBe(true);
    expect(getMergeJobsSnapshot().get("ws-1")?.jobId).toBe("job-9");
  });
});

describe("mergeDoorHandlers", () => {
  it("routes a failure to the merge-error banner (and the page error) and a success to the refetch", () => {
    const setMergeError = vi.fn();
    const setError = vi.fn();
    const refetch = vi.fn();
    const handlers = mergeDoorHandlers({ setMergeError, setError, refetch });
    handlers.onFailed!({ wsId: "ws-1", message: "boom", fixHint: null });
    expect(setMergeError).toHaveBeenCalledWith({ wsId: "ws-1", message: "boom", fixHint: null });
    expect(setError).toHaveBeenCalledWith("boom");
    handlers.onSucceeded!();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
