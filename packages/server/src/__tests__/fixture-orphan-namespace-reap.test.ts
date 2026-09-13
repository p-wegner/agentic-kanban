import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/process-exec.js", () => ({
  listOsProcesses: vi.fn(async () => []),
  taskkillTree: vi.fn(async () => {}),
}));

import { reapOrphanedFixtureServers } from "./helpers/reap-fixture-child-servers.js";
import { listOsProcesses, taskkillTree } from "../services/process-exec.js";

/** Build an OS process record; `ppid` defaults to a pid that is never in the list. */
function proc(pid: number, commandLine: string, ppid = 99999) {
  return { pid, ppid, name: "node.exe", commandLine };
}

/**
 * #1121 — three real fixtures (`ak-setup-script-tree-*`, `ak-verify-gate-test-*`,
 * `ak-mid-session-fixture-*`) leaked orphaned processes for days because the sweep only ever
 * recognised a `serve.mjs`-family command line. None of these fixtures spawn a `serve.mjs`, so
 * their orphans were invisible to `reapOrphanedFixtureServers` and their dirs never released the
 * handle that `reapStaleFixtureTempDirs` needs to remove them.
 */
describe("reapOrphanedFixtureServers — namespace-matched orphans (#1121)", () => {
  beforeEach(() => {
    vi.mocked(taskkillTree).mockClear();
    vi.mocked(listOsProcesses).mockReset();
  });

  it("kills an orphan whose command line references a recognised fixture namespace dir, even with an unmarked script name", async () => {
    const namespaceDir = "C:\\Users\\tester\\AppData\\Local\\Temp\\ak-mid-session-fixture-abc123";
    vi.mocked(listOsProcesses).mockResolvedValue([
      proc(1000, `node ${namespaceDir}\\mock-agent-live-xyz.cjs`, 4242),
    ]);

    const killed = await reapOrphanedFixtureServers([namespaceDir]);

    expect(killed).toBe(1);
    expect(vi.mocked(taskkillTree)).toHaveBeenCalledWith(1000);
  });

  it("leaves a namespace-dir process alone when its parent is still alive", async () => {
    const namespaceDir = "C:\\Temp\\ak-setup-script-tree-def456";
    vi.mocked(listOsProcesses).mockResolvedValue([
      proc(2000, "node runner.js", 1),
      proc(2001, `node ${namespaceDir}\\child.js`, 2000),
    ]);

    const killed = await reapOrphanedFixtureServers([namespaceDir]);

    expect(killed).toBe(0);
    expect(vi.mocked(taskkillTree)).not.toHaveBeenCalled();
  });

  it("does not match a process outside any given namespace dir", async () => {
    vi.mocked(listOsProcesses).mockResolvedValue([
      proc(3000, "node C:\\Temp\\unrelated-dir\\worker.js", 4242),
    ]);

    const killed = await reapOrphanedFixtureServers(["C:\\Temp\\ak-mid-session-fixture-abc123"]);

    expect(killed).toBe(0);
    expect(vi.mocked(taskkillTree)).not.toHaveBeenCalled();
  });

  it("still reaps the known serve.mjs marker with no namespace dirs supplied (back-compat, #352)", async () => {
    vi.mocked(listOsProcesses).mockResolvedValue([
      proc(4000, "node C:/plugins/foo/tools/plugin/serve.mjs --port 7001", 4242),
    ]);

    expect(await reapOrphanedFixtureServers()).toBe(1);
  });

  it("treats ppid 0 as unknown rather than orphaned, even inside a matched namespace", async () => {
    const namespaceDir = "C:\\Temp\\ak-verify-gate-test-ghi789";
    vi.mocked(listOsProcesses).mockResolvedValue([
      proc(5000, `node ${namespaceDir}\\listener-worker.js`, 0),
    ]);

    expect(await reapOrphanedFixtureServers([namespaceDir])).toBe(0);
    expect(vi.mocked(taskkillTree)).not.toHaveBeenCalled();
  });

  it("never reaps itself", async () => {
    const namespaceDir = "C:\\Temp\\ak-mid-session-fixture-self";
    vi.mocked(listOsProcesses).mockResolvedValue([
      proc(process.pid, `node ${namespaceDir}\\mock-agent-live-self.cjs`, 4242),
    ]);

    expect(await reapOrphanedFixtureServers([namespaceDir])).toBe(0);
    expect(vi.mocked(taskkillTree)).not.toHaveBeenCalled();
  });

  it("returns 0 and does not throw when process enumeration fails", async () => {
    vi.mocked(listOsProcesses).mockRejectedValue(new Error("wmic unavailable"));

    await expect(reapOrphanedFixtureServers(["C:\\Temp\\ak-anything"])).resolves.toBe(0);
    expect(vi.mocked(taskkillTree)).not.toHaveBeenCalled();
  });
});
