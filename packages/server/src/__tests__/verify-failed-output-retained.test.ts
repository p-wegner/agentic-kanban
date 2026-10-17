import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistFailedWorkerLog } from "../services/verify-worker-runner.service.js";
import { createFileVerifyResultStore, VERIFY_FAILED_LOG_KEEP } from "../worker/worker-verify-runner.js";

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "ak-verify-retained-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("persistFailedWorkerLog (#1571)", () => {
  it("a failed result followed by a retry leaves two readable logs", () => {
    const dir = tmp();
    const a = persistFailedWorkerLog("train-gate", "job-1", "\u001b[31mfirst run output\u001b[0m\n", dir);
    const b = persistFailedWorkerLog("train-gate", "job-2", "second run output\n", dir);
    expect(a.logPath).not.toBe(b.logPath);
    expect(readFileSync(a.logPath!, "utf8")).toBe("first run output\n");
    expect(readFileSync(b.logPath!, "utf8")).toBe("second run output\n");
  });

  it("keeps only the last 64 KB", () => {
    const dir = tmp();
    const { logPath } = persistFailedWorkerLog("train-gate", "j", "x".repeat(200_000) + "END", dir);
    const text = readFileSync(logPath!, "utf8");
    expect(text.length).toBe(64 * 1024);
    expect(text.endsWith("END")).toBe(true);
  });

  it("returns the last 40 lines for the evidence row", () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const { tailLines } = persistFailedWorkerLog("train-gate", "j", log, tmp());
    const lines = tailLines.split("\n");
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe("line 60");
    expect(lines[39]).toBe("line 99");
  });
});

describe("worker failed-run log retention (#1571)", () => {
  it("keeps a bounded number of failed logs", () => {
    const root = tmp();
    const store = createFileVerifyResultStore(root);
    for (let i = 0; i < VERIFY_FAILED_LOG_KEEP + 3; i++) store.saveFailedLog!(`job-${i}`, `out ${i}`);
    const written = Array.from({ length: VERIFY_FAILED_LOG_KEEP + 3 }, (_, i) => join(root, "verify-results-retained", `job-${i}.log`));
    expect(written.filter((f) => existsSync(f))).toHaveLength(VERIFY_FAILED_LOG_KEEP);
  });

  it("is not removed with the verdict", () => {
    const root = tmp();
    const store = createFileVerifyResultStore(root);
    store.saveFailedLog!("job-x", "boom");
    store.remove("job-x");
    expect(readFileSync(join(root, "verify-results-retained", "job-x.log"), "utf8")).toBe("boom");
  });
});
