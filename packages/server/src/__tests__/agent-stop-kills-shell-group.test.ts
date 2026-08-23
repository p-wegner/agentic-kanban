import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

/**
 * #833 — stopping a session must kill the AGENT, not just the shell in front of it.
 *
 * Follow-up to #828 (`4f5f4e11c5`). Since that commit every provider ORs
 * `commandCarriesArgs(command)` into `useShell`, which is what finally let an agent
 * launched from an explicit command line (`agentCommand` / `KANBAN_AGENT_COMMAND`, every
 * mock-agent command) start on a Linux board at all. The consequence it created: on POSIX
 * the child is now `sh -c "<command>"`, and `shouldDetachAgent` detaches it — so the pid
 * the board records is the SHELL's, and that shell leads its own process group.
 *
 * `sh` `exec`s through for a single simple command, so the pid usually IS the agent. It is
 * no longer guaranteed: a pipeline, an `&&`, or a trailing redirect leaves `sh` a genuine
 * parent. Before this ticket the stop path sent SIGTERM to the bare pid — killing the
 * shell, leaving the agent running, and recording the session as stopped.
 *
 * ## What these tests can and cannot prove
 *
 * They run on Windows. Whether SIGTERM actually lands on a Linux process group is NOT
 * observable here and is not claimed anywhere below — that is CI's job (#834).
 *
 * - **Platform-identical (mocked seam):** every assertion in the first two describes. The
 *   kill seam is mocked, so the stop path is asserted to ask for the group with the right
 *   signal on whatever platform the suite runs on. That is precisely the property that was
 *   NOT true before: `killPid` branched on `process.platform` itself, so its POSIX arm
 *   called `process.kill` directly and no Windows test could ever see it.
 * - **Platform-forced (real seam, `process.platform` overridden):** the third describe
 *   exercises `killProcessTree`'s own POSIX branch with `process.kill` spied. It proves the
 *   BRANCHING and the ESRCH fallback ordering, not that a signal is delivered.
 */

// The ONE kill seam (#832), mocked. A stop path that still branched on `process.platform`
// would take an unmocked path on one of the two platforms and fail here — which is how the
// defect is meant to surface next time.
const { killProcessTree } = vi.hoisted(() => ({
  killProcessTree: vi.fn(async (_pid: number, _options?: unknown) => {}),
}));

vi.mock("../services/process-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/process-exec.js")>();
  return { ...actual, killProcessTree, taskkillTree: vi.fn(async () => {}) };
});

// Silences the audit ring (a console line + a file append per event) and takes the
// protected-pid policy out of the picture except where a test opts back into it.
const { guardProcessKill } = vi.hoisted(() => ({ guardProcessKill: vi.fn(() => true) }));
vi.mock("../services/process-guard.js", () => ({
  auditProcessEvent: vi.fn(),
  guardProcessKill,
}));

import { kill, killAll, agentState } from "../services/agent.service.js";

/** What the fixed stop path must ask the seam for. */
const STOP_OPTIONS = { timeout: 5000, signal: "SIGTERM", group: true };

describe("agent session stop kills the shell's process group (#833)", () => {
  beforeEach(() => {
    agentState.reset();
    killProcessTree.mockClear();
    killProcessTree.mockImplementation(async () => {});
    guardProcessKill.mockClear();
    guardProcessKill.mockReturnValue(true);
  });

  afterEach(() => {
    agentState.reset();
    vi.restoreAllMocks();
  });

  it("kill() asks the seam for the process GROUP, with SIGTERM preserved", () => {
    agentState.activePids.set("sess-a", 7101);

    expect(kill("sess-a")).toBe(true);

    // `group: true` is the fix: without it the seam signals the bare pid, which on POSIX
    // is `sh`, not the agent it forked. `signal` matters independently — the seam's
    // default is SIGKILL, and a stopped agent is asked to shut down, not shot.
    expect(killProcessTree).toHaveBeenCalledWith(7101, STOP_OPTIONS);
  });

  it("killAll() (shutdown path) asks for the group for every tracked session", () => {
    agentState.activePids.set("sess-b", 7102);
    agentState.activePids.set("sess-c", 7103);

    expect(killAll()).toBe(2);

    expect(killProcessTree).toHaveBeenCalledWith(7102, STOP_OPTIONS);
    expect(killProcessTree).toHaveBeenCalledWith(7103, STOP_OPTIONS);
  });

  it("still honours the protected-pid guard — it runs BEFORE the seam", () => {
    guardProcessKill.mockReturnValue(false);
    agentState.activePids.set("sess-d", 7104);

    expect(kill("sess-d")).toBe(false);

    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it("logs a kill failure instead of swallowing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    killProcessTree.mockRejectedValueOnce(new Error("EPERM") as never);
    agentState.activePids.set("sess-e", 7105);

    kill("sess-e");
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to kill pid=7105"), expect.anything());
  });

  it("stays quiet when the process was already gone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    killProcessTree.mockRejectedValueOnce(
      Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }) as never,
    );
    agentState.activePids.set("sess-f", 7106);

    kill("sess-f");
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * The seam's own POSIX branch, with `process.platform` forced. `process.kill` is spied, so
 * nothing is signalled — this pins the BRANCHING and the fallback ORDER, which is all a
 * Windows box can pin. #834 covers actual delivery on Linux.
 */
describe("killProcessTree({ group }) semantics on POSIX (#833)", () => {
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

  it("signals the negated pid — the process group — when group is set", async () => {
    await seam.killProcessTree(8201, { signal: "SIGTERM", group: true });

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-8201, "SIGTERM");
  });

  it("falls back to the bare pid when there is no such group (ESRCH)", async () => {
    killSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });

    await seam.killProcessTree(8202, { signal: "SIGTERM", group: true });

    // A child that was never detached shares OUR group, so `-pid` names no group. The
    // fallback is exactly the pre-#833 behaviour, so nothing regresses for those.
    expect(killSpy).toHaveBeenNthCalledWith(1, -8202, "SIGTERM");
    expect(killSpy).toHaveBeenNthCalledWith(2, 8202, "SIGTERM");
  });

  it("does not swallow a non-ESRCH group failure behind a bare-pid retry", async () => {
    killSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });

    await expect(seam.killProcessTree(8203, { group: true })).rejects.toThrow("EPERM");
    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("without group, reach is unchanged from #832 — the bare pid, SIGKILL by default", async () => {
    await seam.killProcessTree(8204);

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(8204, "SIGKILL");
  });
});
