import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  AUTO_MERGE_DEFAULT_ENABLED,
  AUTO_MERGE_PREF_KEY,
  isAutoMergeEnabled,
} from "@agentic-kanban/shared/lib/auto-merge-pref";

describe("isAutoMergeEnabled — canonical auto_merge accessor (#866)", () => {
  it("defaults to ENABLED when the key is unset", () => {
    // Regression: the merge orchestrator used `!== "false"` (default ON) while the
    // monitor/Drive-UI/board-status used `=== "true"` (default OFF). With the key unset
    // they disagreed — behaviour said merge, the surfaced status said disabled. The
    // canonical default is ON.
    expect(AUTO_MERGE_DEFAULT_ENABLED).toBe(true);
    expect(isAutoMergeEnabled(new Map())).toBe(true);
  });

  it("is enabled for the explicit string 'true'", () => {
    expect(isAutoMergeEnabled(new Map([[AUTO_MERGE_PREF_KEY, "true"]]))).toBe(true);
  });

  it("is disabled ONLY for the explicit string 'false'", () => {
    expect(isAutoMergeEnabled(new Map([[AUTO_MERGE_PREF_KEY, "false"]]))).toBe(false);
  });

  it("treats any other non-empty value as enabled (default-ON semantics)", () => {
    expect(isAutoMergeEnabled(new Map([[AUTO_MERGE_PREF_KEY, ""]]))).toBe(true);
    expect(isAutoMergeEnabled(new Map([[AUTO_MERGE_PREF_KEY, "1"]]))).toBe(true);
  });
});

describe("no contradictory auto_merge defaults remain (#866)", () => {
  // Scan server + mcp-server src for raw `auto_merge` reads that hand-roll a default
  // (`=== "true"` / `!== "false"`) instead of going through isAutoMergeEnabled. The
  // GLOBAL key is `auto_merge`; per-project `auto_merge_disabled_<id>` and
  // `auto_merge_in_review` are different keys with their own intentional semantics and
  // do not match this pattern (a char follows `auto_merge` before the closing quote).
  const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
  const scanRoots = [
    path.join(packagesRoot, "server", "src"),
    path.join(packagesRoot, "mcp-server", "src"),
  ];

  function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        out.push(...listTsFiles(full));
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  it("no server/mcp src reads the global auto_merge key with a hand-rolled default", () => {
    const offenders: string[] = [];
    const pattern = /get\(\s*["']auto_merge["']\s*\)\s*(===|!==)/;
    for (const root of scanRoots) {
      for (const file of listTsFiles(root)) {
        const text = fs.readFileSync(file, "utf-8");
        for (const [i, line] of text.split(/\r?\n/).entries()) {
          if (pattern.test(line)) offenders.push(`${path.relative(packagesRoot, file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `Route these through isAutoMergeEnabled():\n${offenders.join("\n")}`).toEqual([]);
  });
});
