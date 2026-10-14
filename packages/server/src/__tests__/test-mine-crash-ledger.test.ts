// @gate:always-run when:scripts/vitest-crash-ledger.mjs,scripts/test-mine.mjs
/**
 * #1485 — a vitest fork crash with zero failed tests is attributed to the file and retried once.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs script, no declarations
import CrashLedgerReporter, { LEDGER_ENV, decideCrashRetry, describeCrash } from "../../../../scripts/vitest-crash-ledger.mjs";

const CRASH = "[vitest-pool]: Worker forks emitted error: Worker exited unexpectedly";
const mod = (id: string, state = "passed") => ({ moduleId: id, state: () => state });

describe("crash ledger reporter", () => {
  it("names the in-flight and unreported files and the raw error", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-test-"));
    const file = join(dir, "ledger.json");
    process.env[LEDGER_ENV] = file;
    try {
      const r = new CrashLedgerReporter();
      for (const f of ["C:\\p\\a.test.ts", "C:\\p\\b.test.ts", "C:\\p\\c.test.ts"]) r.onTestModuleQueued(mod(f));
      r.onTestModuleStart(mod("C:\\p\\a.test.ts"));
      r.onTestModuleEnd(mod("C:\\p\\a.test.ts"));
      r.onTestModuleStart(mod("C:\\p\\b.test.ts"));
      r.onTestRunEnd([], [{ name: "Error", message: CRASH, signal: "SIGKILL" }], "failed");
      const ledger = JSON.parse(readFileSync(file, "utf8"));
      expect(ledger.inFlight).toEqual(["C:/p/b.test.ts"]);
      expect(ledger.unreported).toEqual(["C:/p/b.test.ts", "C:/p/c.test.ts"]);
      expect(ledger.failedModules).toEqual([]);
      expect(describeCrash(ledger)[0]).toContain("b.test.ts");
      expect(describeCrash(ledger)[0]).toContain("signal SIGKILL");
    } finally {
      delete process.env[LEDGER_ENV];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decideCrashRetry", () => {
  const rel = (f: string) => (f.startsWith("/p/") ? f.slice(3) : null);
  const base = { unreported: ["/p/x.test.ts"], failedModules: [] as string[], errors: [{ message: CRASH }] };

  it("retries the unreported files when the crash is the only problem", () => {
    expect(decideCrashRetry(base, rel)).toEqual({ retry: true, files: ["x.test.ts"] });
  });
  it("stays red when a test file failed", () => {
    expect(decideCrashRetry({ ...base, failedModules: ["/p/y.test.ts"] }, rel).retry).toBe(false);
  });
  it("stays red on any non-crash unhandled error", () => {
    expect(decideCrashRetry({ ...base, errors: [{ message: CRASH }, { message: "boom" }] }, rel).retry).toBe(false);
  });
  it("stays red with no ledger or nothing nameable", () => {
    expect(decideCrashRetry(null, rel).retry).toBe(false);
    expect(decideCrashRetry({ ...base, unreported: ["/other/z.test.ts"] }, rel).retry).toBe(false);
  });
});
