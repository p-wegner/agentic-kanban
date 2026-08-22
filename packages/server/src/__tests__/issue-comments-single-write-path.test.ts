// @gate:always-run — recursively walks every package `src/` tree, so its subject is not
// reachable through its own import graph and scoped test selection would skip it.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
/**
 * The ONE file allowed to spawn an `issue_comments` INSERT. Everything else goes through
 * `insertIssueComment`, because that is where the identical-repeat collapse lives (#738) — a
 * second raw insert site is exactly how the rule stops being a property of the table.
 */
const WRITE_PATH = "packages/server/src/repositories/issue-comments.repository.ts";

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
    const full = join(dir, name);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("issue_comments has a single write path (#738)", () => {
  it("no file outside the comment repository inserts into issueComments", () => {
    const packagesDir = join(REPO_ROOT, "packages");
    const files: string[] = [];
    for (const pkg of readdirSync(packagesDir)) walk(join(packagesDir, pkg, "src"), files);
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file).split("\\").join("/");
      if (rel === WRITE_PATH) continue;
      const src = readFileSync(file, "utf-8");
      if (/\.insert\(\s*issueComments\s*\)/.test(src)) offenders.push(rel);
    }
    expect(offenders, `route these through insertIssueComment() so the dedup applies: ${offenders.join(", ")}`).toEqual([]);
  });
});
