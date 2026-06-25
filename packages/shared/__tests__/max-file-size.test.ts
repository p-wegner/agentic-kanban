import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
 *  2. A COHESION signal — a module is a probable god-module when it is large
 *     ({@link COHESION_MIN_LINES}+) AND declares a broad BEHAVIORAL surface
 *     (> {@link COHESION_MAX_FN_DECLS} top-level functions/classes, EXPORTED AND
 *     INTERNAL). Many independent top-level behaviors in one big file = many
 *     responsibilities = low cohesion. Counting only EXPORTS undercounts (#889): a
 *     god-module hides behind a few exports while declaring dozens of internal
 *     helpers — agent-stream-parser.ts had 3 exports but 28 internal functions at
 *     1042 lines, waved straight through the old export-only signal. The count is
 *     TOP-LEVEL function/class declarations + top-level arrow/function-expression
 *     consts (nested callbacks belong to their enclosing function, not separate
 *     responsibilities), and ignores `const` data tables (gitignore templates,
 *     version pins, lookup maps) and type/interface exports — cohesive data /
 *     contracts, not behaviors.
 *
 * Exemptions (path/shape-based, not a per-file allowlist):
 *  - the REPOSITORY layer — a data-access module legitimately exports one query
 *    function per row operation; breadth there is cohesion-by-layer, not a
 *    grab-bag, so the cohesion signal does not apply (the line ceiling still does);
 *  - type-only modules (the wire-contract DTOs) — no behavioral surface at all.
 *
 * The decompose recipe when a file trips: extract a cohesive sub-module, or split
 * a god-file behind a facade barrel — see packages/shared/src/lib/git-service.ts
 * and packages/shared/src/lib/workflow-engine.ts for the pattern. Tests, generated
 * code, dist and vendored code are excluded.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const MAX_LINES = 1000;
const COHESION_MIN_LINES = 600;
// Top-level function-like declarations, exported AND internal (#889). Keep in sync
// with scripts/check-god-modules.mjs (the merge-blocking gate of record).
const COHESION_MAX_FN_DECLS = 20;

// Ratchet baseline (#889): large modules grandfathered at their current top-level
// declaration count so the gate ships green. A baselined file may only SHRINK — the
// gate fails if it grows past its baseline. Keep in sync with check-god-modules.mjs.
// Decomposition tracked on the board (#911/#912/#913); drop an entry once split.
const COHESION_BASELINE: Record<string, number> = {
  "packages/shared/src/lib/session-summary.ts": 38,
  "packages/server/src/services/butler-sdk.service.ts": 30,
  "packages/server/src/services/stack-profile.service.ts": 28,
  "packages/server/src/services/agent.service.ts": 27,
  "packages/server/src/services/insights.service.ts": 23,
  "packages/server/src/services/agent-questions.service.ts": 21,
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

/** The repository layer exports one query fn per operation — broad by design. */
function isRepositoryLayer(rel: string): boolean {
  return rel.includes("/repositories/");
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

  it(`no large module (${COHESION_MIN_LINES}+ lines) declares more than ${COHESION_MAX_FN_DECLS} top-level functions/classes`, () => {
    const offenders: string[] = [];
    for (const file of gatherSourceFiles()) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      if (isRepositoryLayer(rel)) continue; // broad-by-design data-access layer
      const text = readFileSync(file, "utf8");
      const lines = lineCount(text);
      if (lines < COHESION_MIN_LINES) continue;
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
      `These large modules declare a broad behavioral surface (top-level functions/classes, ` +
        `exported + internal) — a low-cohesion god-module smell (#889). ` +
        `Split by responsibility into cohesive sub-modules re-exported through a facade ` +
        `barrel (see workflow-engine.ts / git-service.ts / agent-stream-parser.ts):\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
