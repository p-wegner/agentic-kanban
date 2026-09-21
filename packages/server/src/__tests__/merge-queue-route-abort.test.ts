/**
 * #1150 criterion #2 (this ticket, #1152): the SSE route must notice a client disconnect the
 * instant it happens, not merely after the next `writeSSE` call returns or throws. Before this
 * fix the `for await` loop only checked `stream.closed` AFTER an `await stream.writeSSE(...)`
 * resolved — and `executeQueue`/`runTrainStrategy`'s locked region can run for tens of minutes
 * between yields (a rebase, a 30-45 minute pre-merge gate), during which a disconnect went
 * completely unnoticed by the route.
 *
 * `stream.onAbort()` (Hono's `StreamingApi`) fires synchronously off the underlying stream's
 * `cancel()` — which is exactly what happens when the response body's reader is cancelled, the
 * real signal a disconnected client's socket teardown produces. Wiring it to call the live
 * generator's `.return()` reaches the generator's `finally` blocks (lock release, heartbeat
 * clear) at its next `yield` instead of waiting for the route's own loop to notice.
 *
 * Only the ROUTE is under test here. The train runner needs no companion change: a queued
 * `.return()` is delivered at the generator's next `yield`, not at the instant an in-flight
 * `await` settles (verified against Node's async-generator semantics while porting this onto
 * #1203's layout), and `runTrainStrategy` persists the row (`finishMergeTrain`) and clears the
 * live registry BEFORE its first post-gate `yield` — so a disconnect can't strand the row.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createMergeQueueRoute } from "../routes/merge-queue.js";

const mockExecuteQueue = vi.fn();

vi.mock("../services/merge-queue.service.js", () => ({
  createMergeQueueService: vi.fn(() => ({
    computePlan: vi.fn(),
    executeQueue: mockExecuteQueue,
  })),
}));

vi.mock("../services/workspace-merge.service.js", () => ({
  createWorkspaceMergeService: vi.fn(() => ({})),
}));

function makeApp() {
  const app = new Hono();
  app.route("/api/merge-queue", createMergeQueueRoute({} as never, () => ({}) as never));
  return app;
}

describe("merge-queue route SSE disconnect wiring (#1152)", () => {
  it("calls the live generator's .return() when the client disconnects mid-stream", async () => {
    const returnSpy = vi.fn().mockResolvedValue({ done: true, value: undefined });

    // Stands in for executeQueue()/runTrainStrategy(): yields once, then suspends on a
    // never-resolving await — mirrors the real generator's long locked region between yields
    // (a rebase, or a 30-45 minute gate) during which a disconnect must still be noticed.
    async function* fakeEvents() {
      yield { type: "rebasing", workspaceId: "ws-1", issueNumber: 1, issueTitle: "t", position: 1, total: 1 };
      await new Promise(() => {
        // never resolves — the route must not need this to settle to notice the disconnect
      });
      yield { type: "done", merged: [], failed: [], skipped: [] };
    }
    const gen = fakeEvents();
    gen.return = returnSpy as typeof gen.return;
    mockExecuteQueue.mockReturnValue(gen);

    const app = makeApp();
    const res = await app.request("/api/merge-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceIds: ["ws-1"], dryRun: false }),
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    await reader.read(); // let the generator run past its first yield, exactly like a real client
    await reader.cancel(); // the real signal a disconnected client's socket teardown produces

    // Let the abort's synchronous subscriber callback run.
    await new Promise((r) => setTimeout(r, 0));

    expect(returnSpy).toHaveBeenCalled();
  });

  it("never calls .return() when the stream completes normally (no false aborts)", async () => {
    const returnSpy = vi.fn().mockResolvedValue({ done: true, value: undefined });

    // Ends by running out rather than with a `done` event: the route's own loop `break`s on
    // `done`, and a `break` out of `for await` calls `.return()` too (with no argument) — that
    // call is the loop's, not the abort wiring's, and would make this assertion meaningless.
    // A generator that completes on its own is what isolates the `onAbort` subscriber.
    async function* fakeEvents() {
      yield { type: "merged", workspaceId: "ws-1", issueNumber: 1, issueTitle: "t", position: 1, total: 1 };
    }
    const gen = fakeEvents();
    gen.return = returnSpy as typeof gen.return;
    mockExecuteQueue.mockReturnValue(gen);

    const app = makeApp();
    const res = await app.request("/api/merge-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceIds: ["ws-1"], dryRun: false }),
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    // Drain the stream to completion, same as a client that stays connected.
    while (!(await reader.read()).done) {
      // keep reading
    }

    expect(returnSpy).not.toHaveBeenCalled();
  });
});
