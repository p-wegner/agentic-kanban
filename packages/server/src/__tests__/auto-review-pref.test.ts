import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  AUTO_REVIEW_DEFAULT_ENABLED,
  AUTO_REVIEW_PREF_KEY,
  isAutoReviewEnabled,
} from "@agentic-kanban/shared/lib/auto-review-pref";

describe("isAutoReviewEnabled — canonical auto_review accessor (#946)", () => {
  it("defaults to ENABLED when the key is unset", () => {
    // Regression: exit-workflow / stranded-review reconciler / client used `!== "false"`
    // (default ON) while project-runtime-config (drive status + preflight) used
    // `=== "true"` (default OFF). With the key unset the dashboard said review OFF
    // while the exit workflow actually ran reviews. The canonical default is ON.
    expect(AUTO_REVIEW_DEFAULT_ENABLED).toBe(true);
    expect(AUTO_REVIEW_PREF_KEY).toBe("auto_review");
    expect(isAutoReviewEnabled(undefined)).toBe(true);
    expect(isAutoReviewEnabled(null)).toBe(true);
  });

  it("is enabled for the explicit string 'true'", () => {
    expect(isAutoReviewEnabled("true")).toBe(true);
  });

  it("is disabled ONLY for the explicit string 'false'", () => {
    expect(isAutoReviewEnabled("false")).toBe(false);
  });

  it("treats any other non-empty value as enabled (default-ON semantics)", () => {
    expect(isAutoReviewEnabled("")).toBe(true);
    expect(isAutoReviewEnabled("1")).toBe(true);
  });
});

describe("no contradictory auto_review defaults remain (#946)", () => {
  // Scan server + mcp-server + client src for raw `auto_review` reads that hand-roll a
  // default (`=== "true"` / `!== "false"`) instead of going through isAutoReviewEnabled.
  // The GLOBAL key is `auto_review`; `skip_auto_review` / `skipAutoReview` are different
  // flags with their own intentional semantics and do not match these patterns.
  const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
  const scanRoots = [
    path.join(packagesRoot, "server", "src"),
    path.join(packagesRoot, "mcp-server", "src"),
    path.join(packagesRoot, "client", "src"),
  ];

  function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        out.push(...listTsFiles(full));
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  it("no server/mcp/client src reads the auto_review key with a hand-rolled default", () => {
    const offenders: string[] = [];
    const patterns = [
      /get\(\s*["']auto_review["']\s*\)\s*(===|!==)/, // prefMap.get("auto_review") === / !==
      /\.auto_review\s*(===|!==)/, // settings.auto_review !== "false" (client style)
    ];
    for (const root of scanRoots) {
      for (const file of listTsFiles(root)) {
        const text = fs.readFileSync(file, "utf-8");
        for (const [i, line] of text.split(/\r?\n/).entries()) {
          if (patterns.some((p) => p.test(line))) offenders.push(`${path.relative(packagesRoot, file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `Route these through isAutoReviewEnabled():\n${offenders.join("\n")}`).toEqual([]);
  });
});
