// #1383 — a result push the board rejects with 401 is retried ONCE with a fresh token the
// board issues on request, instead of re-sending the rejected credential until the retry
// budget is gone. The board side is exercised against a fake git-http that returns 401 for
// the stale token and accepts the new one.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUndeliveredStore, isGitAuthFailure } from "../worker/worker-undelivered-retry.js";
import { parseBoardToWorkerMessage, parseWorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import type { WorkerRepoTransport } from "@agentic-kanban/shared/lib/worker-protocol";

const repo = (gitToken: string): WorkerRepoTransport => ({
  projectId: "p1", gitPort: 1, gitToken, branch: "b", baseBranch: "master", incomingRef: "refs/kanban/incoming/b",
});
const checkout = { cwd: tmpdir(), cacheDir: tmpdir() };

function store(refreshToken: ((id: string) => Promise<string | null>) | undefined) {
  // fake git-http: only the fresh token is accepted, anything else is a 401
  const seen: string[] = [];
  const push = vi.fn(async (_url: string, r: WorkerRepoTransport) => {
    seen.push(r.gitToken);
    if (r.gitToken !== "fresh") throw new Error("fatal: unable to access: The requested URL returned error: 401");
  });
  const s = createUndeliveredStore({
    workRoot: mkdtempSync(join(tmpdir(), "ak-401-")),
    boardUrl: "http://board",
    retryDelaysMs: [1],
    push,
    cleanup: async () => {},
    safeSend: () => {},
    wait: async () => {},
    refreshToken,
  });
  return { s, seen, push };
}

describe("401 on the result push (#1383)", () => {
  it("asks for a fresh token and retries immediately with it", async () => {
    const refresh = vi.fn(async () => "fresh");
    const { s, seen } = store(refresh);
    const outcome = await s.pushWithRetry("s1", { checkout, repo: repo("stale") });
    expect(outcome).toEqual({ ok: true, attempts: 2 });
    expect(seen).toEqual(["stale", "fresh"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("falls back to the normal backoff when the board issues no token, asking only once", async () => {
    const refresh = vi.fn(async () => null);
    const { s, push } = store(refresh);
    const outcome = await s.pushWithRetry("s1", { checkout, repo: repo("stale") });
    expect(outcome.ok).toBe(false);
    expect(push).toHaveBeenCalledTimes(2); // 1 + the single configured retry
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a token on a non-auth failure", async () => {
    const refresh = vi.fn(async () => "fresh");
    const s = createUndeliveredStore({
      workRoot: mkdtempSync(join(tmpdir(), "ak-401-")), boardUrl: "http://board", retryDelaysMs: [],
      push: async () => { throw new Error("connection refused"); },
      cleanup: async () => {}, safeSend: () => {}, wait: async () => {}, refreshToken: refresh,
    });
    await s.pushWithRetry("s1", { checkout, repo: repo("stale") });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("classifies auth failures", () => {
    expect(isGitAuthFailure("HTTP 401 (board rejected the git token)")).toBe(true);
    expect(isGitAuthFailure("fatal: could not read Username: terminal prompts disabled")).toBe(true);
    expect(isGitAuthFailure("connection refused")).toBe(false);
  });

  it("the token request/answer messages round-trip the wire parsers", () => {
    expect(parseWorkerToBoardMessage({ type: "git_token_request", sessionId: "s", requestId: "r" }))
      .toEqual({ type: "git_token_request", sessionId: "s", requestId: "r" });
    expect(parseWorkerToBoardMessage({ type: "git_token_request", sessionId: "s" })).toBeNull();
    expect(parseBoardToWorkerMessage({ type: "git_token", sessionId: "s", requestId: "r", gitToken: "t" }))
      .toEqual({ type: "git_token", sessionId: "s", requestId: "r", gitToken: "t" });
    expect(parseBoardToWorkerMessage({ type: "git_token", sessionId: "s", requestId: "r", error: "no" }))
      .toEqual({ type: "git_token", sessionId: "s", requestId: "r", error: "no" });
  });
});
