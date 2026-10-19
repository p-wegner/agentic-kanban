import { describe, expect, it } from "vitest";
import { decideRegate, describeFullRegate, describeTargetedRegate, formatTrainTimings } from "../merge-train-targeted-regate.js";

const base = { coveredFiles: ["packages/server/src/a.ts"], gatedSha: "a".repeat(40), fixSha: "abc1234ffff" };

describe("decideRegate (#1633)", () => {
  it("re-gates a one-file fix targeted, with static checks, failing suites and the scoped test:mine", () => {
    const d = decideRegate({ ...base, fixFiles: ["packages/server/src/b.ts"], failedSuites: ["packages/server/src/__tests__/x.test.ts"] });
    expect(d.mode).toBe("targeted");
    if (d.mode !== "targeted") return;
    expect(d.script).toContain("pnpm check:arch && pnpm typecheck");
    expect(d.script).toContain("vitest run");
    expect(d.script).toContain("x.test.ts");
    expect(d.script).toContain(`--changed '${base.gatedSha}'`);
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
