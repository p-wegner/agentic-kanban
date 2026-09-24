// @covers review-merge.merge.gate-verify [workflow,resilience]
/**
 * #1230 — naming a red gate's failing suites, classifying them as deterministic, and tagging
 * the test-impact ledger row (defect 3 of the ticket).
 *
 * MEASURED: workspace 75b824fe's gate ran 31 times on one commit failing the same guard, and
 * every ledger row read `failed: []` — the parser saw the `FAIL` line but could not attribute
 * it to a package, because the failure summary (stderr) precedes every `[test:mine] <pkg>:`
 * header (stdout) in the combined text the parser gets. The fix places an unlabelled suite by
 * which single `packages/<pkg>/` holds it on disk.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributeFailedSuites,
  classifyFailedSuites,
  describeFailedSuites,
  isGuardSuite,
  withFailedSuites,
} from "../services/verify-failed-suites.js";
import { tagLastLedgerRow } from "../services/test-impact-outcome/guard-tag.js";
import {
  IMPACT_TOOL_RELATIVE_PATH,
  OUTCOMES_RELATIVE_PATH,
  recordVerifyGateOutcome,
  type RunImpactCommand,
} from "../services/test-impact-outcome.service.js";

// A guard by the naming rule. Deliberately NOT the real nloc ring's file name: the always-run
// marker ratchet reads that helper's name as "uses the shared scanner" and would ask for a marker.
const GUARD = "src/__tests__/exports-size-ratchet.test.ts";
const PLAIN = "src/lib/pluginViewFrameState.test.ts";

/** A worktree whose `packages/` tree holds the suites a run can name. */
function makeWorktree(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ak-vfs-"));
  for (const pkg of ["client", "server", "shared"]) mkdirSync(join(root, "packages", pkg, "src", "__tests__"), { recursive: true });
  mkdirSync(join(root, "packages", "client", "src", "lib"), { recursive: true });
  writeFileSync(join(root, "packages", "client", GUARD), "// @gate:always-run\nimport { it } from 'vitest';\n");
  writeFileSync(join(root, "packages", "client", PLAIN), "import { it } from 'vitest';\n");
  // The same relative path in TWO packages: unattributable by disk, must be dropped.
  writeFileSync(join(root, "packages", "client", "src", "__tests__", "shared-name.test.ts"), "");
  writeFileSync(join(root, "packages", "server", "src", "__tests__", "shared-name.test.ts"), "");
  // A marker-only guard whose NAME says nothing.
  writeFileSync(join(root, "packages", "server", "src", "__tests__", "tree-walk.test.ts"), "// @gate:always-run when:packages/**\n");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("attributeFailedSuites (#1230)", () => {
  it("places an UNLABELLED suite by the one package that holds it on disk — the case the ledger lost 31 times", () => {
    const wt = makeWorktree();
    try {
      expect(attributeFailedSuites(wt.root, [{ file: GUARD, packageLabel: null }])).toEqual([`packages/client/${GUARD}`]);
    } finally {
      wt.cleanup();
    }
  });

  it("drops a suite whose relative path exists in several packages rather than guessing", () => {
    const wt = makeWorktree();
    try {
      expect(attributeFailedSuites(wt.root, [{ file: "src/__tests__/shared-name.test.ts", packageLabel: null }])).toEqual([]);
    } finally {
      wt.cleanup();
    }
  });

  it("keeps the runner's own attribution when it gave one, and collapses duplicates", () => {
    expect(attributeFailedSuites(null, [
      { file: GUARD, packageLabel: "client" },
      { file: `.\\${GUARD.replace(/\//g, "\\")}`, packageLabel: "client" },
      { file: "packages/server/src/__tests__/x.test.ts", packageLabel: null },
    ])).toEqual([`packages/client/${GUARD}`, "packages/server/src/__tests__/x.test.ts"]);
  });
});

describe("isGuardSuite / classifyFailedSuites (#1230)", () => {
  it("classifies by the __tests__ naming convention and by the @gate:always-run marker", () => {
    const wt = makeWorktree();
    try {
      expect(isGuardSuite(wt.root, `packages/client/${GUARD}`)).toBe(true);
      expect(isGuardSuite(null, "packages/client/src/__tests__/client-conventions-guard.test.ts")).toBe(true);
      expect(isGuardSuite(null, "packages/mcp-server/src/__tests__/mcp-catalog-parity.test.ts")).toBe(true);
      expect(isGuardSuite(null, "packages/server/src/__tests__/merge-checkout-and-bookkeeping-invariants.test.ts")).toBe(true);
      // Marker only — the name says nothing, the file does.
      expect(isGuardSuite(wt.root, "packages/server/src/__tests__/tree-walk.test.ts")).toBe(true);
      // Neither: an ordinary unit suite outside __tests__.
      expect(isGuardSuite(wt.root, `packages/client/${PLAIN}`)).toBe(false);
      // A guard-looking name OUTSIDE __tests__ needs the marker to count.
      expect(isGuardSuite(null, "packages/client/src/lib/ratchet.test.ts")).toBe(false);
    } finally {
      wt.cleanup();
    }
  });

  it("calls a failure deterministic only when EVERY named suite is a guard", () => {
    const wt = makeWorktree();
    try {
      const guardOnly = classifyFailedSuites(wt.root, [{ file: GUARD, packageLabel: null }]);
      expect(guardOnly).toEqual({ files: [`packages/client/${GUARD}`], guardSuites: [`packages/client/${GUARD}`], guardFailure: true });
      const mixed = classifyFailedSuites(wt.root, [{ file: GUARD, packageLabel: null }, { file: PLAIN, packageLabel: "client" }]);
      expect(mixed.guardFailure).toBe(false);
      expect(mixed.guardSuites).toEqual([`packages/client/${GUARD}`]);
      expect(classifyFailedSuites(wt.root, []).guardFailure).toBe(false);
    } finally {
      wt.cleanup();
    }
  });

  it("leads a failed gate result with the suite names, and leaves a nameless one untouched", () => {
    const base = { passed: false, message: "verify_script failed (exit 1): tail…" };
    const named = withFailedSuites(base, { failedSuites: [`packages/client/${GUARD}`], guardFailure: true });
    expect(named.message).toBe(`failing suite(s): packages/client/${GUARD} [deterministic guard failure]. verify_script failed (exit 1): tail…`);
    expect(named.failedSuites).toEqual([`packages/client/${GUARD}`]);
    expect(named.guardFailure).toBe(true);
    expect(withFailedSuites(base, { failedSuites: [] })).toBe(base);
    expect(describeFailedSuites({ files: [], guardFailure: false })).toBe("");
  });
});

describe("tagLastLedgerRow (#1230)", () => {
  it("patches only the last row, and only when it is the row just recorded", () => {
    const rows = [
      JSON.stringify({ at: "1", result: "pass", failed: [] }),
      JSON.stringify({ at: "2", result: "fail", failed: ["b", "a"] }),
    ].join("\n") + "\n";
    const tagged = tagLastLedgerRow(rows, { result: "fail", failed: ["a", "b"] }, { guardFailure: true });
    expect(tagged.tagged).toBe(true);
    const [first, last] = tagged.text.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(first).toEqual({ at: "1", result: "pass", failed: [] });
    expect(last).toEqual({ at: "2", result: "fail", failed: ["b", "a"], guardFailure: true });
    expect(tagged.text.endsWith("\n")).toBe(true);
    // A stranger's row is left alone and the refusal is named.
    const refused = tagLastLedgerRow(rows, { result: "fail", failed: ["c"] }, { guardFailure: true });
    expect(refused.tagged).toBe(false);
    expect(refused.text).toBe(rows);
    expect(tagLastLedgerRow("", { result: "fail", failed: [] }, {}).tagged).toBe(false);
  });
});

describe("recordVerifyGateOutcome names a guard failure (#1230)", () => {
  /** A worktree with the skill stub, and a fake `impact.mjs` that appends a row on `record`. */
  function makeRepos() {
    const wt = makeWorktree();
    const main = join(wt.root, "main");
    mkdirSync(join(wt.root, ".claude", "skills", "test-impact", "tools"), { recursive: true });
    mkdirSync(join(main, ".test-impact"), { recursive: true });
    writeFileSync(join(wt.root, IMPACT_TOOL_RELATIVE_PATH), "// stub\n");
    const outcomes = join(main, OUTCOMES_RELATIVE_PATH);
    const calls: string[][] = [];
    const run: RunImpactCommand = async ({ args }) => {
      calls.push(args);
      if (args[1] === "select") {
        return { exitCode: 0, stdout: JSON.stringify({ tier: "impact", changed: ["packages/client/src/lib/x.ts"], selected: [{ test: `packages/client/${GUARD}` }] }), stderr: "" };
      }
      const flag = (name: string) => args[args.indexOf(`--${name}`) + 1];
      const failed = flag("failed") ? flag("failed")!.split(",") : [];
      appendFileSync(outcomes, JSON.stringify({ at: "now", source: flag("source"), result: flag("result"), failed, missed: [] }) + "\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return { ...wt, main, outcomes, calls, run };
  }

  it("records the guard file the runner could not attribute, and tags the row guardFailure: true", async () => {
    const repos = makeRepos();
    try {
      const result = await recordVerifyGateOutcome({
        workspaceId: "ws-1",
        workingDir: repos.root,
        repoPath: repos.main,
        baseBranch: "master",
        outcome: { failure: { message: "verify_script failed (exit 1)" }, failedSuites: [{ file: GUARD, packageLabel: null }] },
        tierInfo: null,
        runCommand: repos.run,
        log: () => {},
      });
      expect(result.recorded).toBe(true);
      expect(result.failedSuites).toEqual([`packages/client/${GUARD}`]);
      expect(result.guardFailure).toBe(true);
      // The old path dropped the suite and tagged the row `-unattributed`; now it is named.
      expect(result.suspectReason).toBeUndefined();
      const record = repos.calls.find((args) => args[1] === "record")!;
      expect(record[record.indexOf("--failed") + 1]).toBe(`packages/client/${GUARD}`);
      expect(record[record.indexOf("--source") + 1]).toBe("ci-guardfailure");
      const row = JSON.parse(readFileSync(repos.outcomes, "utf8").trim().split("\n").at(-1)!);
      expect(row).toMatchObject({ result: "fail", failed: [`packages/client/${GUARD}`], guardFailure: true });
    } finally {
      repos.cleanup();
    }
  });

  it("names the suites even when the ledger itself is not written (timeout) so the gate can still say them", async () => {
    const repos = makeRepos();
    try {
      const result = await recordVerifyGateOutcome({
        workspaceId: "ws-2",
        workingDir: repos.root,
        repoPath: repos.main,
        outcome: { failure: { timedOut: true, message: "timed out" }, failedSuites: [{ file: PLAIN, packageLabel: null }] },
        tierInfo: null,
        runCommand: repos.run,
        log: () => {},
      });
      expect(result.recorded).toBe(false);
      expect(result.failedSuites).toEqual([`packages/client/${PLAIN}`]);
      expect(result.guardFailure).toBe(false);
    } finally {
      repos.cleanup();
    }
  });
});
