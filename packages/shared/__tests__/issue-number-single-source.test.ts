import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture gate: per-project issue-number allocation (`MAX(issue_number) + 1`)
 * may be expressed as raw SQL in exactly TWO sanctioned places —
 *   - `packages/server/src/repositories/issue-number.repository.ts` (server allocator)
 *   - `packages/mcp-server/src/db-utils.ts`                         (mcp allocator)
 * Every other create path must call those allocators (`nextIssueNumber` /
 * `getMaxIssueNumber`) instead of writing its own `max(...issueNumber...)` query.
 *
 * This logic was previously copy-pasted across five server repositories plus three
 * inline queries in issue.repository.ts, and the copies had a drifted `?? 0` vs `?? null`
 * default — exactly the kind of divergence that yields a duplicate issue number. The
 * two allocators are separate because server and mcp-server run against different
 * drizzle clients and mcp may not import server internals (lint:arch boundary); both
 * are the single source for their own package.
 *
 * Tests are excluded: a couple of test helpers seed fixtures with their own MAX+1.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

/** The only files allowed to write raw issue-number MAX SQL. Relative to REPO_ROOT. */
const ALLOWLIST = new Set([
  join("packages", "server", "src", "repositories", "issue-number.repository.ts"),
  join("packages", "mcp-server", "src", "db-utils.ts"),
]);

/** Raw `max(... issueNumber ...)` SQL — drizzle `max(issues.issueNumber)` or sql`max(${...issueNumber})`. */
const RAW_ISSUE_NUMBER_MAX = /max\([^)]*issueNumber/i;

function isExcluded(absPath: string): boolean {
  const parts = absPath.split(sep);
  return (
    parts.includes("node_modules") ||
    parts.includes("dist") ||
    parts.includes(".worktrees") ||
    parts.includes("__tests__") ||
    absPath.endsWith(".test.ts") ||
    absPath.endsWith(".spec.ts")
  );
}

function collectSourceFiles(dir: string, out: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (isExcluded(full)) continue;
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
}

describe("issue-number single-source gate", () => {
  it("no package source derives issue numbers outside the sanctioned allocators", () => {
    const files: string[] = [];
    for (const pkg of ["server", "mcp-server"]) {
      collectSourceFiles(join(REPO_ROOT, "packages", pkg, "src"), files);
    }

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOWLIST.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (RAW_ISSUE_NUMBER_MAX.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }

    expect(
      offenders,
      `These files derive issue numbers directly instead of calling nextIssueNumber/` +
        `getMaxIssueNumber from the sanctioned allocator:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("both allocators still hold the raw MAX query (allowlist is live, not stale)", () => {
    for (const rel of ALLOWLIST) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(RAW_ISSUE_NUMBER_MAX.test(text), `${rel} no longer contains the MAX query`).toBe(true);
    }
  });
});
