import { describe, it, expect } from "vitest";
import { builtinModules } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * #791 regression guard — the client white-screen class.
 *
 * The client imports @agentic-kanban/shared, which resolves through the barrels
 * src/index.ts -> src/lib/index.ts. If any module reachable through those barrels
 * as a VALUE (not `import type` / `export type`) imports a Node builtin
 * (node:child_process, fs, ...) as a value, Vite externalizes it for the browser
 * and THROWS at module load — blanking the entire UI with no console error, while
 * the server stays fine. This was previously guarded only by a prose comment in
 * lib/index.ts.
 *
 * This test statically walks the value-reachable module graph from the barrels and
 * fails if any reached module value-imports a Node builtin. Type-only edges are
 * erased at compile time and correctly do NOT propagate reachability (so the
 * `export type * from "./smoke-check.js"` line is allowed even though smoke-check
 * itself uses node:child_process).
 */

const sharedSrc = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

const NODE_BUILTINS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith("node:")) return true;
  // bare builtin like "fs", "child_process", or a subpath like "fs/promises"
  const root = spec.split("/")[0];
  return NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(root);
}

function isRelative(spec: string): boolean {
  return spec.startsWith(".");
}

/** Resolve a `.js`/extensionless relative import to its on-disk .ts source. */
function resolveModule(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base.replace(/\.js$/, ""), "index.ts"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && c.endsWith(".ts")) return c;
    if (existsSync(c) && c.endsWith(".tsx")) return c;
  }
  return null;
}

interface ModuleEdges {
  /** specifiers imported/re-exported as VALUES (propagate to the client bundle) */
  valueSpecs: string[];
}

function parseModule(file: string): ModuleEdges {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const valueSpecs: string[] = [];

  for (const stmt of sf.statements) {
    // import ... from "x"
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      // `import "x"` (side-effect) is a value import; `import type ...` is erased.
      const isTypeOnly = !!clause?.isTypeOnly;
      const onlyTypeNamedBindings =
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((e) => e.isTypeOnly);
      if (!isTypeOnly && !onlyTypeNamedBindings) valueSpecs.push(spec);
      continue;
    }
    // export ... from "x"
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text;
      if (stmt.isTypeOnly) continue; // `export type * from` / `export type { } from` — erased
      // `export { type A, type B } from "x"` where ALL are type-only is also erased.
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        const allType = stmt.exportClause.elements.length > 0 && stmt.exportClause.elements.every((e) => e.isTypeOnly);
        if (allType) continue;
      }
      valueSpecs.push(spec);
    }
  }
  return { valueSpecs };
}

describe("shared barrel client-safety (#791 guard)", () => {
  it("no module reachable as a VALUE through the client barrels imports a Node builtin", () => {
    const entry = resolve(sharedSrc, "index.ts");
    expect(existsSync(entry), `barrel not found: ${entry}`).toBe(true);

    const visited = new Set<string>();
    const queue: string[] = [entry];
    const violations: string[] = [];

    while (queue.length > 0) {
      const file = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);

      const { valueSpecs } = parseModule(file);
      for (const spec of valueSpecs) {
        if (isNodeBuiltin(spec)) {
          violations.push(`${file.replace(sharedSrc, "shared/src")} value-imports Node builtin "${spec}"`);
          continue;
        }
        if (isRelative(spec)) {
          const resolved = resolveModule(file, spec);
          if (resolved && resolved.startsWith(sharedSrc)) queue.push(resolved);
        }
        // bare npm specifiers (non-builtin) are not followed; they would need their
        // own client-safety guarantee. The documented failure mode is Node builtins.
      }
    }

    expect(
      violations,
      `These modules ship Node builtins into the client bundle and will white-screen the UI (#791).\n` +
        `Fix: change the offending barrel re-export to \`export type *\` and import the runtime value via its deep path server-side.\n` +
        violations.join("\n"),
    ).toEqual([]);

    // Sanity: the walk actually traversed the graph (guards against a silent no-op
    // if the barrel structure changes and resolution breaks).
    expect(visited.size).toBeGreaterThan(5);
  });
});
