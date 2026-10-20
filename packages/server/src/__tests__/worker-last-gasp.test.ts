import { describe, expect, it } from "vitest";
import { installLastGasp, setLastGaspContext } from "../worker/worker-last-gasp.js";
import { resolveDoctorStateFile } from "../worker/worker-state-discovery.js";

function fakeProc() {
  const handlers = new Map<string, (arg: unknown) => void>();
  return {
    handlers,
    pid: 42,
    memoryUsage: () => ({ rss: 200 * 1048576, heapUsed: 50 * 1048576 }) as NodeJS.MemoryUsage,
    on(ev: string, fn: (arg: unknown) => void) { handlers.set(ev, fn); return this; },
  };
}

describe("worker last gasp (#1661)", () => {
  it("writes exit code, jobs and memory on exit", () => {
    const proc = fakeProc();
    const lines: string[] = [];
    installLastGasp({ proc: proc as never, nowMs: 0, append: (_f, t) => lines.push(t) });
    setLastGaspContext({ logFile: "worker.log", describeJobs: () => ["session:abc"] });
    proc.handlers.get("exit")!(7);
    expect(lines[0]).toContain("LAST-GASP exit code=7");
    expect(lines[0]).toContain("jobs=session:abc");
    expect(lines[0]).toContain("rss=200MB");
    setLastGaspContext(null);
  });

  it("writes a final line for an unhandled rejection", () => {
    const proc = fakeProc();
    const lines: string[] = [];
    installLastGasp({ proc: proc as never, append: (_f, t) => lines.push(t) });
    setLastGaspContext({ logFile: "worker.log" });
    proc.handlers.get("unhandledRejection")!(new Error("boom"));
    expect(lines[0]).toContain("unhandledRejection");
    expect(lines[0]).toContain("boom");
    setLastGaspContext(null);
  });
});

describe("resolveDoctorStateFile (#1661)", () => {
  const has = (set: string[]) => (f: string) => set.includes(f);
  it("explicit flag wins", () => {
    expect(resolveDoctorStateFile("x.json", "d.json", ["c.json"], has(["c.json"]))).toEqual({ stateFile: "x.json", source: "flag" });
  });
  it("keeps the default when it holds a pairing", () => {
    expect(resolveDoctorStateFile(undefined, "d.json", ["c.json"], has(["d.json", "c.json"])).source).toBe("default");
  });
  it("discovers the daemon's state when the default has none", () => {
    expect(resolveDoctorStateFile(undefined, "d.json", ["c.json"], has(["c.json"]))).toEqual({ stateFile: "c.json", source: "discovered" });
  });
  it("falls back to the default when nothing has a pairing", () => {
    expect(resolveDoctorStateFile(undefined, "d.json", ["c.json"], has([]))).toEqual({ stateFile: "d.json", source: "default-fallback" });
  });
});
