import { describe, expect, it } from "vitest";
import { describeBrokenRegateScript, decideRegate, isMissingToolNoTests, describeFullRegate, describeTargetedRegate, formatTrainTimings } from "../merge-train-targeted-regate.js";

const base = { coveredFiles: ["packages/server/src/a.ts"], gatedSha: "a".repeat(40), fixSha: "abc1234ffff" };

describe("decideRegate (#1633)", () => {
  it("re-gates a one-file fix targeted, with static checks, failing suites and the scoped test:mine", () => {
    const d = decideRegate({ ...base, fixFiles: ["packages/server/src/b.ts"], failedSuites: ["packages/server/src/__tests__/x.test.ts"] });
    expect(d.mode).toBe("targeted");
    if (d.mode !== "targeted") return;
    expect(d.script).toContain("pnpm check:arch && pnpm typecheck");
    expect(d.script).toContain("vitest run");
    expect(d.script).toContain("x.test.ts");
    expect(d.script).toContain(`--changed ${base.gatedSha}`);
  });
  it("forces the full gate for a lockfile fix", () => {
    const d = decideRegate({ ...base, fixFiles: ["pnpm-lock.yaml"] });
    expect(d).toMatchObject({ mode: "full" });
  });
  it("forces the full gate for gate scripts, too many files, or an uncovered package", () => {
    expect(decideRegate({ ...base, fixFiles: ["scripts/test-mine.mjs"] }).mode).toBe("full");
    expect(decideRegate({ ...base, fixFiles: Array.from({ length: 20 }, (_, i) => `packages/server/src/f${i}.ts`) }).mode).toBe("full");
    expect(decideRegate({ ...base, fixFiles: ["packages/client/src/z.tsx"] })).toMatchObject({ mode: "full", reason: expect.stringContaining("did not cover") });
  });
  it("falls back to full when the fix diff is unknown", () => {
    expect(decideRegate({ ...base, fixFiles: [] }).mode).toBe("full");
  });
  it("labels the targeted run so it never reads as a full gate", () => {
    const d = decideRegate({ ...base, fixFiles: ["packages/server/src/b.ts"], failedSuites: ["s.test.ts"] });
    if (d.mode !== "targeted") throw new Error("expected targeted");
    expect(describeTargetedRegate(d, { related: 6, guards: 4 })).toBe("re-gate: targeted (failing 1 + related 6 + guards 4) after shepherd fix abc1234");
    expect(describeFullRegate("x")).toBe("re-gate: full (x)");
  });
  it("formats per-train timings", () => {
    expect(formatTrainTimings({ assemblyMs: 30000, gateMs: 25 * 60000, regateMs: 5 * 60000 })).toBe("assembly 30s · gate 25m · regate 5m");
  });
});

describe("targeted re-gate runs vitest inside the package (#1656)", () => {
  it("maps a package-relative suite to the covered package", () => {
    const d = decideRegate({ ...base, fixFiles: ["packages/server/src/b.ts"], failedSuites: ["src/__tests__/a.test.ts"] });
    expect(d.mode).toBe("targeted");
    if (d.mode !== "targeted") return;
    expect(d.script).toContain("pnpm --dir packages/server exec vitest run --maxWorkers=4 src/__tests__/a.test.ts");
  });
  it("strips the packages/<pkg>/ prefix and never runs vitest from the root", () => {
    const d = decideRegate({ ...base, fixFiles: ["packages/server/src/b.ts"], failedSuites: ["packages/server/src/__tests__/x.test.ts"] });
    if (d.mode !== "targeted") throw new Error("expected targeted");
    expect(d.script).toContain("pnpm --dir packages/server exec vitest run --maxWorkers=4 src/__tests__/x.test.ts");
  });
  it("goes full when a suite cannot be placed", () => {
    const d = decideRegate({ coveredFiles: ["packages/server/a.ts", "packages/shared/b.ts"], gatedSha: "a".repeat(40), fixSha: "f", fixFiles: ["packages/server/c.ts"], failedSuites: ["src/x.test.ts"] });
    expect(d.mode).toBe("full");
  });
  it("treats vitest-not-found with 0 failing suites as infrastructure", () => {
    const msg = 'Der Befehl "vitest" ist entweder falsch geschrieben\nERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "vitest" not found';
    expect(isMissingToolNoTests({ passed: false, message: msg, failedSuites: [] })).toBe(true);
    expect(isMissingToolNoTests({ passed: false, message: msg, failedSuites: ["a.test.ts"] })).toBe(false);
    expect(isMissingToolNoTests({ passed: false, message: "assertion failed" })).toBe(false);
  });
});

describe("targeted re-gate script runs under cmd.exe and sh alike (2026-10-23)", () => {
  it("emits no single quotes, which cmd.exe keeps literally", () => {
    const d = decideRegate({ ...base, fixFiles: ["packages/server/src/b.ts"], failedSuites: ["packages/server/src/__tests__/x.test.ts"] });
    if (d.mode !== "targeted") throw new Error("expected targeted");
    expect(d.script).not.toContain("'");
  });
  it("goes full for a token that would need quoting", () => {
    expect(decideRegate({ ...base, fixFiles: ["packages/server/src/b.ts"], failedSuites: ["src/__tests__/a b.test.ts"] })).toMatchObject({ mode: "full", reason: expect.stringContaining("shell-safe") });
    expect(decideRegate({ ...base, fixFiles: ["packages/server/src/b.ts"], failedSuites: ["src/__tests__/a&b.test.ts"] }).mode).toBe("full");
  });
  it("treats a missing directory with 0 failing suites as infrastructure", () => {
    expect(isMissingToolNoTests({ passed: false, message: "Das System kann den angegebenen Pfad nicht finden.", failedSuites: [] })).toBe(true);
    expect(isMissingToolNoTests({ passed: false, message: "The system cannot find the path specified." })).toBe(true);
    expect(isMissingToolNoTests({ passed: false, message: "sh: cd: packages/x: No such file or directory" })).toBe(true);
  });
});

describe("targeted re-gate script keeps cwd at the repo root (#1714)", () => {
  const decide = () => {
    const d = decideRegate({ ...base, fixFiles: ["packages/server/src/b.ts"], failedSuites: ["packages/server/src/__tests__/x.test.ts"] });
    if (d.mode !== "targeted") throw new Error("expected targeted");
    return d;
  };
  it("has no bare cd or parenthesised group, and test:mine is its own root step", () => {
    const d = decide();
    expect(d.script).not.toMatch(/cd|[()]/);
    // Fake cmd-like shell: cwd persists across steps; only `--dir` scopes a step.
    let cwd = ".";
    const cwdAtTestMine: string[] = [];
    for (const step of d.script.split(" && ")) {
      const cd = /^cd (\S+)$/.exec(step);
      if (cd) cwd = cd[1];
      if (step.startsWith("pnpm test:mine")) cwdAtTestMine.push(cwd);
    }
    expect(cwdAtTestMine).toEqual(["."]);
  });
  it("does not call a broken script a missing tool, and keeps the passing evidence", () => {
    const d = decide();
    const gate = { passed: false, failedSuites: [] as string[], message: "Tests  32 passed (32)\nERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command \"test:mine\" not found" };
    expect(isMissingToolNoTests(gate)).toBe(true); // legacy regex alone would misread it
    const msg = describeBrokenRegateScript(d.script, gate, 5);
    expect(msg).toContain("script failed at step 4");
    expect(msg).toContain("failing 5 passed; related step did not run");
    expect(msg).not.toContain("0 tests");
  });
  it("leaves a real missing vitest to the missing-tool path", () => {
    const gate = { passed: false, failedSuites: [] as string[], message: 'Command "vitest" not found' };
    expect(describeBrokenRegateScript("pnpm --dir packages/server exec vitest run", gate)).toBeNull();
  });
});
