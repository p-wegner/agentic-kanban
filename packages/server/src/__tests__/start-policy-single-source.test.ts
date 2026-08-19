// @gate:always-run — scans every package's src tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Decision 008 / #600: `resolveStartPolicy` is THE decision every auto-start path consults.
 *
 * `board_autodrive_<id>` is DERIVED through it, never read beside it. That distinction is
 * load-bearing: `manual` must be a true kill-switch, and the post-merge cascade once leaked
 * past every "drive" switch precisely because a path read the raw pref instead of asking
 * the resolver (fixed in ad729e70). A project on the LEGACY flag has no `start_mode_` key
 * at all, so any raw read reports it as unset — the resolver is what derives `monitor`.
 *
 * The rule is NOT "no file may mention these prefs" — writers, key-builders, cascade-delete
 * and doc strings legitimately name them. The rule is: a file that mentions them either
 * consults `resolveStartPolicy`, or is listed below with the reason it does not decide.
 */
const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const SCAN_ROOTS = ["server/src", "shared/src", "mcp-server/src", "client/src"];

const PREF_MENTION = /board_autodrive_|start_mode_/;
const CONSULTS_RESOLVER = /resolveStartPolicy/;

/**
 * Files that name the prefs but do NOT decide whether anything auto-starts.
 * Each entry states why. A file that starts deciding must drop out of this list.
 */
const NON_DECIDING: Record<string, string> = {
  "server/src/services/start-policy.service.ts": "the resolver itself — it owns the derivation",
  "shared/src/lib/dynamic-preference-keys.ts": "declares the per-project key prefixes",
  "shared/src/lib/cascade-delete.ts": "comment: templated keys deleted with a project",
  "shared/src/lib/mcp-tool-definitions.ts": "the set_preference tool's description text",
  "server/src/butler/board-guide.ts": "user-facing how-to text for the butler",
  "server/src/services/drive.service.ts": "comments describing the legacy keystone flag",
  "server/src/startup/monitor-contract.ts": "comment listing the per-project gates",
  "shared/src/types/api/monitor.ts": "wire types only — the doc comment names the key the resolver reads",
};

function sourceFiles(rel: string): string[] {
  const abs = path.join(packagesRoot, rel);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__" && e.name !== "node_modules" && e.name !== "dist") walk(full);
        continue;
      }
      if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) out.push(full);
    }
  };
  walk(abs);
  return out;
}

function mentioningFiles(): { rel: string; consults: boolean }[] {
  const out: { rel: string; consults: boolean }[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(root)) {
      const text = fs.readFileSync(file, "utf8");
      if (!PREF_MENTION.test(text)) continue;
      out.push({
        rel: path.relative(packagesRoot, file).replaceAll("\\", "/"),
        consults: CONSULTS_RESOLVER.test(text),
      });
    }
  }
  return out;
}

describe("start-mode prefs are read only through resolveStartPolicy (#600, decision 008)", () => {
  const files = mentioningFiles();

  it("finds files mentioning the prefs, so the scan cannot pass vacuously", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("every file naming the prefs either consults the resolver or is a declared non-decider", () => {
    const offenders = files
      .filter((f) => !f.consults && !(f.rel in NON_DECIDING))
      .map((f) => f.rel);
    expect(
      offenders,
      "These read the start-mode prefs without consulting resolveStartPolicy.\n" +
        "A raw read misses the legacy board_autodrive_ derivation, so a driven project looks\n" +
        "unset (and `manual` stops being a true kill-switch). Use resolveStartPolicy(prefMap,\n" +
        "projectId), or add the file to NON_DECIDING with the reason it does not decide:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("no NON_DECIDING entry is stale", () => {
    // An entry whose file stopped mentioning the prefs (or started consulting the resolver)
    // is dead weight that would silently excuse a future raw read in the same path.
    const known = new Map(files.map((f) => [f.rel, f]));
    const stale = Object.keys(NON_DECIDING).filter((rel) => !known.has(rel));
    expect(stale, `NON_DECIDING entries that no longer mention the prefs: ${stale.join(", ")}`).toEqual([]);
  });
});
