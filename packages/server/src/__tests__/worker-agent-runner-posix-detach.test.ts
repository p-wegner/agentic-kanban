import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { WorkerToBoardMessage, WorkerLaunchSpec } from "@agentic-kanban/shared/lib/worker-protocol";

/**
 * #841 — `worker-agent-runner.assign()` spawns with `detached: true`, POSIX-only, whenever
 * the resolved launch goes through a shell (`launch.useShell`). This is what makes
 * `group: true` in `stop()` (#836) actually reach the child's process group on POSIX,
 * closing the residual #833-shape gap: a `sh -c "a | b"` worker agent, stopped, used to
 * leave `sh` dead and the pipeline's real work still running.
 *
 * ## What runs where
 *
 * - The `spawn()` argument assertions (first describe) are platform-identical: `spawn` is
 *   mocked, so they pin the OPTIONS this runner passes for a given `process.platform`,
 *   without actually spawning anything OS-specific.
 * - The real pipeline-kill test (second describe) is gated to `process.platform !== "win32"`
 *   and SKIPPED (not failed) on Windows — it is the actual Linux evidence #841 asks for,
 *   riding on the same CI run as #834.
 */

const spawnMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => {
    const { EventEmitter } = require("node:events") as typeof import("node:events");
    const fake = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
    Object.assign(fake, {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn(), write: vi.fn(), destroyed: false }),
      kill: vi.fn(() => true),
    });
    return fake;
  }),
);

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined),
) as Record<string, string>;

function nodeSpec(script: string, overrides?: Partial<WorkerLaunchSpec>): WorkerLaunchSpec {
  return {
    command: process.execPath,
    args: ["-e", script],
    env: cleanEnv,
    cwd: tmpdir(),
    stdinPrompt: "",
    ...overrides,
  };
}

function collector(workerAgentRunner: typeof import("../worker/worker-agent-runner.js")) {
  const messages: WorkerToBoardMessage[] = [];
  const workRoot = mkdtempSync(join(tmpdir(), "ak-worker-root-"));
  const runner = workerAgentRunner.createWorkerAgentRunner((msg) => messages.push(msg), { workRoot });
  const eventsOf = (sessionId: string) =>
    messages.flatMap((m) => (m.type === "event" && m.event.sessionId === sessionId ? [m.event] : []));
  const exitOf = (sessionId: string) => eventsOf(sessionId).find((e) => e.type === "exit");
  return { messages, runner, eventsOf, exitOf };
}

describe("assign() passes detached: true on POSIX only, and only for a shell launch (#841)", () => {
  beforeEach(() => {
    spawnMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function assignAndCaptureOptions(platform: NodeJS.Platform, spec: Partial<WorkerLaunchSpec>) {
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn: spawnMock };
    });
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      const workerAgentRunner = await import("../worker/worker-agent-runner.js");
      const { runner } = collector(workerAgentRunner);
      runner.assign("s1", nodeSpec("process.exit(0)", spec));
      expect(spawnMock).toHaveBeenCalledTimes(1);
      return spawnMock.mock.calls[0]![2] as Record<string, unknown>;
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    }
  }

  it("detaches a POSIX shell launch (useShell: true)", async () => {
    const options = await assignAndCaptureOptions("linux", { useShell: true });
    expect(options.detached).toBe(true);
    expect(options.shell).toBe(true);
  });

  it("does NOT detach a POSIX non-shell launch (useShell: false) — nothing to detach from", async () => {
    const options = await assignAndCaptureOptions("linux", { useShell: false });
    expect(options.detached).toBe(false);
  });

  it("does NOT detach on win32 even for a shell launch — measured hang", async () => {
    const options = await assignAndCaptureOptions("win32", { useShell: true });
    expect(options.detached).toBe(false);
    expect(options.shell).toBe(true);
  });
});

describe("stopping a POSIX shell agent kills the whole pipeline, not just the shell (#841, real evidence)", () => {
  const isPosix = process.platform !== "win32";

  it.skipIf(!isPosix)("SIGTERM on stop() reaches a child spawned by a pipeline's sh -c", async () => {
    const { createWorkerAgentRunner } = await import("../worker/worker-agent-runner.js");
    const { runner, exitOf } = collector({ createWorkerAgentRunner } as never);

    // A marker file is written by the SECOND stage of a pipeline. If `sh` dies but the
    // pipeline's real work keeps running, the file appears anyway — the #833 shape this
    // ticket closes. If the whole process group dies, the file is never written.
    const markerDir = mkdtempSync(join(tmpdir(), "ak-detach-marker-"));
    const marker = join(markerDir, "reached");
    const script =
      `node -e "setTimeout(()=>{},20000)" | ` +
      `node -e "process.on('SIGTERM',()=>process.exit(0));setTimeout(()=>require('fs').writeFileSync('${marker.replace(/\\/g, "\\\\")}','x'),4000)"`;

    runner.assign("s1", {
      command: script,
      args: [],
      env: cleanEnv,
      cwd: tmpdir(),
      stdinPrompt: "",
      useShell: true,
      keepStdinOpen: true,
    });
    await vi.waitFor(() => expect(runner.runningSessionIds()).toEqual(["s1"]));

    expect(runner.stop("s1")).toBe(true);
    await vi.waitFor(() => expect(exitOf("s1")).toBeTruthy(), { timeout: 15000 });

    // Give the second pipeline stage the time it would have needed to write the marker had
    // it survived the stop.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  }, 20000);
});
