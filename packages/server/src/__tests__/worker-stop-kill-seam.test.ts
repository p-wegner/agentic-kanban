import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import type { WorkerToBoardMessage, WorkerLaunchSpec } from "@agentic-kanban/shared/lib/worker-protocol";

/**
 * #836 — the worker's stop path goes through the ONE kill seam, not a private platform branch.
 *
 * `worker-agent-runner.stop()` had the identical pre-#833 shape the host had: a
 * `process.platform === "win32"` arm spawning `taskkill /T /F`, and a POSIX arm calling
 * `proc.kill("SIGTERM")` on the bare pid. That branch is why the behaviour was untestable
 * on either platform in turn — a Windows box can never reach the POSIX arm, and a Linux box
 * can never reach the Windows one, so whichever half was broken stayed green.
 *
 * ## What these tests can and cannot prove
 *
 * They run on Windows.
 *
 * - **Platform-identical (mocked seam):** the first describe. `killProcessTree` is mocked,
 *   so the assertions are the same on Windows and Linux — a stop path that still branched on
 *   `process.platform` would take an unmocked path on one of them and fail there. That is
 *   the property the fix buys, and the only one a single-platform box can buy.
 * - **Real, this platform only:** the second describe spawns a REAL child and stops it. It
 *   proves the seam actually terminates a process **on Windows** (`taskkill /T /F`). It is
 *   NOT evidence for POSIX.
 * - **Not claimed anywhere:** that SIGTERM lands on a Linux process or process group.
 *   Nothing here can observe that; #834 is the Linux CI run that would.
 *
 * ## The honest gap this suite pins, deliberately
 *
 * `group: true` is currently INERT on POSIX for this runner, because `assign` spawns
 * WITHOUT `detached: true` — so the child leads no process group, `-pid` is ESRCH, and the
 * seam falls back to the bare pid. That is the pre-#833 reach, not a regression, and the
 * last test below pins exactly that so nobody reads the option as a closed gap. Detaching
 * (POSIX-only) is the remaining half — tracked as #841; see the rationale block above `assign`'s spawn for why
 * it was not done here — including the measured win32 `detached` + `shell` hang.
 */

const { killProcessTree } = vi.hoisted(() => ({
  killProcessTree: vi.fn(async (_pid: number, _options?: unknown) => {}),
}));

vi.mock("../services/process-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/process-exec.js")>();
  return { ...actual, killProcessTree, taskkillTree: vi.fn(async () => {}) };
});

const { createWorkerAgentRunner } = await import("../worker/worker-agent-runner.js");

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

function collector() {
  const messages: WorkerToBoardMessage[] = [];
  const runner = createWorkerAgentRunner((msg) => messages.push(msg));
  const eventsOf = (sessionId: string) =>
    messages.flatMap((m) => (m.type === "event" && m.event.sessionId === sessionId ? [m.event] : []));
  const exitOf = (sessionId: string) => eventsOf(sessionId).find((e) => e.type === "exit");
  return { messages, runner, eventsOf, exitOf };
}

/**
 * A child that outlives the test but reaps itself, so a MOCKED kill (which never actually
 * signals anything) cannot leak a node process onto a shared box.
 */
const LONG_RUNNING = "setTimeout(()=>process.exit(0),20000)";

/** Every pid the runner asked the seam to kill — really killed after the mocked suite. */
const seenPids = new Set<number>();

/** What the fixed stop path must ask the seam for. */
const STOP_OPTIONS = { timeout: 5000, signal: "SIGTERM", group: true };

describe("worker stop() goes through the kill seam (#836)", () => {
  beforeEach(() => {
    killProcessTree.mockClear();
    killProcessTree.mockImplementation(async (pid) => {
      seenPids.add(pid);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // The seam was mocked, so nothing was actually killed. Do it for real now.
    const actual = await vi.importActual<typeof import("../services/process-exec.js")>(
      "../services/process-exec.js",
    );
    for (const pid of seenPids) await actual.killProcessTree(pid, { timeout: 5000 }).catch(() => {});
    seenPids.clear();
  });

  it("asks the seam for the pid, with SIGTERM preserved", async () => {
    const { runner } = collector();
    runner.assign("s1", nodeSpec(LONG_RUNNING, { keepStdinOpen: true }));
    await vi.waitFor(() => expect(runner.runningSessionIds()).toEqual(["s1"]));

    expect(runner.stop("s1")).toBe(true);

    // `signal` matters independently of reach: the seam's default is SIGKILL, and a
    // stopped agent is asked to shut down so its provider CLI can flush a transcript.
    expect(killProcessTree).toHaveBeenCalledTimes(1);
    expect(killProcessTree).toHaveBeenCalledWith(expect.any(Number), STOP_OPTIONS);

    runner.stopAll();
  });

  it("stopAll() asks for every running session", async () => {
    const { runner } = collector();
    // maxConcurrency defaults to 1, so the second session must come from a second runner.
    const second = collector();
    runner.assign("s1", nodeSpec(LONG_RUNNING, { keepStdinOpen: true }));
    second.runner.assign("s2", nodeSpec(LONG_RUNNING, { keepStdinOpen: true }));
    await vi.waitFor(() => {
      expect(runner.runningSessionIds()).toEqual(["s1"]);
      expect(second.runner.runningSessionIds()).toEqual(["s2"]);
    });

    runner.stopAll();
    second.runner.stopAll();

    expect(killProcessTree).toHaveBeenCalledTimes(2);
    for (const call of killProcessTree.mock.calls) expect(call[1]).toEqual(STOP_OPTIONS);
  });

  it("the hang watchdog stops through the same seam, not a second private branch", async () => {
    const { runner } = collector();
    runner.assign("s1", nodeSpec(LONG_RUNNING, { keepStdinOpen: true, hangTimeoutMs: 300 }));
    await vi.waitFor(() => expect(runner.runningSessionIds()).toEqual(["s1"]));

    await vi.waitFor(() => expect(killProcessTree).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(killProcessTree).toHaveBeenCalledWith(expect.any(Number), STOP_OPTIONS);

    runner.stopAll();
  });

  it("stop() on an unknown session never reaches the seam", () => {
    const { runner } = collector();
    expect(runner.stop("nope")).toBe(false);
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it("logs a kill failure but stays quiet when the process was already gone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runner } = collector();

    killProcessTree.mockRejectedValueOnce(new Error("EPERM") as never);
    runner.assign("s1", nodeSpec(LONG_RUNNING, { keepStdinOpen: true }));
    await vi.waitFor(() => expect(runner.runningSessionIds()).toEqual(["s1"]));
    runner.stop("s1");
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("kill failed"), expect.anything()),
    );

    warn.mockClear();
    killProcessTree.mockRejectedValueOnce(
      Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }) as never,
    );
    runner.stop("s1");
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();

    runner.stopAll();
  });
});

/**
 * The seam for real, on THIS platform only. On the board's Windows box that exercises
 * `taskkill /T /F` end to end; on Linux CI the same test exercises the POSIX arm (#834).
 * Either way it is the half of the story the mocked describe above cannot tell.
 */
describe("worker stop() really terminates the child on this platform (#836)", () => {
  beforeEach(() => {
    killProcessTree.mockClear();
    // Delegate to the real implementation — this test is about termination, not arguments.
    killProcessTree.mockImplementation(async (pid, options) => {
      const actual = await vi.importActual<typeof import("../services/process-exec.js")>(
        "../services/process-exec.js",
      );
      await actual.killProcessTree(pid, options as Parameters<typeof actual.killProcessTree>[1]);
    });
  });

  it("a long-running agent stopped by the runner reaches exactly one exit event", async () => {
    const { runner, eventsOf, exitOf } = collector();
    runner.assign("s1", nodeSpec(LONG_RUNNING, { keepStdinOpen: true }));
    await vi.waitFor(() => expect(runner.runningSessionIds()).toEqual(["s1"]));

    expect(runner.stop("s1")).toBe(true);
    await vi.waitFor(() => expect(exitOf("s1")).toBeTruthy(), { timeout: 15000 });
    expect(eventsOf("s1").filter((e) => e.type === "exit")).toHaveLength(1);
    expect(runner.runningSessionIds()).toEqual([]);
  });
});

/**
 * `group: true` is INERT for this runner today — pinned so the option is not misread as a
 * closed gap. `assign` spawns without `detached: true`, so the child leads no process group.
 *
 * Platform-FORCED: `process.platform` is overridden to "linux" and `process.kill` is spied,
 * so nothing is signalled. This pins the branching and the fallback ORDER — which is what a
 * non-detached child gets — not that any signal is delivered.
 */
describe("group: true falls back to the bare pid for a non-detached worker child (#836)", () => {
  const realPlatform = process.platform;
  let realKill: typeof process.kill;
  let killSpy: ReturnType<typeof vi.fn>;
  let seam: typeof import("../services/process-exec.js");

  beforeEach(async () => {
    seam = await vi.importActual<typeof import("../services/process-exec.js")>(
      "../services/process-exec.js",
    );
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    realKill = process.kill;
    killSpy = vi.fn(() => true);
    process.kill = killSpy as unknown as typeof process.kill;
  });

  afterEach(() => {
    process.kill = realKill;
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  });

  it("tries the group, then the bare pid — the pre-#833 reach, unchanged", async () => {
    killSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });

    await seam.killProcessTree(9101, { timeout: 5000, signal: "SIGTERM", group: true });

    expect(killSpy).toHaveBeenNthCalledWith(1, -9101, "SIGTERM");
    expect(killSpy).toHaveBeenNthCalledWith(2, 9101, "SIGTERM");
  });

  it("a detached child WOULD be reached by the group — what the remaining half buys", async () => {
    await seam.killProcessTree(9102, { timeout: 5000, signal: "SIGTERM", group: true });

    // No ESRCH, so the group call stands and the bare pid is never signalled. This is the
    // behaviour a POSIX-only `detached: true` in `assign` would unlock; it is asserted
    // against the seam, NOT against this runner, because this runner does not detach.
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-9102, "SIGTERM");
  });
});
