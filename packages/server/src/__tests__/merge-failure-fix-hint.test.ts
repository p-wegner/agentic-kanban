/**
 * #1250 — a deterministic shrink-only red carries its own fix; this pins that the parser reads
 * it out of the REAL output shapes of both rings and the runtime ratchet, and out of nothing
 * else.
 */
import { describe, expect, it } from "vitest";
import {
  deriveMergeFixHint,
  describeMergeFixHint,
  mergeFixHintFromJob,
  withMergeFixHint,
} from "../services/merge-failure-fix-hint.js";
import { withFailedSuites } from "../services/verify-failed-suites.js";

/** What vitest printed for #1243's first red (client ring), noise-filtered as the gate keeps it. */
const CLIENT_RED = `
[test:mine] client: 3 file(s)
 FAIL  src/__tests__/function-nloc-ratchet.test.ts > client function nloc is a shrink-only ring (#763) > no baseline entry is stale (a shrink must be banked, not left as budget)
AssertionError: expected [ 'components/TableView.tsx::TableView…(+2)' ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "components/TableView.tsx::TableView: 371 < baseline 416 — lower it to 371",
+   "components/IssueDetailPanel.tsx::IssueDetailPanel: 522 < baseline 535 — lower it to 522",
+   "routes/BoardPage.tsx::BoardPage: 630 < baseline 637 — lower it to 630",
+ ]

 ❯ src/__tests__/function-nloc-ratchet.test.ts:101:27
[full verify log: C:\\Users\\x\\AppData\\Local\\Temp\\kanban-verify-abc.log]
`;

/** The second red, once the client half was banked (server ring; `packages/server/` path form). */
const SERVER_RED = `
 FAIL  packages/server/src/__tests__/function-nloc-ratchet.test.ts > server function nloc is a shrink-only ring (#800) > no baseline entry is stale (a shrink must be banked, not left as budget)
AssertionError: expected [ 'routes/workspace-actions.ts::createWorkspaceActionsRoute: 382 < baseline 388 — lower it to 382', 'services/pre-merge-gate.service.ts::runPreMergeGate: 301 < baseline 305 — lower it to 301' ] to deeply equal []
`;

const RUNTIME_RED = `
 FAIL  src/__tests__/always-run-guard-runtime-ratchet.test.ts > the baseline is not stale — a shrunk floor must be pinned at its new total
AssertionError: The always-run floor is now ~512s, well under the pinned ~562s. Lower BASELINE_TOTAL_MS to 512345 — a baseline that is never lowered is a budget, not a ratchet.
`;

describe("deriveMergeFixHint (#1250)", () => {
  it("reads the client ring's stale list into edits on the client baseline", () => {
    const hint = deriveMergeFixHint(CLIENT_RED);
    expect(hint?.kind).toBe("bank-shrinks");
    expect(hint?.edits).toEqual([
      { baselineFile: "packages/client/src/__tests__/function-nloc-baseline.ts", key: "components/TableView.tsx::TableView", from: 416, to: 371 },
      { baselineFile: "packages/client/src/__tests__/function-nloc-baseline.ts", key: "components/IssueDetailPanel.tsx::IssueDetailPanel", from: 535, to: 522 },
      { baselineFile: "packages/client/src/__tests__/function-nloc-baseline.ts", key: "routes/BoardPage.tsx::BoardPage", from: 637, to: 630 },
    ]);
    expect(hint?.summary).toBe(
      "stale baseline: lower components/TableView.tsx::TableView 416 -> 371 in packages/client/src/__tests__/function-nloc-baseline.ts; "
      + "components/IssueDetailPanel.tsx::IssueDetailPanel 535 -> 522 in packages/client/src/__tests__/function-nloc-baseline.ts; "
      + "routes/BoardPage.tsx::BoardPage 637 -> 630 in packages/client/src/__tests__/function-nloc-baseline.ts",
    );
  });

  it("attributes the server ring by its path, even when the whole list sits on one assertion line", () => {
    const hint = deriveMergeFixHint(SERVER_RED);
    expect(hint?.edits).toEqual([
      { baselineFile: "packages/server/src/__tests__/function-nloc-baseline.ts", key: "routes/workspace-actions.ts::createWorkspaceActionsRoute", from: 388, to: 382 },
      { baselineFile: "packages/server/src/__tests__/function-nloc-baseline.ts", key: "services/pre-merge-gate.service.ts::runPreMergeGate", from: 305, to: 301 },
    ]);
  });

  it("drops a stale line it cannot attribute to a package rather than guessing", () => {
    const hint = deriveMergeFixHint('+   "routes/X.tsx::X: 10 < baseline 20 — lower it to 10",');
    expect(hint).toBeNull();
  });

  it("reads the runtime ratchet's pinned const, with an unknown `from`", () => {
    const hint = deriveMergeFixHint(RUNTIME_RED);
    expect(hint?.edits).toEqual([
      { baselineFile: "packages/server/src/__tests__/always-run-guard-runtime-ratchet.test.ts", key: "BASELINE_TOTAL_MS", from: null, to: 512345 },
    ]);
    expect(hint?.summary).toBe(
      "stale baseline: lower BASELINE_TOTAL_MS ? -> 512345 in packages/server/src/__tests__/always-run-guard-runtime-ratchet.test.ts",
    );
  });

  it("is null for the GROWTH half of the same rings and for an unrelated red", () => {
    expect(deriveMergeFixHint(`
 FAIL  src/__tests__/function-nloc-ratchet.test.ts > client function nloc is a shrink-only ring (#763) > no listed function has grown
AssertionError: expected [ 'components/A.tsx::A: 600 > baseline 570' ] to deeply equal []
`)).toBeNull();
    expect(deriveMergeFixHint(`
AssertionError: The @gate:always-run floor grew to 180 suite(s) / ~600s (baseline ~562s). Raising BASELINE_TOTAL_MS is the last resort.
`)).toBeNull();
    expect(deriveMergeFixHint(" FAIL  src/__tests__/foo.test.ts > does a thing\nAssertionError: expected 1 to be 2")).toBeNull();
    expect(deriveMergeFixHint("")).toBeNull();
    expect(deriveMergeFixHint(null)).toBeNull();
  });

  it("collapses a line the runner printed twice into one edit", () => {
    const hint = deriveMergeFixHint(CLIENT_RED + CLIENT_RED);
    expect(hint?.edits).toHaveLength(3);
  });

  it("is a fixed point: re-deriving from a message it already annotated changes nothing", () => {
    const once = withMergeFixHint({ message: CLIENT_RED });
    const twice = withMergeFixHint({ message: once.message });
    expect(twice.fixHint).toEqual(once.fixHint);
    expect(once.message.endsWith(`\n${describeMergeFixHint(once.fixHint!.edits)}`)).toBe(true);
  });
});

describe("the hint rides on the gate result and on the merge job", () => {
  it("withFailedSuites appends the one-line fix after the failing-suite lead", () => {
    const result = withFailedSuites(
      { passed: false as const, stage: "verify", message: CLIENT_RED },
      { failedSuites: ["packages/client/src/__tests__/function-nloc-ratchet.test.ts"], guardFailure: true },
    );
    expect(result.message.startsWith("failing suite(s): packages/client/src/__tests__/function-nloc-ratchet.test.ts [deterministic guard failure]. ")).toBe(true);
    expect(result.message.endsWith("in packages/client/src/__tests__/function-nloc-baseline.ts")).toBe(true);
    expect(result.fixHint?.edits).toHaveLength(3);
    expect(result.failedSuites).toEqual(["packages/client/src/__tests__/function-nloc-ratchet.test.ts"]);
  });

  it("withFailedSuites leaves an unrecognised, unnamed failure untouched", () => {
    const input = { passed: false as const, message: "verify exited 1" };
    expect(withFailedSuites(input, {})).toBe(input);
  });

  it("mergeFixHintFromJob reads the LAST attempt only when it failed", () => {
    const failed = { state: "failed", attempts: [{ outcome: "passed", detail: "x" }, { outcome: "failed", detail: CLIENT_RED }] };
    expect(mergeFixHintFromJob(failed)?.edits).toHaveLength(3);
    const passedLast = { state: "running", attempts: [{ outcome: "failed", detail: CLIENT_RED }, { outcome: "passed", detail: "ok" }] };
    expect(mergeFixHintFromJob(passedLast)).toBeNull();
    const inFlight = { state: "running", attempts: [{ outcome: "failed", detail: CLIENT_RED }, {}] };
    expect(mergeFixHintFromJob(inFlight)).toBeNull();
    expect(mergeFixHintFromJob({ state: "failed", error: SERVER_RED, attempts: [] })?.edits).toHaveLength(2);
    expect(mergeFixHintFromJob({ state: "succeeded", attempts: [] })).toBeNull();
    expect(mergeFixHintFromJob(null)).toBeNull();
  });
});
