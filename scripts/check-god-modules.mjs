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
//
// #726: the gate used to measure SIZE only, and size is the one property a
// decomposition can move without decoupling anything — so a second, orthogonal
// signal now runs beside it: MAX FUNCTION BRANCH COMPLEXITY (see
// MAX_FUNCTION_BRANCHES below).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Scan root. Defaults to the repo root (this script lives in <root>/scripts). A
// `--root <dir>` override lets a test point the gate at an ISOLATED temp tree so its
// probe file never lands in the live source tree that the parallel arch gates
// (git-exec-single-spawn, max-file-size, dependency-cruiser) scan concurrently — that
// shared-tree write was a real ENOENT/phantom-offender race (#62).
function parseRootArg(argv) {
  const i = argv.indexOf("--root");
  if (i !== -1 && argv[i + 1]) return resolve(argv[i + 1]);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}
const REPO_ROOT = parseRootArg(process.argv.slice(2));
const MAX_LINES = 1000;
// The cohesion signal counts a module's top-level function-like DECLARATIONS —
// exported AND internal (arch-review #889). Exports alone undercount: a low-cohesion
// god-module can hide many independent responsibilities behind a handful of exports
// (agent-stream-parser.ts: 3 exports, 28 internal fns at 1042 lines, waved straight
// through the old export-only signal). The count = top-level `function`/`class`
// declarations + top-level arrow/function-expression consts (exported or not). It is
// deliberately TOP-LEVEL only — nested callbacks/handlers belong to their enclosing
// function and are not separate responsibilities — and ignores `const` data tables and
// type/interface exports (cohesive data/contracts, not behaviors).
//
// The signal fires on the COUNT ALONE, with no line-count floor (#977). It used to
// require 600+ lines, which left a blind spot: a 450-line file declaring 31 top-level
// functions is a low-cohesion god-module by this gate's own definition, yet sat
// invisible below the floor (and could grow unchecked until it crossed 600 already
// deep in breach). Files that were resident in that blind spot when the floor was
// removed are grandfathered in COHESION_BASELINE like every other legacy offender.
const COHESION_MAX_FN_DECLS = 20;

// Ratchet baseline (arch-review #889). These large modules already exceeded the
// internal-declaration threshold when it was introduced. They are grandfathered at
// their CURRENT count so the merge-blocking gate ships green, while still BLOCKING any
// new breach and any GROWTH of a baselined file — a baselined file may only shrink
// (decompose it and lower/remove its entry). The number is max(AST, regex-heuristic)
// so the gate passes on BOTH counting paths. Decomposition is tracked on the board
// (#911 stack-profile, #912 agent-questions, #913 the rest); drop a file's entry once
// it is split. Goal: drain this map to empty so the flat threshold governs everything.
const COHESION_BASELINE = {
  // session-summary.ts rewritten to consume the agent-stream parsers (#951) — entry removed.
  "packages/server/src/services/butler-sdk.service.ts": 30,
  // #957: the blanket /repositories/ cohesion exemption was removed — the large
  // aggregate repositories are now RATCHETED instead of invisible. They may only shrink.
  "packages/server/src/repositories/issue.repository.ts": 36,
  // session.repository.ts decomposed into ./session/* sub-modules (#45); the facade
  // barrel re-exports only, so its baseline entry is removed.
  // stack-profile.service.ts decomposed behind a facade barrel (#911) — entry removed.
  // git-info.service.ts: the source-tree walk moved to ./git-info/code-metrics.ts (#340),
  // taking it under the flat threshold — entry removed.
  "packages/server/src/services/agent.service.ts": 28, // #167 added a legitimate write site
  "packages/server/src/services/insights.service.ts": 23,
  // agent-questions.service.ts decomposed into ./agent-questions/* sub-modules (#912);
  // the facade barrel re-exports only, so its baseline entry is removed.
  // #977: the 600-line cohesion floor was removed (the count fires alone now). These
  // files sat in the old blind spot — under 600 lines but over 20 top-level function
  // declarations — and are grandfathered at their current count. Shrink-only, same as
  // every entry above.
  // workflow-fork.repository.ts decomposed into ./workflow-fork-{children,join,session-reads,
  // phase,launch-context}.repository.ts (#722); the facade barrel re-exports only, so its
  // baseline entry is removed.
  "packages/server/src/repositories/issue-ai.repository.ts": 31,
  "packages/server/src/repositories/issue-service.repository.ts": 30,
  "packages/server/src/repositories/workspace-crud.repository.ts": 27,
  "packages/server/src/scripts/mock-agent.ts": 23,
  // workspace.repository.ts decomposed into ./workspace-{reads,mutations,analytics,
  // project-resolution,issue-status}.repository.ts (#913); the facade barrel
  // re-exports only, so its baseline entry is removed.
  "packages/server/src/repositories/session-lifecycle.repository.ts": 22, // #172 added updateSessionContainerId
  "packages/server/src/services/stale-dev-processes.ts": 21, // #172 zombie-fleet sweep additions
  "packages/shared/src/lib/openspec.ts": 21,
};

// ---------------------------------------------------------------------------
// Signal 3: MAX BRANCH COMPLEXITY OF A SINGLE FUNCTION (#726).
//
// Why a third signal at all. The line ceiling and the cohesion count are both
// SIZE measures — one counts lines, the other counts top-level declarations —
// and a file split moves both without changing any single function. #229 is the
// worked example the ticket was filed on: plugin.service.ts was split to satisfy
// the 1000-line ceiling and came out at 364 lines. Meanwhile the two functions
// with the highest branch complexity in this repo sit in files that pass the
// ceiling with room to spare (agent-stream/copilot.ts, 341 lines / 41 branches)
// or park just under it (WorkspaceCard.tsx, 966 lines / 35 branches). A green
// gate said nothing about either.
//
// Max-per-FUNCTION, not summed-per-file, is the point: a per-file sum is just
// size again, and a split lowers it for free. A single function's branch count
// cannot be lowered by moving it — you have to actually restructure it. Moving a
// too-branchy function into a NEW file does not launder it either, because the
// new path is not in the baseline and the flat threshold applies to it.
//
// WHAT IS COUNTED: control-flow constructs only — `if`, the three `for` forms,
// `while`/`do`, each non-default `case`, `catch`, and the `?:` conditional. Plus
// one for the function itself, so a straight-line function scores 1 (McCabe).
//
// WHAT IS DELIBERATELY NOT COUNTED: the logical operators `&&`, `||` and `??`.
// Textbook McCabe counts them, and this gate measured both ways before choosing.
// Including them made the metric a proxy for two things that are not risk: JSX
// conditional rendering (39 of 253 .tsx files landed above the threshold vs 3
// without, and copilot.ts's parseCopilotEvent read 156 instead of 41), and
// defensive `?? fallback` / `a || b` defaulting, which is the idiom that makes
// code SAFER. Excluding them left a signal that separates 22 files from 1426
// instead of smearing 99 across the tree — and the 22 are a list a reviewer
// recognises (runAutoStart, runPreMergeGate, startSession, parseCopilotEvent).
//
// REJECTED alternatives, for the next person who wonders:
//   - Nesting depth: co-linear with branch count (already captured here) and it
//     saturates — measured peak 9 with a long flat tail, so it ranks almost
//     nothing.
//   - Fan-out / fan-in ("blast radius"): needs a resolved cross-package import
//     graph, which `lint:arch` (dependency-cruiser) already owns. Worse, fan-out
//     is trivially lowered by a facade barrel — the very remedy this gate's
//     message recommends — and fan-IN is a property of a file's IMPORTERS, so a
//     file's verdict would flip when an unrelated file adds an import, leaving
//     the author with a failure they cannot fix locally.
//   - Complexity weighted by absence of tests: this repo's suites live in
//     `__tests__/` named by concept, not per source file, so source->test
//     mapping would be a guess; and the guess is gamed by adding a trivial test.
const MAX_FUNCTION_BRANCHES = 25;

// Ratchet baseline, measured on the tree at #726 (2026-08-22). Shrink-only, exactly
// like COHESION_BASELINE: the value is the file's WORST function today, growth past
// it FAILS, and a file that improves should have its entry lowered (the gate prints
// the stale entries so nobody has to guess). Threshold 25 sits at ~p98.5 — the
// measured distribution is p50=5, p75=9, p90=13, p95=18, p99=28, max=55.
// Drain this map by restructuring the named function, not by moving it.
const COMPLEXITY_BASELINE = {
  "packages/client/src/components/BoardColumn.tsx": 26,
  "packages/client/src/components/TerminalEventRenderer.tsx": 36,
  "packages/client/src/components/WorkspaceCard.tsx": 34,
  "packages/client/src/lib/butler-event-reducer.ts": 31,
  "packages/client/src/lib/terminal-transcript.ts": 27,
  "packages/mcp-server/src/tools/reviewer-fixes.ts": 26,
  "packages/server/src/cli/commands/status.ts": 30,
  "packages/server/src/cli/commands/system.ts": 32,
  "packages/server/src/routes/projects.ts": 30,
  "packages/server/src/services/backlog-markdown.service.ts": 41,
  "packages/server/src/services/pre-merge-gate.service.ts": 37,
  "packages/server/src/services/preflight-check.ts": 26,
  "packages/server/src/services/session-manager/session-lifecycle.ts": 38,
  "packages/server/src/services/workspace-scorecard.service.ts": 27,
  "packages/server/src/startup/ancestor-branch-reconciler.ts": 26,
  // monitor-auto-start.ts: runAutoStart restructured into runInProgressBackfill /
  // runTodoPull / evaluateStartCandidate (#802) — 59 branches down to 4, and the file's
  // worst function is now 17, under the flat threshold. Entry REMOVED, not lowered.
  "packages/server/src/startup/monitor-cycle.ts": 30,
  "packages/server/src/startup/monitor-setup.ts": 26,
  "packages/shared/src/lib/agent-stream/copilot.ts": 41,
  "packages/shared/src/lib/backlog-markdown.ts": 41,
  "packages/shared/src/lib/session-summary.ts": 29,
  "packages/shared/src/lib/workflow-engine/graph-validation.ts": 28,
};

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

/**
 * Count the cohesion signal: top-level function-like DECLARATIONS, exported AND
 * internal (#889). Top-level `function`/`class` declarations + top-level
 * arrow/function-expression consts. Nested callbacks are NOT counted (they belong to
 * their enclosing function); `const` data tables and type/interface exports are NOT
 * counted (cohesive data/contracts).
 */
function countInternalFunctions(file, text) {
  if (ts) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let count = 0;
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt)) { count++; continue; }
      if (ts.isClassDeclaration(stmt)) { count++; continue; }
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          const init = decl.initializer;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) count++;
        }
      }
    }
    return count;
  }
  // Heuristic fallback (no typescript installed). Anchored at column 0 so only
  // TOP-LEVEL declarations match — keeps the count aligned with the AST path.
  const fn = (text.match(/^(export\s+)?(async\s+)?function\s+\w+/gm) || []).length;
  const cls = (text.match(/^(export\s+)?(abstract\s+)?class\s+\w+/gm) || []).length;
  const arrow =
    (text.match(/^(export\s+)?const\s+\w+\s*(:[^=\n]+)?=\s*(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*(:[^=\n]+)?=>/gm) || [])
      .length;
  return fn + cls + arrow;
}

/** Every syntactic form that owns a body, i.e. that gets its own complexity score. */
function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

/** 1 for a control-flow branch, 0 otherwise. Logical operators score 0 — see MAX_FUNCTION_BRANCHES. */
function branchWeight(node) {
  return ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isCatchClause(node)
    ? 1
    : 0;
}

/**
 * The branch complexity of the WORST single function in a file (#726), with its name and
 * line so the message points at the thing to restructure. A nested function is scored
 * SEPARATELY rather than folded into its parent — otherwise one component holding twenty
 * small handlers would read as one enormous function, which is the per-file sum again.
 */
function maxFunctionBranches(file, text) {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const queue = [];
  const collectTop = (node) => {
    node.forEachChild((child) => {
      if (isFunctionLike(child)) queue.push(child);
      else collectTop(child);
    });
  };
  collectTop(sf);

  let worst = { branches: 0, name: "", line: 0 };
  while (queue.length > 0) {
    const fn = queue.shift();
    let branches = 1;
    const walk = (node) => {
      node.forEachChild((child) => {
        if (isFunctionLike(child)) {
          queue.push(child);
          return;
        }
        branches += branchWeight(child);
        walk(child);
      });
    };
    walk(fn);
    if (branches > worst.branches) {
      worst = {
        branches,
        name: fn.name && ts.isIdentifier(fn.name) ? fn.name.text : "<anonymous>",
        line: sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1,
      };
    }
  }
  return worst;
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
const complexityOffenders = [];
const complexityStale = [];
let peakComplexity = { branches: 0, rel: "", name: "", line: 0 };
let overThreshold = 0;

for (const file of files) {
  const rel = relative(REPO_ROOT, file).split(sep).join("/");
  const text = readFileSync(file, "utf8");
  const lines = lineCount(text);
  if (lines > MAX_LINES) lineOffenders.push(`${rel}  (${lines} lines)`);
  if (ts) {
    const worst = maxFunctionBranches(file, text);
    if (worst.branches > peakComplexity.branches) peakComplexity = { ...worst, rel };
    if (worst.branches > MAX_FUNCTION_BRANCHES) overThreshold++;
    const baselined = COMPLEXITY_BASELINE[rel];
    const allowedBranches = Math.max(MAX_FUNCTION_BRANCHES, baselined ?? 0);
    if (worst.branches > allowedBranches) {
      const note = baselined ? ` — grandfathered at ${baselined}, GREW past its baseline` : "";
      complexityOffenders.push(`${rel}:${worst.line}  ${worst.name}() has ${worst.branches} branches${note}`);
    } else if (baselined !== undefined && worst.branches < baselined) {
      // Reported, never failed: a baseline nobody lowers stops being a ceiling and becomes a
      // budget the next regression hides inside. Only for files present in THIS scan, so a
      // `--root` probe tree does not report the whole map as stale.
      complexityStale.push(`${rel}: now ${worst.branches}, baselined at ${baselined} — lower it`);
    }
  }
  const fnDecls = countInternalFunctions(file, text);
  const allowed = Math.max(COHESION_MAX_FN_DECLS, COHESION_BASELINE[rel] ?? 0);
  if (fnDecls > allowed) {
    const baselineNote = COHESION_BASELINE[rel]
      ? ` — grandfathered at ${COHESION_BASELINE[rel]}, GREW past its baseline`
      : "";
    cohesionOffenders.push(`${rel}  (${lines} lines, ${fnDecls} functions/classes${baselineNote})`);
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
    `\n[god-module gate] ${cohesionOffenders.length} module(s) declare more than ` +
      `${COHESION_MAX_FN_DECLS} top-level functions/classes (exported + internal) — a low-cohesion ` +
      `god-module smell (#889).\n` +
      `Split by responsibility into cohesive sub-modules re-exported through a facade barrel:\n  ` +
      cohesionOffenders.join("\n  "),
  );
}

if (complexityOffenders.length > 0) {
  failed = true;
  console.error(
    `\n[god-module gate] ${complexityOffenders.length} function(s) exceed ${MAX_FUNCTION_BRANCHES} ` +
      `control-flow branches (#726) — the risk signal a file split cannot move.\n` +
      `RESTRUCTURE the named function (guard clauses, a lookup table instead of a switch, extract ` +
      `the branchy middle). Moving it to another file does NOT clear this: the new path is not in ` +
      `the ratchet baseline, so the flat threshold applies to it there.\n  ` +
      complexityOffenders.join("\n  "),
  );
}

if (failed) {
  console.error(`\n[god-module gate] FAILED${ts ? "" : " (typescript not installed — cohesion count used a regex heuristic)"}.`);
  process.exit(1);
}

if (complexityStale.length > 0) {
  console.log(
    `[god-module gate] ${complexityStale.length} COMPLEXITY_BASELINE entr` +
      `${complexityStale.length === 1 ? "y is" : "ies are"} stale (the file improved) — lower them, ` +
      `or the slack hides the next regression:\n  ` +
      complexityStale.join("\n  "),
  );
}

// A passing gate must SAY WHAT IT MEASURED. #726 was filed because a green line-count gate
// reported nothing at all about the two most branch-complex functions in the repo.
const complexityNote = ts
  ? `peak function branch complexity ${peakComplexity.branches} (${peakComplexity.name}() at ` +
    `${peakComplexity.rel}:${peakComplexity.line}), ${overThreshold} file(s) over the ` +
    `${MAX_FUNCTION_BRANCHES}-branch threshold, all baselined`
  : `complexity signal SKIPPED — typescript is not installed and branches cannot be approximated by regex`;
console.log(
  `[god-module gate] OK — ${files.length} source files within thresholds` +
    `${ts ? "" : " (regex heuristic for cohesion count)"}; ${complexityNote}.`,
);
