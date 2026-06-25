#!/usr/bin/env node
// Architecture gate: the cohesion-aware god-module guard (arch-review #875, #888),
// as a STANDALONE, merge-blocking check.
//
// Why this exists separately from packages/shared/__tests__/max-file-size.test.ts:
// the vitest gate only fires inside a fully-installed package and is buried in
// `test:mine` — easy to skip, and #888 caught it letting a 1042-line breach merge
// past a red gate. This script is dependency-light (it works with or without the
// `typescript` devDep, falling back to a regex heuristic for the cohesion count),
// exits NON-ZERO on any breach, and is wired into `pnpm check` and CI so it
// actually blocks a merge instead of decorating the test run. The vitest test
// stays as the in-IDE signal; this is the gate of record.
//
// Keep the thresholds and exclusion rules in sync with max-file-size.test.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_LINES = 1000;
const COHESION_MIN_LINES = 600;
const COHESION_MAX_FN_EXPORTS = 15;

// typescript is the precise way to count behavioral exports. If it isn't
// installed (e.g. a partially-provisioned worktree) fall back to a regex
// heuristic so the gate still RUNS rather than silently no-opping.
let ts = null;
try {
  const require = createRequire(import.meta.url);
  ts = require("typescript");
} catch {
  ts = null;
}

function isExcluded(absPath) {
  const parts = relative(REPO_ROOT, absPath).split(sep);
  return (
    parts.includes("node_modules") ||
    parts.includes("dist") ||
    parts.includes(".worktrees") ||
    parts.includes("__tests__") ||
    absPath.endsWith(".test.ts") ||
    absPath.endsWith(".test.tsx") ||
    absPath.endsWith(".spec.ts") ||
    absPath.endsWith(".d.ts")
  );
}

/** The repository layer exports one query fn per operation — broad by design. */
function isRepositoryLayer(rel) {
  return rel.includes("/repositories/");
}

function collectSourceFiles(dir, out) {
  let entries;
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
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
    }
  }
}

function lineCount(text) {
  return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function countFunctionExports(file, text) {
  if (ts) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let count = 0;
    const isExported = (stmt) => {
      const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
      return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    };
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && isExported(stmt)) { count++; continue; }
      if (ts.isClassDeclaration(stmt) && isExported(stmt)) { count++; continue; }
      if (ts.isVariableStatement(stmt) && isExported(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          const init = decl.initializer;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) count++;
        }
      }
    }
    return count;
  }
  // Heuristic fallback (no typescript installed).
  const fn = (text.match(/^export\s+(async\s+)?function\s/gm) || []).length;
  const cls = (text.match(/^export\s+(abstract\s+)?class\s/gm) || []).length;
  const arrow = (text.match(/^export\s+const\s+\w+\s*[:=][^=]*=>/gm) || []).length;
  return fn + cls + arrow;
}

function gatherSourceFiles() {
  const packagesDir = join(REPO_ROOT, "packages");
  const files = [];
  for (const pkg of readdirSync(packagesDir)) {
    if (pkg === ".worktrees") continue;
    collectSourceFiles(join(packagesDir, pkg, "src"), files);
  }
  return files;
}

const files = gatherSourceFiles();
const lineOffenders = [];
const cohesionOffenders = [];

for (const file of files) {
  const rel = relative(REPO_ROOT, file).split(sep).join("/");
  const text = readFileSync(file, "utf8");
  const lines = lineCount(text);
  if (lines > MAX_LINES) lineOffenders.push(`${rel}  (${lines} lines)`);
  if (!isRepositoryLayer(rel) && lines >= COHESION_MIN_LINES) {
    const fnExports = countFunctionExports(file, text);
    if (fnExports > COHESION_MAX_FN_EXPORTS) {
      cohesionOffenders.push(`${rel}  (${lines} lines, ${fnExports} exported functions/classes)`);
    }
  }
}

let failed = false;
if (lineOffenders.length > 0) {
  failed = true;
  console.error(
    `\n[god-module gate] ${lineOffenders.length} file(s) exceed the ${MAX_LINES}-line hard ceiling.\n` +
      `Decompose them (extract a cohesive sub-module, or split behind a facade barrel —\n` +
      `see packages/shared/src/lib/git-service.ts / workflow-engine.ts / agent-stream-parser.ts):\n  ` +
      lineOffenders.join("\n  "),
  );
}
if (cohesionOffenders.length > 0) {
  failed = true;
  console.error(
    `\n[god-module gate] ${cohesionOffenders.length} large module(s) expose more than ` +
      `${COHESION_MAX_FN_EXPORTS} exported functions/classes — a low-cohesion god-module smell.\n` +
      `Split by responsibility into cohesive sub-modules re-exported through a facade barrel:\n  ` +
      cohesionOffenders.join("\n  "),
  );
}

if (failed) {
  console.error(`\n[god-module gate] FAILED${ts ? "" : " (typescript not installed — cohesion count used a regex heuristic)"}.`);
  process.exit(1);
}

console.log(`[god-module gate] OK — ${files.length} source files within thresholds${ts ? "" : " (regex heuristic for cohesion count)"}.`);
