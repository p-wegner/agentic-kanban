import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Architecture gate: the git CLI may be spawned from exactly ONE place —
 * `packages/shared/src/lib/git-exec.ts`, the sanctioned git adapter. Every other
 * module must go through its `gitExec` / `gitExecOrThrow` / `gitExecSync`
 * primitives instead of calling `child_process` on `git` directly.
 *
 * This keeps the Windows quirks (`windowsHide`), buffer limits, timeouts and error
 * normalisation in one adapter, and makes git a single replaceable boundary
 * (clean-architecture port). It also prevents the historical drift where ~17
 * services each grew their own private `execGit` helper while the docs claimed a
 * single source of truth.
 *
 * Why an AST gate, not a regex (arch-review #899): the old guard matched only a
 * string literal `git` immediately after the call paren. It was a spelling check,
 * not an architectural one — it missed `execFile(g, …)` with a variable bound to
 * `"git"`, `execFileSync(GIT_BIN, …)` with a const, the `promisify(execFile)`
 * indirection used elsewhere in the tree, and dynamic `import("node:child_process")`
 * destructures. ~20 files already import `node:child_process` for legitimate
 * non-git spawns (agent CLIs, dev servers, `taskkill`, `pnpm`, `mklink`, codex/claude
 * login), so we cannot simply ban the import. Instead we parse each file, find the
 * names actually bound to a `child_process` exec/spawn function (including aliases
 * via `promisify` and dynamic import), resolve each call's command argument through
 * local consts/variables, and flag it iff that command resolves to `git`. This
 * catches git invocations regardless of how the command string is spelled, while
 * leaving the legitimate non-git spawns alone.
 *
 * Tests are excluded: they legitimately drive real git to build fixtures.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

/** The only file allowed to spawn `git` via child_process. Relative to REPO_ROOT. */
const ALLOWLIST = new Set([join("packages", "shared", "src", "lib", "git-exec.ts")]);

/** child_process functions that actually launch a process given a command/file as arg 0. */
const SPAWN_FNS = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"]);

/** Command values that mean "the git CLI". */
const GIT_COMMANDS = new Set(["git", "git.exe"]);

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

type Offender = { line: number; snippet: string };

/** Unwrap parentheses / `as` / `satisfies` / non-null wrappers around an expression. */
function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** Resolve an expression to a concrete string, if it is statically one. Returns null otherwise. */
function resolveString(expr: ts.Expression, consts: Map<string, string>): string | null {
  const node = unwrap(expr);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return consts.get(node.text) ?? null;
  return null;
}

/**
 * Does this require/import specifier point at node's child_process?
 * Matches `"child_process"` and `"node:child_process"`.
 */
function isChildProcessModule(spec: string): boolean {
  return spec === "child_process" || spec === "node:child_process";
}

/**
 * Parse one source file and return any line that spawns `git` through a
 * child_process function, however the command string is spelled.
 */
function findGitSpawns(filePath: string, text: string): Offender[] {
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
  const offenders: Offender[] = [];

  // Pass 1: collect string-valued const/let/var bindings (`const GIT = "git"`),
  // names bound to a child_process spawn fn (direct import, dynamic import, or
  // `promisify(execFile)` alias), and the set of spawn-fn local names.
  const stringConsts = new Map<string, string>();
  const spawnNames = new Set<string>();

  // Seed with default child_process binding names so `cp.execFile(...)` is caught too.
  const namespaceImports = new Set<string>();

  function bindFromModuleImport(name: string, imported: string): void {
    if (SPAWN_FNS.has(imported)) spawnNames.add(name);
  }

  function visitCollect(node: ts.Node): void {
    // `import { execFile, spawn as sp } from "node:child_process"`
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (isChildProcessModule(node.moduleSpecifier.text)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            bindFromModuleImport(el.name.text, (el.propertyName ?? el.name).text);
          }
        }
        if (named && ts.isNamespaceImport(named)) {
          namespaceImports.add(named.name.text); // `import * as cp from "child_process"`
        }
      }
    }

    // Variable declarations: string consts, dynamic-import destructures, promisify aliases.
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!decl.initializer) continue;
        const init = unwrap(decl.initializer);

        // `const GIT = "git"` / `const GIT_BIN = "git" as const`
        if (ts.isIdentifier(decl.name)) {
          const s = resolveString(decl.initializer, stringConsts);
          if (s != null) stringConsts.set(decl.name.text, s);

          // `const execFileAsync = promisify(execFile)`
          if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "promisify") {
            const arg = init.arguments[0];
            if (arg && ts.isIdentifier(arg) && spawnNames.has(arg.text)) {
              spawnNames.add(decl.name.text);
            }
          }

          // `const cp = require("child_process")` / `= await import("node:child_process")`
          const mod = requireOrImportModule(init);
          if (mod && isChildProcessModule(mod)) namespaceImports.add(decl.name.text);
        }

        // `const { execFile } = await import("node:child_process")`
        // `const { execFile: ef } = require("child_process")`
        if (ts.isObjectBindingPattern(decl.name)) {
          const mod = requireOrImportModule(init);
          if (mod && isChildProcessModule(mod)) {
            for (const el of decl.name.elements) {
              if (ts.isIdentifier(el.name)) {
                const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
                bindFromModuleImport(el.name.text, imported);
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visitCollect);
  }

  /** Extract the module specifier from `require("x")`, `import("x")`, or `await import("x")`. */
  function requireOrImportModule(expr: ts.Expression): string | null {
    let node = unwrap(expr);
    if (ts.isAwaitExpression(node)) node = unwrap(node.expression);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isImport) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        return node.arguments[0].text;
      }
    }
    return null;
  }

  visitCollect(sf);

  // Pass 2: find calls to a spawn fn (by name, alias, or `cp.execFile`) whose
  // command argument resolves to git.
  function calleeIsSpawn(callee: ts.Expression): boolean {
    const c = unwrap(callee);
    if (ts.isIdentifier(c)) return spawnNames.has(c.text);
    // `cp.execFile(...)` / `(await import(...)).execFile(...)`
    if (ts.isPropertyAccessExpression(c) && SPAWN_FNS.has(c.name.text)) {
      const obj = unwrap(c.expression);
      if (ts.isIdentifier(obj) && namespaceImports.has(obj.text)) return true;
      // `require("child_process").execFile(...)` inline
      const mod = requireOrImportModule(obj);
      if (mod && isChildProcessModule(mod)) return true;
    }
    return false;
  }

  function visitCalls(node: ts.Node): void {
    if (ts.isCallExpression(node) && calleeIsSpawn(node.expression)) {
      const arg0 = node.arguments[0];
      if (arg0) {
        const cmd = resolveString(arg0, stringConsts);
        // For `exec`/`execSync` the whole shell command line is arg0 (e.g.
        // `exec("git status")`), so the program is the FIRST whitespace token.
        // For `execFile`/`spawn` arg0 is already just the binary. Taking the
        // first token works for both and never widens to a false positive.
        const program = cmd == null ? null : cmd.trim().split(/\s+/, 1)[0];
        if (program != null && GIT_COMMANDS.has(program)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          offenders.push({ line: line + 1, snippet: lineTextAt(text, line) });
        }
      }
    }
    ts.forEachChild(node, visitCalls);
  }

  visitCalls(sf);
  return offenders;
}

/** 0-based line index → trimmed source line. */
function lineTextAt(text: string, lineIndex: number): string {
  return text.split(/\r?\n/)[lineIndex]?.trim() ?? "";
}

describe("git-exec single-spawn gate", () => {
  it("flags a raw git spawn via a variable, a const, and helper indirection", () => {
    const source = [
      `import { execFile, execFileSync, spawn } from "node:child_process";`,
      `import { promisify } from "node:util";`,
      `const GIT_BIN = "git";`,
      `const g = "git" as const;`,
      `const execFileAsync = promisify(execFile);`,
      `execFileSync(GIT_BIN, ["status"]);`, // const indirection
      `spawn(g, ["log"]);`, // variable indirection
      `execFileAsync("git", ["diff"]);`, // promisify alias
    ].join("\n");

    const offenders = findGitSpawns("sample.ts", source);
    expect(offenders.map((o) => o.line)).toEqual([6, 7, 8]);
  });

  it("flags the `exec`/`execSync` shell-string form where the whole command line is arg0", () => {
    const source = [
      `import { exec, execSync } from "node:child_process";`,
      `const GIT_CMD = "git rev-parse HEAD";`,
      `execSync("git status --porcelain", { cwd });`, // literal shell command
      `exec(GIT_CMD, () => {});`, // const-resolved shell command
    ].join("\n");

    const offenders = findGitSpawns("sample.ts", source);
    expect(offenders.map((o) => o.line)).toEqual([3, 4]);
  });

  it("does not flag legitimate non-git spawns (pnpm, taskkill, where claude)", () => {
    const source = [
      `import { execSync, execFile, spawn } from "node:child_process";`,
      `execSync("where claude.exe 2>nul");`,
      `execFile("taskkill", ["/PID", "1", "/F"], () => {});`,
      `function run(command: string, args: string[]) { spawn(command, args); }`, // unresolvable param
      `const cmd = "pnpm"; spawn(cmd, ["build"]);`,
    ].join("\n");

    expect(findGitSpawns("sample.ts", source)).toEqual([]);
  });

  it("catches a multiline call and a `git` command split onto the next line", () => {
    const source = `import { execFileSync } from "node:child_process";\nconst output = execFileSync(\n  "git",\n  ["status"],\n);`;
    const offenders = findGitSpawns("sample.ts", source);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.line).toBe(2); // the call expression starts on line 2
  });

  it("no package source spawns git outside the git-exec adapter", () => {
    const packagesDir = join(REPO_ROOT, "packages");
    const files: string[] = [];
    for (const pkg of readdirSync(packagesDir)) {
      if (pkg === ".worktrees") continue;
      collectSourceFiles(join(packagesDir, pkg, "src"), files);
    }

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOWLIST.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const off of findGitSpawns(file, text)) {
        offenders.push(`${rel}:${off.line}  ${off.snippet}`);
      }
    }

    expect(
      offenders,
      `These files spawn git directly instead of importing the adapter from ` +
        `@agentic-kanban/shared/lib/git-exec:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the adapter itself is detected as a git spawn site (allowlist is live, not stale)", () => {
    const adapterPath = join(REPO_ROOT, "packages", "shared", "src", "lib", "git-exec.ts");
    const adapter = readFileSync(adapterPath, "utf8");
    expect(findGitSpawns(adapterPath, adapter).length).toBeGreaterThan(0);
  });
});
