import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The god-module gate must be a real merge-blocking CHECK, not just a vitest
 * assertion (arch-review #888 — a 1042-line breach merged past a red gate that
 * only lived in `test:mine`). The gate of record is the standalone
 * `scripts/check-god-modules.mjs` wired into `pnpm check:arch` + CI. This test
 * pins its two guarantees: it exits 0 on the current (clean) tree, and it exits
 * NON-ZERO when a >1000-line file appears. If either breaks, the gate is
 * decorative again.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-god-modules.mjs");

function runGate(): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" });
    return { code: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("check-god-modules.mjs — the merge-blocking god-module gate", () => {
  it("exits 0 on the current source tree (no file exceeds the ceiling)", () => {
    const { code, output } = runGate();
    expect(code, output).toBe(0);
    expect(output).toContain("god-module gate] OK");
  });

  it("exits NON-ZERO when a source file breaches the 1000-line ceiling", () => {
    const probe = join(REPO_ROOT, "packages", "shared", "src", "lib", "__gate_probe__.ts");
    // 1001 newline-separated lines → the gate's lineCount reports 1001 > 1000.
    writeFileSync(probe, "// probe\n".repeat(1001), "utf8");
    try {
      const { code, output } = runGate();
      expect(code).not.toBe(0);
      expect(output).toContain("__gate_probe__.ts");
    } finally {
      if (existsSync(probe)) rmSync(probe);
    }
  });
});
