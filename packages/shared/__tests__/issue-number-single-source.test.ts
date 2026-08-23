// @gate:always-run — whole-tree scan for hand-rolled issue-number derivation; imports nothing it checks (#647).
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseGuardSource, forEachNode, lineOf } from "./helpers/guard-scan.js";

/**
 * Architecture gate: per-project issue-number allocation (`MAX(issue_number) + 1`) may be
 * expressed as raw SQL in exactly ONE place — `packages/shared/src/lib/issue-number.ts`,
 * the `shared-db-op` that both the server allocator
 * (`repositories/issue-number.repository.ts`) and the mcp allocator (`db-utils.ts`)
 * delegate to. Every other create path must call those allocators (`nextIssueNumber` /
 * `getMaxIssueNumber`) instead of writing its own `max(...issueNumber...)` query.
 *
 * This logic was previously copy-pasted across five server repositories plus three inline
 * queries in issue.repository.ts, and the copies had a drifted `?? 0` vs `?? null` default
 * — exactly the kind of divergence that yields a duplicate issue number.
 *
 * Tests are excluded: a couple of test helpers seed fixtures with their own MAX+1.
 *
 * ## Why this is an AST pass and not a per-line regex (#794, following #779)
 *
 * The old scan tested `max([^)]*issueNumber` against one LINE at a time, so a query wrapped
 * across lines — the shape Prettier produces for a long `.select({...})` — carried the two
 * halves on different lines and was invisible. A `CallExpression` and a template literal are
 * each ONE node however they are printed, so the wrap cannot hide either.
 *
 * The conversion also surfaced a live defect the text scan had been papering over, which is
 * the #779 lesson repeating: the "allowlist is live, not stale" check ran a regex over the
 * WHOLE file, and comments are text. Both allocators had long since delegated their query to
 * `shared/lib/issue-number.ts` and kept only PROSE mentioning `max(...issueNumber...)` — so
 * the check was green on two files that no longer contained the query at all, and the real
 * allocator sat in a package this guard did not even scan. Comments are not AST nodes, so the
 * converted check could not stay green that way; the allowlist and the scan roots now name
 * where the query actually is.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

/** The only file allowed to write raw issue-number MAX SQL. Relative to REPO_ROOT. */
const ALLOWLIST = new Set([join("packages", "shared", "src", "lib", "issue-number.ts")]);

/** Raw `max(... issueNumber ...)` SQL, as a node-bounded shape rather than a line. */
const ISSUE_NUMBER_MAX_TEXT = /max\([\s\S]*?issueNumber/i;

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
  let entries: string[];
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

export interface IssueNumberMaxHit {
  line: number;
  text: string;
}

/**
 * Every raw issue-number MAX derivation in one source text. Two node kinds carry it:
 * a `max(...)` CALL (the drizzle helper) and a template literal holding the SQL text
 * (`` sql`max(${issues.issueNumber})` ``). Exported so the proof cases below drive the REAL
 * scanner rather than a copy of its predicate.
 */
export function scanIssueNumberMax(cacheKey: string, text: string): IssueNumberMaxHit[] {
  const sf = parseGuardSource(cacheKey, text);
  const hits: IssueNumberMaxHit[] = [];
  const push = (node: ts.Node): void => {
    hits.push({ line: lineOf(sf, node), text: node.getText(sf).replace(/\s+/g, " ").slice(0, 120) });
  };
  forEachNode(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text.toLowerCase() === "max") {
      if (node.arguments.some((argument) => /issueNumber/i.test(argument.getText(sf)))) push(node);
      return;
    }
    // The SQL is a string in a tagged template, not a call — one node, so a wrap inside it
    // is invisible, and a comment mentioning the same words is not this node kind at all.
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (ISSUE_NUMBER_MAX_TEXT.test(node.getText(sf))) push(node);
    }
  });
  return hits;
}

describe("issue-number single-source gate", () => {
  const sourceFiles = (): string[] => {
    const files: string[] = [];
    for (const pkg of ["server", "mcp-server", "shared"]) {
      collectSourceFiles(join(REPO_ROOT, "packages", pkg, "src"), files);
    }
    return files;
  };

  it("no package source derives issue numbers outside the sanctioned allocator", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOWLIST.has(rel)) continue;
      for (const hit of scanIssueNumberMax(file, readFileSync(file, "utf8"))) {
        offenders.push(`${rel}:${hit.line}  ${hit.text}`);
      }
    }
    expect(
      offenders,
      `These files derive issue numbers directly instead of calling nextIssueNumber/` +
        `getMaxIssueNumber from the sanctioned allocator:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the allocator still holds the raw MAX query (allowlist is live, not stale)", () => {
    for (const rel of ALLOWLIST) {
      const abs = join(REPO_ROOT, rel);
      // Deliberately the AST scan and not a text match: a file that only TALKS about the
      // query in a comment must not keep this green, which is precisely how the previous
      // two-entry allowlist survived the query moving out of both of its files.
      expect(scanIssueNumberMax(abs, readFileSync(abs, "utf8")).length, `${rel} no longer contains the MAX query`)
        .toBeGreaterThan(0);
    }
  });

  it("the scan reaches a real tree, so the gate cannot pass vacuously", () => {
    expect(sourceFiles().length).toBeGreaterThan(200);
  });
});

/**
 * #779's proof obligation (#794): the conversion must catch the form the old per-line
 * version could not see, and still catch the one it did.
 */
describe("the issue-number scan sees forms the per-line version could not (#794)", () => {
  const scan = (name: string, lines: string[]): IssueNumberMaxHit[] =>
    scanIssueNumberMax(`/virtual/issue-number/${name}.ts`, lines.join("\n"));

  it("still catches the one-line drizzle max() the regex caught", () => {
    expect(scan("one-line", ["const row = await db.select({ n: max(issues.issueNumber) }).from(issues);"])).toHaveLength(
      1,
    );
  });

  it("still catches the one-line sql`` template form", () => {
    expect(scan("one-line-sql", ["const q = sql<number>`max(${issues.issueNumber})`;"])).toHaveLength(1);
  });

  it("catches a max() call WRAPPED across lines — invisible to the per-line match", () => {
    // `max(` and `issueNumber` sit on different lines, so no single line carried both.
    const hits = scan("wrapped-call", [
      "const row = await db",
      "  .select({",
      "    n: max(",
      "      issues.issueNumber,",
      "    ),",
      "  })",
      "  .from(issues);",
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(3);
  });

  it("catches a sql`` template wrapped across lines", () => {
    const hits = scan("wrapped-sql", ["const q = sql<number | null>`max(", "  ${issues.issueNumber}", ")`;"]);
    expect(hits).toHaveLength(1);
  });

  it("does not count PROSE about the query, which the text scan did — the live defect this found", () => {
    const hits = scan("prose", [
      "// Only the allocators may write `max(...issueNumber...)` SQL; everyone else calls",
      "// nextIssueNumber().",
      "/* Replaces the duplicate max(issueNumber) SQL in create-issue. */",
      "export async function getMaxIssueNumber(): Promise<number> {",
      "  return sharedGetMaxIssueNumber();",
      "}",
    ]);
    expect(hits).toEqual([]);
  });

  it("does not count an unrelated Math.max or a max() over another column", () => {
    expect(scan("unrelated", ["const n = Math.max(2, count);", "const m = max(issues.sortOrder);"])).toEqual([]);
  });
});
