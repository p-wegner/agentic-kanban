#!/usr/bin/env node
// test-inventory.mjs — deterministic inventory of a repo's existing tests.
// Anchors coverage-intelligence Phase 0: turns "does a test cover X?" into a lookup.
//
// Usage:  node test-inventory.mjs <repo-root> [--dirs <glob,glob>] [--churn] > _test-index.json
//
// Stack-aware defaults scan common test locations (Playwright e2e, vitest unit/integration,
// pytest, go test, …). Per test file it extracts: describe/test titles, API paths hit,
// routes visited, MCP tools invoked, fixture imports, and a crude assertion count — purely
// by static regex (no execution), so it is safe and fast on any repo.
//
// Output: { schema, repo, generated_from_sha, files: [ { file, runner, titles[], api_paths[],
//           routes[], mcp_tools[], assertions, loc } ], totals }

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, extname } from "node:path";
import { execSync } from "node:child_process";

const repo = process.argv[2] || ".";
const argv = process.argv.slice(3);
const wantChurn = argv.includes("--churn");
const dirsArg = (() => {
  const i = argv.indexOf("--dirs");
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(",") : null;
})();

// Default test roots to probe (only those that exist are scanned).
const DEFAULT_DIRS = [
  "packages/e2e/tests",
  "packages/server/src/__tests__",
  "packages/shared/__tests__",
  "packages/client/src",
  "packages/mcp-server/src/__tests__",
  "tests", "test", "e2e", "__tests__", "spec",
];

const TEST_FILE = /\.(test|spec)\.[tj]sx?$|_test\.(py|go)$|test_.*\.py$/;
const isTestFile = (f) => TEST_FILE.test(f);

function walk(dir, acc) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".worktrees")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (isTestFile(e.name)) acc.push(p);
  }
  return acc;
}

function runnerFor(file) {
  if (file.includes(`${sep}e2e${sep}`) || /playwright/.test(file)) return "playwright";
  const ext = extname(file);
  if (ext === ".py") return "pytest";
  if (ext === ".go") return "gotest";
  return "vitest";
}

// --- crude static extractors (regex; intentionally conservative) ---
const reTitle = /\b(?:test|it|describe)(?:\.\w+)?\s*\(\s*[`'"]([^`'"]+)[`'"]/g;
const rePyTest = /\bdef\s+(test_\w+)\s*\(/g;
const reGoTest = /\bfunc\s+(Test\w+)\s*\(/g;
const reApiPath = /[`'"](\/(?:api|mcp)\/[A-Za-z0-9_\-/.${}:]+)[`'"]/g;
const reGoto = /\.goto\(\s*[`'"]([^`'"]+)[`'"]/g;
const reMcp = /mcp__[a-z0-9_-]+__([a-z0-9_]+)/gi;
const reMcpCall = /\b(?:callTool|tools?\.)\s*[`'"]?([a-z_]+)[`'"]?/g; // best-effort
const reAssert = /\b(expect|assert|should|require\.|assert\.)\b/g;
// import/require specifiers — used to match a test to a capability by the SOURCE it exercises,
// not just by slug keyword (a unit test like merge-cascade.test.ts covers workspaces without
// carrying the word "workspace"). The last path segment is the highest-signal token.
const reImport = /(?:from|require\(|import\(|import)\s*[`'"]([^`'"]+)[`'"]/g;

function collect(re, src, idx = 1) {
  const out = new Set();
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(src))) out.add(m[idx]);
  return [...out];
}

function inventoryFile(abs) {
  const src = readFileSync(abs, "utf8");
  const runner = runnerFor(abs);
  let titles;
  if (runner === "pytest") titles = collect(rePyTest, src);
  else if (runner === "gotest") titles = collect(reGoTest, src);
  else titles = collect(reTitle, src);
  return {
    file: relative(repo, abs).split(sep).join("/"),
    runner,
    titles,
    api_paths: collect(reApiPath, src),
    routes: collect(reGoto, src),
    mcp_tools: [...new Set([...collect(reMcp, src), ...collect(reMcpCall, src)])]
      .filter((t) => t && t.length > 2),
    // imported module specifiers + their basenames — match candidates to a capability's source_paths
    imports: collect(reImport, src).filter((s) => s.startsWith(".") || s.startsWith("@")),
    import_basenames: [
      ...new Set(
        collect(reImport, src)
          .map((s) => s.replace(/\.[jt]sx?$/, "").split("/").pop())
          .filter((s) => s && s.length > 2 && s !== "index")
      ),
    ],
    assertions: (src.match(reAssert) || []).length,
    loc: src.split("\n").length,
  };
}

function churnMap() {
  if (!wantChurn) return {};
  try {
    const out = execSync(
      `git -C "${repo}" log --since=90.days --name-only --pretty=format: -- "*.ts" "*.tsx" "*.py" "*.go"`,
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    const counts = {};
    for (const line of out.split("\n")) {
      const f = line.trim();
      if (f) counts[f] = (counts[f] || 0) + 1;
    }
    return counts;
  } catch {
    return {};
  }
}

function sha() {
  try { return execSync(`git -C "${repo}" rev-parse HEAD`, { encoding: "utf8" }).trim(); }
  catch { return null; }
}

const roots = (dirsArg || DEFAULT_DIRS)
  .map((d) => join(repo, d))
  .filter((d) => existsSync(d) && statSync(d).isDirectory());

const testFiles = [];
for (const r of roots) walk(r, testFiles);

const files = testFiles.map(inventoryFile);
const churn = churnMap();

const out = {
  schema: "verification-model/test-index@1",
  repo: relative(process.cwd(), repo) || ".",
  generated_from_sha: sha(),
  scanned_roots: roots.map((d) => relative(repo, d).split(sep).join("/")),
  files,
  churn_90d: churn,
  totals: {
    files: files.length,
    tests: files.reduce((n, f) => n + f.titles.length, 0),
    assertions: files.reduce((n, f) => n + f.assertions, 0),
    api_paths: [...new Set(files.flatMap((f) => f.api_paths))].length,
  },
};

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
