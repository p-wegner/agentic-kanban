// @gate:always-run when:scripts/promote-boot-diagnostics.mjs,scripts/promote.mjs
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs script, no types
import * as d from "../../../../scripts/promote-boot-diagnostics.mjs";

describe("promote boot diagnostics (#1504)", () => {
  it("extends the boot budget only when free RAM is below the floor", () => {
    expect(d.chooseBootTimeoutMs(1 * 1024 ** 3)).toBe(d.EXTENDED_BOOT_TIMEOUT_MS);
    expect(d.chooseBootTimeoutMs(8 * 1024 ** 3)).toBe(d.BASE_BOOT_TIMEOUT_MS);
  });

  it("reads only the log written since the spawn offset", () => {
    const p = join(mkdtempSync(join(tmpdir(), "ak-boot-diag-")), "board.log");
    writeFileSync(p, "old line\nnew line\n");
    expect(d.readLogTail(p, 9)).toBe("new line\n");
    expect(d.readLogTail(join(tmpdir(), "ak-missing-boot.log"), 0)).toBe("");
  });

  it("reports alive, exited and silent states", () => {
    const base = { pid: 6748, elapsedMs: 180_000, timeoutMs: 180_000, memory: { freeBytes: 1.8 * 1024 ** 3, totalBytes: 44 * 1024 ** 3 } };
    const alive = d.formatBootDiagnostics({ ...base, alive: true, exit: null, logTail: "" });
    expect(alive).toContain("ALIVE");
    expect(alive).toContain("NOTHING");
    const dead = d.formatBootDiagnostics({ ...base, alive: false, exit: { code: 1, signal: null }, logTail: "boom" });
    expect(dead).toContain("EXITED (code 1");
    expect(dead).toContain("boom");
  });

  it("isPidAlive treats ESRCH as dead", () => {
    expect(d.isPidAlive(1, () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); })).toBe(false);
    expect(d.isPidAlive(1, () => true)).toBe(true);
  });
});
