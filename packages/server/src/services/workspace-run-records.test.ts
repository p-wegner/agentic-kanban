import { describe, expect, it } from "vitest";
import {
  buildSetupRunFromError,
  buildSetupRunFromResult,
  buildSymlinkErrorRun,
  buildSymlinkRun,
  disabledSymlinkRun,
  setupFailureHeadline,
  skippedSetupRun,
  tailOutput,
} from "./workspace-run-records.js";

const START = "2026-06-19T10:00:00.000Z";
const NOW = "2026-06-19T10:00:05.000Z"; // 5s later

// #1092: the real failure of 2026-09-11 — a corrupt pnpm store entry — hidden behind the
// deprecation notice every pnpm run prints first.
const PNPM_FIELD_WARN =
  '[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.onlyBuiltDependencies".';

describe("setupFailureHeadline (#1092)", () => {
  it("skips pnpm's deprecation notice and returns the ERR_PNPM line", () => {
    const run = buildSetupRunFromResult(
      "pnpm install -r",
      START,
      { exitCode: 1, stdout: "", stderr: `${PNPM_FIELD_WARN}\n ERR_PNPM_UNKNOWN  UNKNOWN: unknown error, stat 'C:\\store\\files\\06\\cdb7'` },
      NOW,
    );
    expect(setupFailureHeadline(run)).toBe("ERR_PNPM_UNKNOWN  UNKNOWN: unknown error, stat 'C:\\store\\files\\06\\cdb7'");
  });

  it("falls back to the first non-noise line when nothing looks like an error", () => {
    expect(setupFailureHeadline({ exitCode: 2, stderrTail: `${PNPM_FIELD_WARN}\nsomething odd`, stdoutTail: null })).toBe("something odd");
  });

  it("names the exit code when the run produced no usable output", () => {
    expect(setupFailureHeadline({ exitCode: 1, stderrTail: PNPM_FIELD_WARN, stdoutTail: null })).toBe("exit 1 with no output");
  });
});

describe("tailOutput", () => {
  it("returns null for empty/whitespace output", () => {
    expect(tailOutput("")).toBeNull();
    expect(tailOutput("   \n  ")).toBeNull();
  });

  it("keeps only the last 8 lines", () => {
    const input = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    expect(tailOutput(input)).toBe(Array.from({ length: 8 }, (_, i) => `line${i + 12}`).join("\n"));
  });

  it("caps very long output at 2000 chars from the end", () => {
    const out = tailOutput("x".repeat(5000));
    expect(out).toHaveLength(2000);
  });
});

describe("buildSetupRunFromResult", () => {
  it("is success on exit code 0 and computes duration", () => {
    const run = buildSetupRunFromResult("pnpm install", START, { exitCode: 0, stdout: "ok", stderr: "" }, NOW);
    expect(run.state).toBe("success");
    expect(run.exitCode).toBe(0);
    expect(run.durationMs).toBe(5000);
    expect(run.stdoutTail).toBe("ok");
    expect(run.stderrTail).toBeNull();
  });

  it("is failed on a non-zero exit code", () => {
    const run = buildSetupRunFromResult("x", START, { exitCode: 1, stdout: "", stderr: "boom" }, NOW);
    expect(run.state).toBe("failed");
    expect(run.stderrTail).toBe("boom");
  });

  it("never returns a negative duration when the clock goes backwards", () => {
    const run = buildSetupRunFromResult("x", NOW, { exitCode: 0, stdout: "", stderr: "" }, START);
    expect(run.durationMs).toBe(0);
  });
});

describe("buildSetupRunFromError", () => {
  it("is failed with the error message in stderrTail and a null exit code", () => {
    const run = buildSetupRunFromError("x", START, new Error("nope"), NOW);
    expect(run.state).toBe("failed");
    expect(run.exitCode).toBeNull();
    expect(run.stderrTail).toBe("nope");
  });

  it("stringifies non-Error throwables", () => {
    expect(buildSetupRunFromError("x", START, "raw string", NOW).stderrTail).toBe("raw string");
  });
});

describe("skippedSetupRun", () => {
  it("is a zero-duration skipped record", () => {
    const run = skippedSetupRun(null, NOW);
    expect(run.state).toBe("skipped");
    expect(run.durationMs).toBe(0);
    expect(run.startedAt).toBe(NOW);
    expect(run.endedAt).toBe(NOW);
  });
});

describe("symlink runs", () => {
  it("disabledSymlinkRun reports the disabled state with empty arrays", () => {
    const run = disabledSymlinkRun(NOW);
    expect(run.state).toBe("disabled");
    expect(run.dirs).toEqual([]);
    expect(run.error).toBeNull();
  });

  it("buildSymlinkRun is failed when any dir failed", () => {
    const run = buildSymlinkRun(["a"], START, { linked: ["a"], skipped: [], failed: [{ dir: "b", error: "x" }] }, NOW);
    expect(run.state).toBe("failed");
  });

  it("buildSymlinkRun is linked when something linked and nothing failed", () => {
    const run = buildSymlinkRun(["a"], START, { linked: ["a"], skipped: [], failed: [] }, NOW);
    expect(run.state).toBe("linked");
  });

  it("buildSymlinkRun is skipped when nothing linked or failed", () => {
    const run = buildSymlinkRun(["a"], START, { linked: [], skipped: ["a"], failed: [] }, NOW);
    expect(run.state).toBe("skipped");
  });

  it("buildSymlinkErrorRun carries the error message", () => {
    const run = buildSymlinkErrorRun(["a"], START, new Error("disk full"), NOW);
    expect(run.state).toBe("failed");
    expect(run.error).toBe("disk full");
  });
});
