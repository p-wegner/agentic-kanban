/**
 * #1431 — the one-shot frame pair on the fleet protocol: a sessionless `oneshot` request the worker
 * parses, and the `oneshot_result` (`accepted`, then `done`) the board parses.
 */
import { describe, expect, it } from "vitest";
import { parseBoardToWorkerMessage, parseWorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";

const job = { command: "claude", args: ["-p"], env: { A: "1", B: 2 }, prompt: "hi", timeoutMs: 5000, allowEdits: false };

describe("oneshot request", () => {
  it("parses without a session id, keeping the pinned profile on the intent", () => {
    const msg = parseBoardToWorkerMessage(JSON.stringify({
      type: "oneshot", requestId: "r1", job: { ...job, intent: { provider: "claude", program: "claude", profile: " work " } },
    }));
    expect(msg).toMatchObject({ type: "oneshot", requestId: "r1" });
    if (msg?.type !== "oneshot") throw new Error("not a oneshot");
    expect(msg.job.env).toEqual({ A: "1" });
    expect(msg.job.intent).toEqual({ provider: "claude", program: "claude", profile: "work" });
    expect(msg.repo).toBeUndefined();
  });

  it("carries the repo transport when the prompt needs files", () => {
    const repo = { projectId: "p", gitPort: 1, gitToken: "t", branch: "b", baseBranch: "master", incomingRef: "refs/kanban/incoming/b" };
    const msg = parseBoardToWorkerMessage({ type: "oneshot", requestId: "r2", job: { ...job, allowEdits: true }, repo });
    expect(msg).toMatchObject({ type: "oneshot", job: { allowEdits: true }, repo: { branch: "b", incomingRef: "refs/kanban/incoming/b" } });
  });

  it.each([
    ["no request id", { type: "oneshot", job }],
    ["no prompt", { type: "oneshot", requestId: "r", job: { ...job, prompt: undefined } }],
    ["a zero timeout", { type: "oneshot", requestId: "r", job: { ...job, timeoutMs: 0 } }],
    ["no job", { type: "oneshot", requestId: "r" }],
  ])("drops a malformed request: %s", (_label, raw) => {
    expect(parseBoardToWorkerMessage(raw)).toBeNull();
  });
});

describe("oneshot_result", () => {
  it("parses the ack and the outcome", () => {
    expect(parseWorkerToBoardMessage({ type: "oneshot_result", result: { requestId: "r", phase: "accepted" } }))
      .toEqual({ type: "oneshot_result", result: { requestId: "r", phase: "accepted" } });
    expect(parseWorkerToBoardMessage({
      type: "oneshot_result",
      result: { requestId: "r", phase: "done", ok: true, text: "answer", pushedSha: "abc123", junk: 1 },
    })).toEqual({ type: "oneshot_result", result: { requestId: "r", phase: "done", ok: true, text: "answer", pushedSha: "abc123" } });
  });

  it("keeps launchFailed so the board can place the job elsewhere", () => {
    const msg = parseWorkerToBoardMessage({
      type: "oneshot_result", result: { requestId: "r", phase: "done", ok: false, launchFailed: true, error: "no such profile" },
    });
    expect(msg).toMatchObject({ result: { ok: false, launchFailed: true, error: "no such profile" } });
  });

  it("drops a result with an unknown phase", () => {
    expect(parseWorkerToBoardMessage({ type: "oneshot_result", result: { requestId: "r", phase: "weird" } })).toBeNull();
  });
});
