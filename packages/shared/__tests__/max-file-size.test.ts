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
 *     ({@link COHESION_MIN_LINES}+) AND exposes a broad BEHAVIORAL export surface
 *     (> {@link COHESION_MAX_FN_EXPORTS} exported functions/classes). Many
 *     independent exported behaviors in one big file = many responsibilities =
 *     low cohesion. This is exactly the shape #875 called out in the post-split
 *     workflow engine.ts (688 lines, 19 exported functions, ~3 responsibilities)
 *     — a file the raw line gate waved through. The signal counts FUNCTIONS and
 *     CLASSES only, NOT exported `const` data tables (gitignore templates, version
 *     pins, lookup maps) or type/interface exports — those are cohesive data /
 *     contracts, not separate responsibilities.
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
const COHESION_MAX_FN_EXPORTS = 15;

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
 * Count the BEHAVIORAL export surface: exported function/class declarations plus
 * exported arrow-function/function-expression consts. Deliberately ignores
 * exported data consts (lookup tables, templates, version pins) and type/interface
 * exports — those are cohesive data/contracts, not separate responsibilities.
 */
function countFunctionExports(file: string, text: string): number {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let count = 0;

  const isExported = (stmt: ts.Statement): boolean => {
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  };

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && isExported(stmt)) {
      count++;
      continue;
    }
    if (ts.isClassDeclaration(stmt) && isExported(stmt)) {
      count++;
      continue;
    }
    if (ts.isVariableStatement(stmt) && isExported(stmt)) {
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

  it(`no large module (${COHESION_MIN_LINES}+ lines) exposes more than ${COHESION_MAX_FN_EXPORTS} exported functions/classes`, () => {
    const offenders: string[] = [];
    for (const file of gatherSourceFiles()) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      if (isRepositoryLayer(rel)) continue; // broad-by-design data-access layer
      const text = readFileSync(file, "utf8");
      const lines = lineCount(text);
      if (lines < COHESION_MIN_LINES) continue;
      const fnExports = countFunctionExports(file, text);
      if (fnExports > COHESION_MAX_FN_EXPORTS) {
        offenders.push(`${rel}  (${lines} lines, ${fnExports} exported functions/classes)`);
      }
    }

    expect(
      offenders,
      `These large modules expose a broad behavioral export surface — a low-cohesion ` +
        `god-module smell (the shape #875 flagged in the old workflow engine.ts). ` +
        `Split by responsibility into cohesive sub-modules re-exported through a facade ` +
        `barrel (see workflow-engine.ts / git-service.ts):\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
