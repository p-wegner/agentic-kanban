/**
 * Unit tests for conflict-marker-scanner (ticket #599).
 *
 * Acceptance criteria:
 * - A file with a committed conflict marker is detected; file + line reported.
 * - A clean file passes without findings.
 * - The =======, <<<<<<<, and >>>>>>> markers are all detected.
 * - assertNoCommittedConflictMarkers logs [fatal] alerts on findings.
 *
 * We mock the git adapter so no real git repo is required.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- helper: build a fake `git grep` output line ---
function gitGrepLine(file: string, line: number, content: string): string {
  return `HEAD:${file}:${line}:${content}`;
}

// Control variable for the mock
let _mockExecResult: { output: string; exitCode: number } = { output: "", exitCode: 1 };

vi.mock("@agentic-kanban/shared/lib/git-exec", () => ({
  gitExecSync: vi.fn((..._args: unknown[]) => {
    if (_mockExecResult.exitCode === 1) {
      const err = Object.assign(new Error("git grep no matches"), { status: 1 });
      throw err;
    }
    if (_mockExecResult.exitCode !== 0) {
      const err = Object.assign(new Error("git error"), { status: _mockExecResult.exitCode });
      throw err;
    }
    return _mockExecResult.output;
  }),
}));

function setGitGrepResult(output: string, exitCode = 0) {
  _mockExecResult = { output, exitCode };
}

describe("scanCommittedConflictMarkers", () => {
  beforeEach(async () => {
    vi.resetModules();
    // reset to "no matches" by default
    setGitGrepResult("", 1);
  });

  it("returns empty array when git grep finds no matches (exit 1)", async () => {
    setGitGrepResult("", 1);
    const { scanCommittedConflictMarkers } = await import("../startup/conflict-marker-scanner.js");
    const result = scanCommittedConflictMarkers("/fake/repo");
    expect(result).toEqual([]);
  });

  it("returns empty array for a clean file (no markers in output)", async () => {
    setGitGrepResult("", 1);
    const { scanCommittedConflictMarkers } = await import("../startup/conflict-marker-scanner.js");
    const result = scanCommittedConflictMarkers("/fake/repo");
    expect(result).toHaveLength(0);
  });

  it("detects a <<<<<<< marker", async () => {
    setGitGrepResult(gitGrepLine("packages/server/src/foo.ts", 42, "<<<<<<< HEAD"), 0);
    const { scanCommittedConflictMarkers } = await import("../startup/conflict-marker-scanner.js");
    const result = scanCommittedConflictMarkers("/fake/repo");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      file: "packages/server/src/foo.ts",
      line: 42,
      content: "<<<<<<< HEAD",
    });
  });

  it("detects an ======= separator marker", async () => {
    setGitGrepResult(gitGrepLine("packages/server/src/bar.tsx", 10, "======="), 0);
    const { scanCommittedConflictMarkers } = await import("../startup/conflict-marker-scanner.js");
    const result = scanCommittedConflictMarkers("/fake/repo");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "packages/server/src/bar.tsx", line: 10 });
  });

  it("detects a >>>>>>> marker", async () => {
    setGitGrepResult(gitGrepLine("packages/shared/drizzle/0010_init.sql", 7, ">>>>>>> feature/ak-123"), 0);
    const { scanCommittedConflictMarkers } = await import("../startup/conflict-marker-scanner.js");
    const result = scanCommittedConflictMarkers("/fake/repo");
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("packages/shared/drizzle/0010_init.sql");
  });

  it("detects multiple markers across multiple files", async () => {
    const output = [
      gitGrepLine("packages/server/src/a.ts", 5, "<<<<<<< HEAD"),
      gitGrepLine("packages/server/src/a.ts", 9, "======="),
      gitGrepLine("packages/server/src/a.ts", 15, ">>>>>>> feature/branch"),
      gitGrepLine("packages/client/src/b.tsx", 3, "<<<<<<< HEAD"),
    ].join("\n");
    setGitGrepResult(output, 0);
    const { scanCommittedConflictMarkers } = await import("../startup/conflict-marker-scanner.js");
    const result = scanCommittedConflictMarkers("/fake/repo");
    expect(result).toHaveLength(4);
    expect(result.map(f => f.file)).toContain("packages/server/src/a.ts");
    expect(result.map(f => f.file)).toContain("packages/client/src/b.tsx");
  });

  it("returns empty on git error (non-fatal)", async () => {
    setGitGrepResult("", 128);
    const { scanCommittedConflictMarkers } = await import("../startup/conflict-marker-scanner.js");
    const result = scanCommittedConflictMarkers("/fake/repo");
    expect(result).toEqual([]);
  });

  it("does not flag lines without exact 7-char marker prefix", async () => {
    // A comment line that starts with < but not exactly <<<<<<<
    const output = gitGrepLine("packages/server/src/c.ts", 1, "// <<<<< not a real marker");
    setGitGrepResult(output, 0);
    const { scanCommittedConflictMarkers } = await import("../startup/conflict-marker-scanner.js");
    const result = scanCommittedConflictMarkers("/fake/repo");
    expect(result).toHaveLength(0);
  });
});

describe("assertNoCommittedConflictMarkers", () => {
  beforeEach(() => {
    vi.resetModules();
    setGitGrepResult("", 1);
  });

  it("returns empty and does not warn when clean", async () => {
    setGitGrepResult("", 1);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { assertNoCommittedConflictMarkers } = await import("../startup/conflict-marker-scanner.js");
    const result = assertNoCommittedConflictMarkers("/fake/repo");
    expect(result).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("logs [fatal] and returns findings when markers found", async () => {
    setGitGrepResult(gitGrepLine("packages/server/src/startup/scanner.ts", 3, "<<<<<<< HEAD"), 0);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { assertNoCommittedConflictMarkers } = await import("../startup/conflict-marker-scanner.js");
    const result = assertNoCommittedConflictMarkers("/fake/repo");
    expect(result).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[fatal]"));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("packages/server/src/startup/scanner.ts:3")
    );
    warnSpy.mockRestore();
  });
});
