/**
 * #1431 — a one-shot agent call placed on a fleet worker: the frame it sends, the host fallback,
 * the strict refusal, and the fix a worker pushes back being fast-forwarded into the board tree.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardToWorkerMessage, WorkerOneShotResult, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";

vi.mock("../services/worker-fleet.service.js", () => ({ resolveWorkerPlacement: vi.fn(), getWorkerFleet: vi.fn() }));
vi.mock("../services/git-http.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/git-http.service.js")>()),
  ensureGitHttpServer: vi.fn(async () => ({ port: 4321, issueToken: () => "scoped-token" })),
}));
vi.mock("../services/project-committer-identity.js", () => ({ resolveProjectCommitterIdentity: vi.fn(async () => undefined) }));

const { dispatchOneShotToWorker } = await import("../services/claude-oneshot-worker.service.js");
type Args = Parameters<typeof dispatchOneShotToWorker>[0];
type OneShotFrame = Extract<BoardToWorkerMessage, { type: "oneshot" }>;

const config = { command: "claude", args: ["-p"], env: { KANBAN_SESSION_ID: "x", ANTHROPIC_API_KEY: "secret" }, useShell: false, isMockAgent: false };

/** A manager whose worker answers each request with the given frames (after the send returns). */
function fakeManager(answer: (req: OneShotFrame) => WorkerOneShotResult[] | "silent") {
  const messageListeners = new Set<(id: string, m: WorkerToBoardMessage) => void>();
  const sent: BoardToWorkerMessage[] = [];
  const manager = {
    onMessage: (l: (id: string, m: WorkerToBoardMessage) => void) => { messageListeners.add(l); return () => messageListeners.delete(l); },
    onDisconnect: () => () => undefined,
    send: (_workerId: string, message: BoardToWorkerMessage) => {
      sent.push(message);
      if (message.type !== "oneshot") return true;
      const frames = answer(message);
      if (frames !== "silent") {
        setTimeout(() => { for (const result of frames) for (const l of messageListeners) l("w1", { type: "oneshot_result", result }); }, 0);
      }
      return true;
    },
  };
  return { manager: manager as unknown as NonNullable<Args["manager"]>, sent };
}

const remote = (extra: Record<string, unknown> = {}) =>
  vi.fn(async () => ({ kind: "remote" as const, workerId: "w1", strict: false, sharesFilesystem: false, ...extra }));

function base(over: Partial<Args>): Args {
  return {
    database: {} as Args["database"], projectId: "proj", providerName: "claude", config: config as unknown as Args["config"],
    prompt: "enhance this", timeoutMs: 5000, allowEdits: false, explicitCommand: false, ackTimeoutMs: 50, ...over,
  };
}

describe("dispatchOneShotToWorker", () => {
  it("runs a repo-less prompt on the chosen worker and returns its text", async () => {
    const { manager, sent } = fakeManager((req) => [
      { requestId: req.requestId, phase: "accepted" },
      { requestId: req.requestId, phase: "done", ok: true, text: "enhanced" },
    ]);
    const out = await dispatchOneShotToWorker(base({ manager, place: remote() as unknown as Args["place"] }));
    expect(out).toEqual({ handled: true, text: "enhanced", worker: "w1" });
    const frame = sent[0] as OneShotFrame;
    expect(frame.job.prompt).toBe("enhance this");
    expect(frame.job.intent).toMatchObject({ provider: "claude", program: "claude" });
    expect(frame.repo).toBeUndefined();
    // Decision 012: no credential-shaped env crosses to the worker.
    expect(frame.job.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("falls back to the host when the placement says host", async () => {
    const place = vi.fn(async () => ({ kind: "host" as const, reason: { id: "dispatch_opt_in" as const, detail: "not enabled" } }));
    expect(await dispatchOneShotToWorker(base({ place: place as unknown as Args["place"] }))).toMatchObject({ handled: false });
  });

  it("falls back to the host when the worker never acknowledges (a build that predates the frame)", async () => {
    const { manager } = fakeManager(() => "silent");
    expect(await dispatchOneShotToWorker(base({ manager, place: remote() as unknown as Args["place"] }))).toMatchObject({ handled: false });
  });

  it("refuses instead of running on the host when worker dispatch is strict", async () => {
    const { manager } = fakeManager(() => "silent");
    await expect(dispatchOneShotToWorker(base({ manager, place: remote({ strict: true }) as unknown as Args["place"] })))
      .rejects.toMatchObject({ code: "NO_AVAILABLE_WORKER" });
  });

  it("re-places a job that could not launch on the worker, but not one that ran and failed", async () => {
    const launchFailed = fakeManager((req) => [
      { requestId: req.requestId, phase: "accepted" },
      { requestId: req.requestId, phase: "done", ok: false, launchFailed: true, error: "unknown profile" },
    ]);
    expect(await dispatchOneShotToWorker(base({ manager: launchFailed.manager, place: remote() as unknown as Args["place"] })))
      .toMatchObject({ handled: false });
    const ranAndFailed = fakeManager((req) => [
      { requestId: req.requestId, phase: "accepted" },
      { requestId: req.requestId, phase: "done", ok: false, error: "exited 1" },
    ]);
    await expect(dispatchOneShotToWorker(base({ manager: ranAndFailed.manager, place: remote() as unknown as Args["place"] })))
      .rejects.toThrow(/one-shot failed: exited 1/);
  });

  it("keeps a prompt that needs a working directory, or an edit with no repo context, on the host", async () => {
    const place = remote();
    expect(await dispatchOneShotToWorker(base({ cwd: "/somewhere", place: place as unknown as Args["place"] }))).toMatchObject({ handled: false });
    expect(await dispatchOneShotToWorker(base({ allowEdits: true, place: place as unknown as Args["place"] }))).toMatchObject({ handled: false });
    expect(place).not.toHaveBeenCalled();
  });
});

describe("dispatchOneShotToWorker with repo context", () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "kanban-oneshot-svc-"));
    await gitExecOrThrow(["init", "-b", "master"], { cwd: repo });
    await gitExecOrThrow(["config", "user.email", "t@example.com"], { cwd: repo });
    await gitExecOrThrow(["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "one\n");
    await gitExecOrThrow(["add", "-A"], { cwd: repo });
    await gitExecOrThrow(["commit", "-m", "base"], { cwd: repo });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("pins the tree to a temporary branch, ships git transport, and fast-forwards the worker fix", async () => {
    // The worker's commit: a child of HEAD on a side branch, reachable in the same object store.
    await gitExecOrThrow(["checkout", "-q", "-b", "side"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "two\n");
    await gitExecOrThrow(["commit", "-qam", "fix"], { cwd: repo });
    const fixSha = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
    await gitExecOrThrow(["checkout", "-q", "master"], { cwd: repo });
    const { manager, sent } = fakeManager((req) => [
      { requestId: req.requestId, phase: "accepted" },
      { requestId: req.requestId, phase: "done", ok: true, text: "fixed", pushedSha: fixSha },
    ]);
    const place = vi.fn(async (p: { branch?: string }) => ({
      kind: "remote" as const, workerId: "w1", strict: true, sharesFilesystem: false,
      repo: { projectId: "proj", repoPath: repo, branch: p.branch as string, baseBranch: "master" },
    }));

    const out = await dispatchOneShotToWorker(base({
      manager, place: place as unknown as Args["place"], cwd: repo, allowEdits: true, repo: { repoPath: repo, baseBranch: "master" },
    }));

    expect(out).toEqual({ handled: true, text: "fixed", worker: "w1" });
    const frame = sent[0] as OneShotFrame;
    expect(frame.job.allowEdits).toBe(true);
    expect(frame.repo).toMatchObject({ gitPort: 4321, gitToken: "scoped-token", baseBranch: "master" });
    expect(frame.repo?.branch).toMatch(/^kanban-oneshot\//);
    expect(place.mock.calls[0]![0]).toMatchObject({ oneShot: true, branch: frame.repo?.branch });
    // The board tree now has the fix, and the temporary branch is gone.
    expect((await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim()).toBe(fixSha);
    expect(execSucceeded(await gitExec(["rev-parse", "--verify", `refs/heads/${frame.repo?.branch}`], { cwd: repo }))).toBe(false);
  });

  it("#1609: keeps a fix it cannot fast-forward on kanban/train-fix/<label> and names it", async () => {
    await gitExecOrThrow(["checkout", "-q", "-b", "side"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "two\n");
    await gitExecOrThrow(["commit", "-qam", "fix"], { cwd: repo });
    const fixSha = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
    await gitExecOrThrow(["checkout", "-q", "master"], { cwd: repo });
    // The train tree moved on (a cancel / reset): the fix is no longer a fast-forward.
    writeFileSync(join(repo, "b.txt"), "other\n");
    await gitExecOrThrow(["add", "-A"], { cwd: repo });
    await gitExecOrThrow(["commit", "-qm", "diverge"], { cwd: repo });
    const { manager } = fakeManager((req) => [
      { requestId: req.requestId, phase: "accepted" },
      { requestId: req.requestId, phase: "done", ok: true, text: "fixed", pushedSha: fixSha },
    ]);
    const place = vi.fn(async (p: { branch?: string }) => ({
      kind: "remote" as const, workerId: "w1", strict: true, sharesFilesystem: false,
      repo: { projectId: "proj", repoPath: repo, branch: p.branch as string, baseBranch: "master" },
    }));

    await expect(dispatchOneShotToWorker(base({
      manager, place: place as unknown as Args["place"], cwd: repo, allowEdits: true,
      repo: { repoPath: repo, baseBranch: "master", keepFixAs: "2026-10-18-07" },
    }))).rejects.toThrow(/kept on kanban\/train-fix\/2026-10-18-07/);
    expect((await gitExecOrThrow(["rev-parse", "refs/heads/kanban/train-fix/2026-10-18-07"], { cwd: repo })).trim()).toBe(fixSha);
  });

  it("stays on the host (and leaves no branch behind) when the placement is the host", async () => {
    const place = vi.fn(async () => ({ kind: "host" as const }));
    const out = await dispatchOneShotToWorker(base({ place: place as unknown as Args["place"], cwd: repo, repo: { repoPath: repo } }));
    expect(out).toMatchObject({ handled: false });
    const branches = await gitExecOrThrow(["branch", "--list", "kanban-oneshot/*"], { cwd: repo });
    expect(branches.trim()).toBe("");
  });
});
