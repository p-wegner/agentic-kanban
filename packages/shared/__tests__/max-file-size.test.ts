// @gate:always-run — scans the tree for oversized/low-cohesion modules; imports nothing it checks (#538).
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseGuardSource } from "./helpers/guard-scan";

/**
 * Architecture gate: a cohesion-aware god-module guard (arch-review #875).
 *
 * The previous gate was a raw 1000-line ceiling. It was honest but it drove
 * threshold-hugging, not cohesion: hand-maintained files clustered just under
 * 1000 (WorkspaceCard.tsx 971, issue.service.ts 948, …) and a 971-line module is
 * still a god-module. Worse, a raw line count both MISSES low-cohesion modules
 * that happen to be < 1000 lines and would FALSELY implicate cohesive large files
 * (a single big React component, the pure-DTO wire contract types/api.ts).
 *
 * So the gate now fires on TWO signals:
 *
 *  1. {@link MAX_LINES} — a hard ceiling kept as an absolute backstop. No single
 *     module should ever be enormous regardless of how cohesive it claims to be.
 *
 *  2. A COHESION signal — a module is a probable god-module when it declares a
 *     broad BEHAVIORAL surface (> {@link COHESION_MAX_FN_DECLS} top-level
 *     functions/classes, EXPORTED AND INTERNAL). Many independent top-level
 *     behaviors in one file = many responsibilities = low cohesion. The signal
 *     fires on the count ALONE — the former 600-line floor was removed (#977): it
 *     left a blind spot where a 450-line file with 31 top-level functions sat
 *     invisible below the floor and could grow unchecked until it crossed 600
 *     already deep in breach. Counting only EXPORTS undercounts (#889): a
 *     god-module hides behind a few exports while declaring dozens of internal
 *     helpers — agent-stream-parser.ts had 3 exports but 28 internal functions at
 *     1042 lines, waved straight through the old export-only signal. The count is
 *     TOP-LEVEL function/class declarations + top-level arrow/function-expression
 *     consts (nested callbacks belong to their enclosing function, not separate
 *     responsibilities), and ignores `const` data tables (gitignore templates,
 *     version pins, lookup maps) and type/interface exports — cohesive data /
 *     contracts, not behaviors.
 *
 * The former blanket REPOSITORY-layer exemption was removed (#957): a data-access
 * module exporting one query fn per operation is broad by design, but "broad by
 * design" had become a blind spot — per-consumer mirror files and 800-line
 * aggregate repos hid behind it. Large repositories are now RATCHETED via
 * COHESION_BASELINE like everything else (they may only shrink). Type-only
 * modules (the wire-contract DTOs) remain naturally exempt — no behavioral surface.
 *
 *  3. MAX BRANCH COMPLEXITY OF A SINGLE FUNCTION (#726) — the signal neither of the
 *     other two can see. Both of the above measure SIZE, and size is the one property a
 *     decomposition moves for free: #229 split plugin.service.ts to satisfy the ceiling
 *     and it came out at 364 lines, while the two most branch-complex functions in the
 *     repo sat (and still sit) in files that clear the ceiling comfortably —
 *     agent-stream/copilot.ts at 341 lines and WorkspaceCard.tsx parked at 966. Max per
 *     FUNCTION, not summed per file: a per-file sum is size again, and a split lowers it
 *     for free, whereas one function's branch count only falls if the function is actually
 *     restructured. See {@link MAX_FUNCTION_BRANCHES} for what is and is not counted, and
 *     why the logical operators are deliberately excluded.
 *
 * The decompose recipe when a file trips: extract a cohesive sub-module, or split
 * a god-file behind a facade barrel — see packages/shared/src/lib/git-service.ts
 * and packages/shared/src/lib/workflow-engine.ts for the pattern. Tests, generated
 * code, dist and vendored code are excluded.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const MAX_LINES = 1000;
// Top-level function-like declarations, exported AND internal (#889). The count fires
// alone — no line-count floor (#977). Keep in sync with scripts/check-god-modules.mjs
// (the merge-blocking gate of record).
const COHESION_MAX_FN_DECLS = 20;

// Ratchet baseline (#889): large modules grandfathered at their current top-level
// declaration count so the gate ships green. A baselined file may only SHRINK — the
// gate fails if it grows past its baseline.
// Decomposition tracked on the board (#911/#912/#913); drop an entry once split.
//
// This map is a SECOND COPY of the one in `scripts/check-god-modules.mjs`, and this
// comment used to say "keep in sync with check-god-modules.mjs" — a hand-sync
// instruction, which is exactly what drifted. #722's decomposition of
// workflow-fork.repository.ts removed that file's entry from the script and this copy
// kept it, so this suite would have let the new facade barrel regrow to 33 declarations
// unnoticed while the script correctly refused. The `baselines match the script` test
// below now asserts the two copies are identical, so the sync is checked rather than
// remembered. (Unifying them into one module is the better fix and is a bigger change
// than a baseline entry: the script is a spawned `.mjs` and this is a typechecked `.ts`
// in another package. The parity test is what makes deferring that safe.)
const COHESION_BASELINE: Record<string, number> = {
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

/**
 * The branch-complexity ceiling for a SINGLE function (#726). Keep in sync with
 * scripts/check-god-modules.mjs, the merge-blocking gate of record — the parity test at the
 * bottom of this file checks that rather than trusting this comment.
 *
 * COUNTED: control flow only — `if`, the three `for` forms, `while`/`do`, each non-default
 * `case`, `catch`, and the `?:` conditional, plus 1 for the function itself (so a
 * straight-line function scores 1, as McCabe defines it).
 *
 * NOT COUNTED: `&&`, `||`, `??`. Textbook McCabe counts them and the gate was measured both
 * ways before choosing. Counting them turned the metric into a proxy for two things that are
 * not risk — JSX conditional rendering (39 of 253 .tsx files landed above the threshold,
 * against 3 without; copilot.ts's parseCopilotEvent read 156 instead of 41) and defensive
 * `?? fallback` defaulting, which is the idiom that makes code safer. Excluded, the signal
 * separates 22 files from 1426 instead of smearing 99 across the tree.
 *
 * Rejected alternatives are recorded in the gate of record: nesting depth (co-linear with
 * this and it saturates), fan-in/fan-out (needs the resolved import graph `lint:arch`
 * already owns; fan-out is lowered by the very facade barrel this gate recommends, and
 * fan-in is a property of a file's importers, so an author could not fix their own
 * failure), and complexity-weighted-by-missing-tests (source-to-test mapping here would be
 * a guess, and the guess is gamed by adding a trivial test).
 */
const MAX_FUNCTION_BRANCHES = 25;

/**
 * Ratchet baseline measured on the tree at #726 (2026-08-22). Shrink-only, exactly like
 * COHESION_BASELINE — growth past the entry FAILS, and an entry the file has outgrown
 * downwards should be lowered (the gate of record prints the stale ones). Threshold 25 sits
 * at ~p98.5 of the measured distribution: p50=5, p75=9, p90=13, p95=18, p99=28, max=55.
 * Drain the map by restructuring the named function, not by moving it: a too-branchy
 * function relocated into a new file lands on a path with no baseline entry, so the flat
 * threshold catches it there.
 */
const COMPLEXITY_BASELINE: Record<string, number> = {
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

function isExcluded(absPath: string): boolean {
  // Check segments RELATIVE to the repo root: when this test runs from inside a
  // worktree the absolute path itself contains ".worktrees" (…/.worktrees/<wt>/…),
  // and matching on the absolute prefix would silently exclude EVERY file, turning
  // the whole gate into a no-op. We only want to skip a NESTED worktree copy that
  // appears below the repo root.
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
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
    }
  }
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * Count the BEHAVIORAL surface: top-level function/class declarations plus top-level
 * arrow-function/function-expression consts — EXPORTED AND INTERNAL (#889). Counting
 * only exports undercounts a god-module that hides internal helpers behind a few
 * exports. Deliberately ignores data consts (lookup tables, templates, version pins)
 * and type/interface exports — cohesive data/contracts, not separate responsibilities
 * — and counts TOP-LEVEL only (nested callbacks belong to their enclosing function).
 */
function countInternalFunctions(file: string, text: string): number {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let count = 0;

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      count++;
      continue;
    }
    if (ts.isClassDeclaration(stmt)) {
      count++;
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) count++;
      }
    }
  }
  return count;
}

/** Every syntactic form that owns a body, i.e. that gets its own complexity score. */
function isFunctionLike(node: ts.Node): boolean {
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

/** 1 for a control-flow branch, 0 otherwise. Logical operators score 0 — see {@link MAX_FUNCTION_BRANCHES}. */
function branchWeight(node: ts.Node): number {
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

interface WorstFunction {
  branches: number;
  name: string;
  line: number;
}

/**
 * The branch complexity of the WORST single function in a file (#726), with its name and line
 * so the failure names the thing to restructure rather than the file to shuffle. A nested
 * function is scored SEPARATELY rather than folded into its parent — folding it in would make
 * one component holding twenty small handlers read as a single enormous function, which is the
 * per-file sum this signal exists to avoid.
 *
 * Parsed through `parseGuardSource` (the memoised `setParentNodes: false` layer): a
 * `@gate:always-run` suite walks 1448 files on every merge, where `setParentNodes: true` costs
 * 49 s against 0.7 s, and this walk hands the parent down itself where it needs one.
 */
function maxFunctionBranches(file: string, text: string): WorstFunction {
  const sf = parseGuardSource(file, text);
  const queue: ts.Node[] = [];
  const collectTop = (node: ts.Node): void => {
    node.forEachChild((child) => {
      if (isFunctionLike(child)) queue.push(child);
      else collectTop(child);
    });
  };
  collectTop(sf);

  let worst: WorstFunction = { branches: 0, name: "", line: 0 };
  while (queue.length > 0) {
    const fn = queue.shift() as ts.Node;
    let branches = 1;
    const walk = (node: ts.Node): void => {
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
      const named = fn as ts.NamedDeclaration;
      worst = {
        branches,
        name: named.name && ts.isIdentifier(named.name) ? named.name.text : "<anonymous>",
        line: sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1,
      };
    }
  }
  return worst;
}

function gatherSourceFiles(): string[] {
  const packagesDir = join(REPO_ROOT, "packages");
  const files: string[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    if (pkg === ".worktrees") continue;
    collectSourceFiles(join(packagesDir, pkg, "src"), files);
  }
  return files;
}

describe("god-module gate (cohesion-aware)", () => {
  it(`no source file exceeds the ${MAX_LINES}-line hard ceiling`, () => {
    const offenders: string[] = [];
    for (const file of gatherSourceFiles()) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      const lines = lineCount(readFileSync(file, "utf8"));
      if (lines > MAX_LINES) offenders.push(`${rel}  (${lines} lines)`);
    }

    expect(
      offenders,
      `These source files exceed the ${MAX_LINES}-line hard ceiling. Decompose them ` +
        `(extract a cohesive sub-module, or split behind a facade barrel — see ` +
        `git-service.ts / workflow-engine.ts):\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it(`no module declares more than ${COHESION_MAX_FN_DECLS} top-level functions/classes`, () => {
    const offenders: string[] = [];
    for (const file of gatherSourceFiles()) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      const text = readFileSync(file, "utf8");
      const lines = lineCount(text);
      const fnDecls = countInternalFunctions(file, text);
      const allowed = Math.max(COHESION_MAX_FN_DECLS, COHESION_BASELINE[rel] ?? 0);
      if (fnDecls > allowed) {
        const baselineNote = COHESION_BASELINE[rel]
          ? ` — grandfathered at ${COHESION_BASELINE[rel]}, GREW past its baseline`
          : "";
        offenders.push(`${rel}  (${lines} lines, ${fnDecls} functions/classes${baselineNote})`);
      }
    }

    expect(
      offenders,
      `These modules declare a broad behavioral surface (top-level functions/classes, ` +
        `exported + internal) — a low-cohesion god-module smell (#889). ` +
        `Split by responsibility into cohesive sub-modules re-exported through a facade ` +
        `barrel (see workflow-engine.ts / git-service.ts / agent-stream-parser.ts):\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it(`no single function exceeds ${MAX_FUNCTION_BRANCHES} control-flow branches`, () => {
    const offenders: string[] = [];
    const stale: string[] = [];
    let peak: WorstFunction & { rel: string } = { branches: 0, name: "", line: 0, rel: "" };
    let overThreshold = 0;

    for (const file of gatherSourceFiles()) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      const worst = maxFunctionBranches(file, readFileSync(file, "utf8"));
      if (worst.branches > peak.branches) peak = { ...worst, rel };
      if (worst.branches > MAX_FUNCTION_BRANCHES) overThreshold++;
      const baselined = COMPLEXITY_BASELINE[rel];
      const allowed = Math.max(MAX_FUNCTION_BRANCHES, baselined ?? 0);
      if (worst.branches > allowed) {
        const note = baselined ? ` — grandfathered at ${baselined}, GREW past its baseline` : "";
        offenders.push(`${rel}:${worst.line}  ${worst.name}() has ${worst.branches} branches${note}`);
      } else if (baselined !== undefined && worst.branches < baselined) {
        stale.push(`${rel}: now ${worst.branches}, baselined at ${baselined}`);
      }
    }

    expect(
      offenders,
      `These functions branch more than ${MAX_FUNCTION_BRANCHES} times (#726) — the risk signal ` +
        `a file split cannot move. RESTRUCTURE the named function (guard clauses, a lookup table ` +
        `instead of a switch, extract the branchy middle); relocating it to another file does NOT ` +
        `clear this, because the new path carries no baseline entry:\n` +
        offenders.join("\n"),
    ).toEqual([]);

    // Not an assertion — a passing gate that reports nothing is what #726 was filed about.
    // Stale entries are printed rather than failed: several agents share this checkout, and a
    // gate that turns red the moment someone IMPROVES a file gets switched off.
    console.log(
      `[god-module gate] peak function branch complexity ${peak.branches} ` +
        `(${peak.name}() at ${peak.rel}:${peak.line}); ${overThreshold} file(s) over the ` +
        `${MAX_FUNCTION_BRANCHES}-branch threshold, all baselined` +
        (stale.length > 0 ? `; ${stale.length} stale baseline entr${stale.length === 1 ? "y" : "ies"} to lower: ${stale.join(", ")}` : ""),
    );
  });

  // The thresholds and the ratchet baseline live in TWO files by design: this suite is the
  // in-IDE signal, and `scripts/check-god-modules.mjs` is the merge-blocking gate of record
  // wired into `pnpm check:arch` and CI (see packages/shared/CLAUDE.md). Both that doc and
  // the comment above this file's own baseline said "keep in sync" — and it drifted anyway:
  // #722's decomposition of workflow-fork.repository.ts dropped that entry from the script
  // and this copy kept it, which would have let the new facade barrel regrow to 33
  // declarations while only the script refused. A hand-sync instruction is not a mechanism.
  it("thresholds and baseline match scripts/check-god-modules.mjs, the gate of record", () => {
    const scriptText = readFileSync(join(REPO_ROOT, "scripts", "check-god-modules.mjs"), "utf8");

    const scalar = (name: string): string | null => {
      const m = scriptText.match(new RegExp("\\b" + name + "\\s*=\\s*(\\d+)"));
      return m ? m[1] : null;
    };
    expect(scalar("MAX_LINES"), "MAX_LINES differs from the gate of record").toBe(String(MAX_LINES));
    expect(
      scalar("COHESION_MAX_FN_DECLS"),
      "COHESION_MAX_FN_DECLS differs from the gate of record",
    ).toBe(String(COHESION_MAX_FN_DECLS));
    expect(
      scalar("MAX_FUNCTION_BRANCHES"),
      "MAX_FUNCTION_BRANCHES differs from the gate of record",
    ).toBe(String(MAX_FUNCTION_BRANCHES));

    // Parsed by TEXT rather than imported: the script is a spawned `.mjs` with no export, and
    // giving it one purely to satisfy a test would change the shape of the thing under test.
    // Sliced with indexOf rather than a multiline regex — a regex spanning the literal is
    // exactly the kind of brittleness this suite exists to catch elsewhere.
    const parseBaseline = (name: string): Record<string, number> => {
      const openAt = scriptText.indexOf(`const ${name}`);
      expect(openAt, `could not locate ${name} in check-god-modules.mjs`).toBeGreaterThan(-1);
      const braceAt = scriptText.indexOf("{", openAt);
      const closeAt = scriptText.indexOf("\n};", braceAt);
      expect(closeAt, `${name} literal is not closed by a line-initial \`};\``).toBeGreaterThan(braceAt);
      const parsed: Record<string, number> = {};
      for (const line of scriptText.slice(braceAt + 1, closeAt).split("\n")) {
        const m = line.match(/^\s*"([^"]+)"\s*:\s*(\d+)\s*,?/);
        if (m) parsed[m[1]] = Number(m[2]);
      }
      expect(
        Object.keys(parsed).length,
        `parsed no ${name} entries — this parser has gone stale against the script's shape`,
      ).toBeGreaterThan(0);
      return parsed;
    };

    const drift = (name: string): string =>
      `${name} has drifted between this suite and scripts/check-god-modules.mjs. ` +
      "The script is the gate of record: make this file match it, and when a decomposition or a " +
      "restructure removes an entry, remove it from BOTH. A stale entry here silently re-grants a " +
      "file headroom the merge-blocking gate has already taken away.";

    expect(parseBaseline("COHESION_BASELINE"), drift("COHESION_BASELINE")).toEqual(COHESION_BASELINE);
    // #726: the complexity ratchet is a SECOND shared baseline, so it is a second thing that can
    // drift. It gets its parity check from the day it lands, rather than after it has already
    // drifted — which is how COHESION_BASELINE came by its own.
    expect(parseBaseline("COMPLEXITY_BASELINE"), drift("COMPLEXITY_BASELINE")).toEqual(COMPLEXITY_BASELINE);
  });
});
