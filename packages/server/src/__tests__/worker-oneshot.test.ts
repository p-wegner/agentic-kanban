/**
 * #1431 — the worker side of a one-shot: it acknowledges, runs the provider command on the prompt,
 * and for an editing job pushes what the agent committed to the request's incoming ref.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import type { WorkerOneShotRequest, WorkerOneShotResult, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { createWorkerOneShotRunner, type WorkerOneShotOptions } from "../worker/worker-oneshot.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kanban-oneshot-worker-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in provider CLI: `node agent.js`, driven by the prompt on stdin. */
function agentScript(body: string): string {
  const path = join(dir, "agent.js");
  writeFileSync(path, `let input = "";\nprocess.stdin.on("data", (c) => (input += c));\nprocess.stdin.on("end", () => {\n${body}\n});\n`);
  return path;
}

function request(script: string, over: Partial<WorkerOneShotRequest["job"]> = {}, repo?: WorkerOneShotRequest["repo"]): WorkerOneShotRequest {
  return {
    type: "oneshot", requestId: "r1", ...(repo ? { repo } : {}),
    job: { command: process.execPath, args: [script], env: {}, prompt: "the prompt", timeoutMs: 10_000, allowEdits: false, ...over },
  };
}

function run(req: WorkerOneShotRequest, opts: Partial<WorkerOneShotOptions> = {}): Promise<WorkerOneShotResult[]> {
  return new Promise((resolve) => {
    const frames: WorkerOneShotResult[] = [];
    const runner = createWorkerOneShotRunner({
      send: (m: WorkerToBoardMessage) => {
        if (m.type !== "oneshot_result") return;
        frames.push(m.result);
        if (m.result.phase === "done") resolve(frames);
      },
      profileHome: dir,
      ...opts,
    });
    expect(runner.handle(req)).toBe(true);
  });
}

describe("worker one-shot", () => {
  it("ignores every frame that is not a oneshot request", () => {
    const runner = createWorkerOneShotRunner({ send: () => undefined });
    expect(runner.handle({ type: "stop", sessionId: "s" })).toBe(false);
  });

  it("acknowledges, then answers with the agent's stdout (no checkout needed)", async () => {
    const frames = await run(request(agentScript(`process.stdout.write("echo:" + input.trim());`)));
    expect(frames.map((f) => f.phase)).toEqual(["accepted", "done"]);
    expect(frames[1]).toMatchObject({ ok: true, text: "echo:the prompt" });
  });

  it("reports a non-zero exit as a run that failed, not as a launch failure", async () => {
    const frames = await run(request(agentScript(`process.stderr.write("boom\\n"); process.exit(3);`)));
    expect(frames[1]).toMatchObject({ ok: false });
    expect(frames[1]!.launchFailed).toBeUndefined();
    expect(frames[1]!.error).toMatch(/exited 3.*boom/s);
  });

  it("kills an agent that outlives its timeout and says so", async () => {
    const frames = await run(request(agentScript(`setTimeout(() => {}, 60000);`), { timeoutMs: 300 }));
    expect(frames[1]).toMatchObject({ ok: false });
    expect(frames[1]!.error).toMatch(/timed out after 300ms/);
  });

  it("refuses a profile this machine does not have as a launch failure the board can re-place", async () => {
    const req = request(agentScript(`process.stdout.write("x");`), { intent: { provider: "claude", program: "claude", profile: "nope" } });
    const frames = await run(req);
    expect(frames[1]).toMatchObject({ ok: false, launchFailed: true });
  });

  it("takes no work while draining", async () => {
    const frames = await run(request(agentScript(`process.stdout.write("x");`)), { isDraining: () => true });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ phase: "done", ok: false, launchFailed: true });
  });
});

describe("worker one-shot with a checkout", () => {
  let checkoutDir: string;
  const transport = { projectId: "p", gitPort: 1, gitToken: "t", branch: "kanban-oneshot/x", baseBranch: "master", incomingRef: "refs/kanban/incoming/kanban-oneshot/x" };

  beforeEach(async () => {
    checkoutDir = join(dir, "checkout");
    await gitExecOrThrow(["init", "-b", "master", checkoutDir], { cwd: dir });
    await gitExecOrThrow(["config", "user.email", "t@example.com"], { cwd: checkoutDir });
    await gitExecOrThrow(["config", "user.name", "t"], { cwd: checkoutDir });
    writeFileSync(join(checkoutDir, "a.txt"), "one\n");
    await gitExecOrThrow(["add", "-A"], { cwd: checkoutDir });
    await gitExecOrThrow(["commit", "-m", "base"], { cwd: checkoutDir });
  });

  const repoOps = () => ({
    provision: vi.fn(async () => ({ cwd: checkoutDir, cacheDir: join(dir, "cache") })),
    push: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => undefined),
  });

  it("runs in the checkout, commits what the agent left and pushes it to the incoming ref", async () => {
    const ops = repoOps();
    const script = agentScript(`require("fs").writeFileSync("a.txt", "two\\n"); process.stdout.write("fixed");`);
    const frames = await run(request(script, { allowEdits: true }, transport), { repoOps: ops, boardUrl: "http://board:1" });
    expect(frames[1]).toMatchObject({ ok: true, text: "fixed" });
    const head = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: checkoutDir })).trim();
    expect(frames[1]!.pushedSha).toBe(head);
    expect(readFileSync(join(checkoutDir, "a.txt"), "utf8")).toBe("two\n");
    expect(ops.push).toHaveBeenCalledWith("http://board:1", transport, expect.objectContaining({ cwd: checkoutDir }));
    expect(ops.cleanup).toHaveBeenCalled();
  });

  it("leaves a lockfile the agent did not author out of the commit (#1483)", async () => {
    const ops = repoOps();
    const script = agentScript(`const fs = require("fs"); fs.writeFileSync("a.txt", "two\\n"); fs.writeFileSync("pnpm-lock.yaml", "drift\\n"); process.stdout.write("fixed");`);
    const frames = await run(request(script, { allowEdits: true }, transport), { repoOps: ops, boardUrl: "http://board:1" });
    expect(frames[1]).toMatchObject({ ok: true });
    const files = (await gitExecOrThrow(["show", "--name-only", "--format=", "HEAD"], { cwd: checkoutDir })).trim().split(/\r?\n/);
    expect(files).toEqual(["a.txt"]);
  });

  it("pushes nothing when the only leftover is a lockfile (#1483)", async () => {
    const ops = repoOps();
    const script = agentScript(`require("fs").writeFileSync("pnpm-lock.yaml", "drift\\n"); process.stdout.write("x");`);
    const frames = await run(request(script, { allowEdits: true }, transport), { repoOps: ops, boardUrl: "http://board:1" });
    expect(frames[1]!.pushedSha).toBeUndefined();
    expect(ops.push).not.toHaveBeenCalled();
  });

  it("pushes nothing when the editing agent changed nothing", async () => {
    const ops = repoOps();
    const frames = await run(request(agentScript(`process.stdout.write("no change");`), { allowEdits: true }, transport), { repoOps: ops, boardUrl: "http://board:1" });
    expect(frames[1]).toMatchObject({ ok: true });
    expect(frames[1]!.pushedSha).toBeUndefined();
    expect(ops.push).not.toHaveBeenCalled();
  });

  it("never pushes for a read-only job, even if the agent touched a file", async () => {
    const ops = repoOps();
    const script = agentScript(`require("fs").writeFileSync("a.txt", "scribble\\n"); process.stdout.write("review");`);
    const frames = await run(request(script, { allowEdits: false }, transport), { repoOps: ops, boardUrl: "http://board:1" });
    expect(frames[1]).toMatchObject({ ok: true, text: "review" });
    expect(ops.push).not.toHaveBeenCalled();
  });

  it("is a launch failure when the checkout cannot be provisioned", async () => {
    const ops = { ...repoOps(), provision: vi.fn(async () => { throw new Error("clone failed"); }) };
    const frames = await run(request(agentScript(`process.stdout.write("x");`), {}, transport), { repoOps: ops, boardUrl: "http://board:1" });
    expect(frames[1]).toMatchObject({ ok: false, launchFailed: true });
    expect(frames[1]!.error).toMatch(/clone failed/);
  });
});
