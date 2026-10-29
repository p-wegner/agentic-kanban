// @gate:always-run walks the server source tree for callers of the per-ticket risk-tag readers
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * #1745 — `getIssueRiskTag` / `resolveIssueRiskPosture` read the per-ticket `risk:<level>` tag,
 * which can SOFTEN the checks a ticket faces. Every new reader of that tag is a new place a
 * forged tag changes a gate, so the set of modules allowed to call them is pinned: the
 * definition, and the two exit checks that are the documented consumers. The merge gate stays
 * project-scoped on purpose (monitor-setup ignores the tag for cycle caps).
 */
const ALLOWED = new Set([
  "services/risk-posture.service.ts",
  "startup/exit/implement-exit-check.ts",
  "startup/exit/review-exit-gate.ts",
]);
const CALL = /\b(getIssueRiskTag|resolveIssueRiskPosture)\b/;

describe("risk-tag reader ratchet (#1745)", () => {
  it("only the pinned modules reference the per-ticket risk-tag readers", () => {
    const srcRoot = resolve(import.meta.dirname, "..");
    const offenders = walkPackageSources(srcRoot)
      .map((abs) => relative(srcRoot, abs).replaceAll("\\", "/"))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => CALL.test(stripComments(readFileSync(resolve(srcRoot, rel), "utf8"))));
    expect(offenders, "add the module to ALLOWED only after deciding a ticket tag may soften its checks").toEqual([]);
  });
});

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
