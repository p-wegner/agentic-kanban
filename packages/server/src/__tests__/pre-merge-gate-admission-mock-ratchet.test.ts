// @gate:always-run when:packages/server/src/__tests__/**,packages/shared/__tests__/**,packages/mcp-server/src/__tests__/**,packages/client/src/__tests__/**,packages/server/src/services/pre-merge-gate.service.ts,packages/server/src/services/gate-quiesce.ts
// — reaches every __tests__ file's source text via a repo-tree walk (#1221). Scoped to the
// trees it reads plus the two gate modules its signature is about, so an ordinary diff
// elsewhere pays nothing for it.
/**
 * #1221 — a unit suite that invokes the REAL `runPreMergeGate` but never mocks
 * `resolveGateHostAdmission` (or the `readTier0Capacity`/`probeTempHealth` reads it wraps) reads
 * the ACTUAL machine's free memory. On a box under the #1009 Tier-0 floor (measured: 1.8 GB free
 * against a 2 GB floor) every case in such a suite returns "pre-merge gate HELD — host saturated"
 * instead of exercising the decision logic it was written to test — turning a branch's own gate
 * RED for a condition the real gate correctly reports as HELD.
 *
 * `pre-merge-gate.service.test.ts` hit exactly this (#1210's gate, 2026-09-22) and was fixed by
 * mocking `../services/gate-quiesce.js` to always admit. This ratchet is the OTHER half `left
 * open` by that fix: the same audit found TWO more suites in the identical shape
 * (`pre-merge-gate-base-health-order.test.ts`, `merge-verify-gate-path-coverage.test.ts`), fixed
 * alongside this guard — so a FOURTH suite of this shape cannot land unmocked.
 *
 * Mirrors `always-run-marker-ratchet.test.ts`'s method: classify by a static SIGNATURE (does the
 * file import `runPreMergeGate` from the gate service and never reference `gate-quiesce`/
 * `machine-capacity`/`temp-health`?) rather than a hand-maintained list, so a new suite of this
 * shape is caught the moment it is written rather than the next time someone happens to run it
 * on a tight box. A heuristic net, not a proof: a suite that reaches `runPreMergeGate` only
 * TRANSITIVELY (through a route or the monitor cycle) is not text-matched here and must be
 * caught by review, same caveat every guard in this family carries.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { walkTestFiles } from "../../../shared/__tests__/helpers/guard-scan.js";

const testsDir = path.join(import.meta.dirname!, "..", "__tests__");

/** Imports the real gate FUNCTION (not a sibling export like `resolveMergeGateConfig`, and not
 *  a namespace import used only to spy on an unrelated export) from the module under guard — the
 *  only way a suite can reach the live `readTier0Capacity`/`probeTempHealth` calls this ticket is
 *  about. Matches both `import { runPreMergeGate } from "...pre-merge-gate.service.js"` and the
 *  `const { runPreMergeGate } = await import(...)` form this file's own siblings use. */
const IMPORTS_REAL_GATE =
  /\brunPreMergeGate\b[^;]*from\s+["'][^"']*\/services\/pre-merge-gate\.service(?:\.js)?["']|(?:const|let)\s*\{[^}]*\brunPreMergeGate\b[^}]*\}\s*=\s*await\s+import\(\s*["'][^"']*\/services\/pre-merge-gate\.service(?:\.js)?["']\s*\)/;

/** Any of the three ways a suite can neutralise the host-admission read: mocking the decision
 *  module itself, or mocking the two underlying reads it falls back to by default. */
const MOCKS_HOST_ADMISSION =
  /gate-quiesce(?:\.js)?["']|machine-capacity["']|(?:\.\.\/)*lib\/temp-health(?:\.js)?["']/;

/**
 * Files that import the real gate, and never mock host admission, but are genuinely safe: their
 * own mock setup guarantees `runPreMergeGate` returns from the #628/#1123 install/setup-failure
 * PREFLIGHT check (`describeBlockingPreflightForGate` in `pre-merge-gate.service.ts`) before the
 * function ever reaches `resolveGateHostAdmission` — that read sits far later in the same
 * function (after the tier/verify resolution and tree-hash memo), so these suites never touch
 * the host. Only SHRINK this list; a test added to one of these files that does NOT force the
 * preflight block would reach the real host read unprotected.
 */
const KNOWN_SAFE_PREFLIGHT_SHORT_CIRCUIT = new Set<string>([
  // #628 — every case mocks `listWorkspaceRepoInstallStates` to return a blocking row, so
  // `describeOutstandingRepoInstalls` always returns non-null and the gate returns at line ~219
  // of pre-merge-gate.service.ts, before admission is ever asked.
  "pre-merge-gate-install-block.test.ts",
  // #1123 — same shape: every case mocks `getSetupRunForGate` to return a failed run, so
  // `describeFailedSetupRun` always returns non-null and the gate short-circuits identically.
  "pre-merge-gate-setup-failure.test.ts",
]);

describe("pre-merge gate admission mock ratchet (#1221)", () => {
  it("every suite that invokes the real gate also neutralises host admission", () => {
    const offenders: string[] = [];
    for (const full of walkTestFiles(testsDir)) {
      const rel = path.relative(testsDir, full).replace(/\\/g, "/");
      if (KNOWN_SAFE_PREFLIGHT_SHORT_CIRCUIT.has(rel)) continue;
      const source = fs.readFileSync(full, "utf8");
      if (!IMPORTS_REAL_GATE.test(source)) continue;
      if (MOCKS_HOST_ADMISSION.test(source)) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      `These suites import the real \`runPreMergeGate\` but never mock \`gate-quiesce.js\` / ` +
        `\`machine-capacity\` / \`temp-health\`, so they read the ACTUAL machine's free memory and ` +
        `will fail with "host saturated" on any box under the #1009 Tier-0 floor (#1221). Add:\n` +
        `  vi.mock("../services/gate-quiesce.js", async (importOriginal) => {\n` +
        `    const actual = await importOriginal<typeof import("../services/gate-quiesce.js")>();\n` +
        `    return { ...actual, resolveGateHostAdmission: vi.fn(async () => ({ admit: true, reason: "host_has_room" })) };\n` +
        `  });\n` +
        `Offenders:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("KNOWN_SAFE_PREFLIGHT_SHORT_CIRCUIT entries are not stale", () => {
    const stale: string[] = [];
    for (const rel of KNOWN_SAFE_PREFLIGHT_SHORT_CIRCUIT) {
      const full = path.join(testsDir, rel);
      if (!fs.existsSync(full)) { stale.push(`${rel}: no such test file — remove the entry`); continue; }
      const source = fs.readFileSync(full, "utf8");
      if (!IMPORTS_REAL_GATE.test(source)) {
        stale.push(`${rel}: no longer imports the real gate — remove the entry`);
        continue;
      }
      if (MOCKS_HOST_ADMISSION.test(source)) {
        stale.push(`${rel}: now mocks host admission directly — remove the entry`);
      }
    }
    expect(stale, `Stale KNOWN_SAFE_PREFLIGHT_SHORT_CIRCUIT entries:\n${stale.join("\n")}`).toEqual([]);
  });
});
