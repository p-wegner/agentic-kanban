// @gate:always-run — runs scripts/check-god-modules.mjs against the repo tree; imports nothing it checks (#647).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * The god-module gate must be a real merge-blocking CHECK, not just a vitest
 * assertion (arch-review #888 — a 1042-line breach merged past a red gate that
 * only lived in `test:mine`). The gate of record is the standalone
 * `scripts/check-god-modules.mjs` wired into `pnpm check:arch` + CI. This test
 * pins its two guarantees: it exits 0 on the current (clean) tree, and it exits
 * NON-ZERO when a >1000-line file appears. If either breaks, the gate is
 * decorative again.
 *
 * The breach probe is written into an ISOLATED temp tree and the gate is pointed at
 * it via `--root` (#62). The earlier version wrote a 1001-line `__gate_probe__.ts`
 * into the REAL `packages/shared/src/lib` — the same tree the parallel arch gates
 * (git-exec-single-spawn, max-file-size, dependency-cruiser) walk concurrently — which
 * raced them into ENOENT (probe removed mid-scan) or a phantom offender (probe seen by
 * another gate). A temp tree keeps the live source untouched.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-god-modules.mjs");

function runGate(root?: string, env?: Record<string, string>): { code: number; output: string } {
  const args = root ? [SCRIPT, "--root", root] : [SCRIPT];
  try {
    const output = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, ...env },
    });
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
    // Isolated temp tree mirroring the gate's <root>/packages/<pkg>/src layout, so the
    // 1001-line probe never touches the live source the parallel gates scan.
    const root = mkdtempSync(join(tmpdir(), "ak-god-gate-probe-"));
    try {
      const libDir = join(root, "packages", "shared", "src", "lib");
      mkdirSync(libDir, { recursive: true });
      // 1001 newline-separated lines → the gate's lineCount reports 1001 > 1000.
      writeFileSync(join(libDir, "__gate_probe__.ts"), "// probe\n".repeat(1001), "utf8");
      const { code, output } = runGate(root);
      expect(code, output).not.toBe(0);
      expect(output).toContain("__gate_probe__.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #1149: a worktree whose `node_modules` never got `typescript` installed made the gate fall
// back to a regex heuristic for its cohesion count, and that heuristic reported a violation
// that did not exist under the AST-based count (verified independently against master and the
// same branch from an installed worktree). The fix: a cohesion-only finding under a degraded
// count must not withhold a merge — the gate exits a DISTINCT non-zero code (3, "unverified")
// rather than 1 ("failed"), and says so in its own output, so it can never again be read as an
// equally-certain violation the way it was during the incident this ticket documents.
describe("check-god-modules.mjs — degraded cohesion count when typescript is missing (#1149)", () => {
  // 21 top-level `function` declarations — one over COHESION_MAX_FN_DECLS (20) — well under the
  // 1000-line ceiling and with trivial bodies, so only the cohesion signal can fire.
  const manyTopLevelFns = Array.from({ length: 21 }, (_, i) => `export function fn${i}() { return ${i}; }`).join("\n");

  it("exits UNVERIFIED (3), not FAILED (1), when the only finding is cohesion under a forced-degraded count", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-god-gate-degraded-"));
    try {
      const libDir = join(root, "packages", "shared", "src", "lib");
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, "__cohesion_probe__.ts"), manyTopLevelFns, "utf8");
      const { code, output } = runGate(root, { KANBAN_GOD_MODULE_GATE_FORCE_NO_TS: "1" });
      expect(code, output).toBe(3);
      expect(output).toContain("UNVERIFIED");
      expect(output).toContain("typescript is not installed");
      expect(output).not.toContain("FAILED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still exits FAILED (1) for a real line-ceiling breach even when typescript is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-god-gate-degraded-line-"));
    try {
      const libDir = join(root, "packages", "shared", "src", "lib");
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, "__line_probe__.ts"), "// probe\n".repeat(1001), "utf8");
      const { code, output } = runGate(root, { KANBAN_GOD_MODULE_GATE_FORCE_NO_TS: "1" });
      expect(code, output).toBe(1);
      expect(output).toContain("FAILED");
      expect(output).toContain("__line_probe__.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes cleanly (0) when typescript is forced missing but nothing is wrong", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-god-gate-degraded-clean-"));
    try {
      const libDir = join(root, "packages", "shared", "src", "lib");
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, "__clean_probe__.ts"), "export function fn0() { return 0; }\n", "utf8");
      const { code, output } = runGate(root, { KANBAN_GOD_MODULE_GATE_FORCE_NO_TS: "1" });
      expect(code, output).toBe(0);
      expect(output).toContain("OK");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
