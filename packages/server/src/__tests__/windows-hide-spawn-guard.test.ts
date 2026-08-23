// @gate:always-run — walks every package's src tree, so its subject is not in this
// file's import graph and scoped test selection must not skip it.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parseGuardSource, forEachNode, lineOf } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * Every child_process spawn passes `windowsHide: true` (#597).
 *
 * This is a CLAUDE.md HARD CONSTRAINT, not a style rule: a spawn without it flashes a
 * console window on Windows, which steals focus and — the reason it is a hard constraint —
 * can disrupt other agents' worktree servers running on the same machine. It is invisible
 * on CI and on the maintainer's non-Windows runs, so nothing but a scanner catches it.
 *
 * Matching is deliberately narrow, because the obvious pattern is badly wrong here: a
 * RegExp's own `exec` method is not a spawn, and a naive text match reports ~67 offenders,
 * almost all of them regex calls. This resolves the child_process import first and only
 * matches the identifiers actually bound from it (honouring `as` aliases).
 *
 * ## Why this is an AST pass and not a per-line scan (#794, following #779)
 *
 * The previous version found a spawn on a LINE, then joined the next 16 lines and counted
 * parentheses to guess where the call ended and whether `windowsHide` was inside it. Both
 * halves were decided by the formatter rather than by the code:
 *
 *   - the callee had to sit on the same line as its opening paren, so a wrap between the
 *     two meant the call was not a spawn as far as the guard was concerned, and could omit
 *     `windowsHide` forever;
 *   - the 16-line window was a guess. A correct call whose options object began on the
 *     17th line read as an offender, and a closing paren inside a string literal closed
 *     the window early and did the same;
 *   - a spawn written inside a comment or a string counted as a call site.
 *
 * A `CallExpression` is one node however it is printed: its arguments are its arguments, so
 * there is no window to size and no depth to count, and comments and string literals are
 * not call expressions.
 */
const PACKAGES = path.resolve(import.meta.dirname, "../../../..", "packages");

const SPAWN_FNS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);

/**
 * Calls that must NOT hide their window, each with the reason. Every entry here opens a
 * window FOR THE USER on purpose — hiding it would defeat the feature outright.
 */
const ALLOWED: Record<string, string> = {
  "server/src/services/claude-login.service.ts": "opens a terminal for interactive login — the window IS the feature",
  "server/src/services/codex-login.service.ts": "opens a terminal for interactive login — the window IS the feature",
  "server/src/services/project.service.ts": "explorer/open — shows the user a folder; hiding it does nothing useful",
  "server/src/services/workspace-session.service.ts": "opens a visible terminal attached to a workspace, on user request",
};

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "__tests__") return [];
      return tsFiles(full);
    }
    return e.name.endsWith(".ts") && !e.name.includes(".test.") ? [full] : [];
  });
}

/** Local names bound from child_process in this file (handles `execFile as ef`). */
function spawnBindingsOf(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteralLike(specifier)) continue;
    if (specifier.text !== "child_process" && specifier.text !== "node:child_process") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const original = (element.propertyName ?? element.name).text;
      if (SPAWN_FNS.has(original)) names.add(element.name.text);
    }
  }
  return names;
}

/** `windowsHide` written as a property anywhere in the call's own arguments. */
function passesWindowsHide(call: ts.CallExpression): boolean {
  let found = false;
  for (const argument of call.arguments) {
    forEachNode(argument, (node) => {
      if (found) return;
      if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "windowsHide"
      ) {
        found = true;
      }
    });
  }
  return found;
}

export interface SpawnHit {
  line: number;
  text: string;
}

/**
 * Every child_process spawn in one source text that does not pass `windowsHide`. Named and
 * exported so the proof cases below drive the REAL scanner rather than a copy of its
 * predicate — a proof against a re-implementation proves nothing.
 */
export function scanSpawnSource(cacheKey: string, text: string): SpawnHit[] {
  const sf = parseGuardSource(cacheKey, text);
  const bindings = spawnBindingsOf(sf);
  if (bindings.size === 0) return [];
  const hits: SpawnHit[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    // A bare identifier only: a same-named method on another object belongs to that object,
    // and a differently-named local is a different binding. This is the AST form of the old
    // lookbehind, and unlike it, it cannot be fooled by where a line broke.
    if (!ts.isIdentifier(node.expression) || !bindings.has(node.expression.text)) return;
    if (passesWindowsHide(node)) return;
    hits.push({ line: lineOf(sf, node), text: node.getText(sf).replace(/\s+/g, " ").slice(0, 120) });
  });
  return hits;
}

const fileHasSpawnBinding = (file: string): boolean =>
  spawnBindingsOf(parseGuardSource(file, readFileSync(file, "utf8"))).size > 0;

describe("windowsHide on every child_process spawn (#597)", () => {
  const files = tsFiles(PACKAGES).filter((f) => /[\\/]src[\\/]/.test(f));

  it("finds spawn call sites, so the scan cannot pass vacuously", () => {
    expect(files.filter(fileHasSpawnBinding).length).toBeGreaterThanOrEqual(10);
  });

  it("no spawn omits windowsHide outside the allowlist", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(PACKAGES, file).replaceAll("\\", "/");
      if (rel in ALLOWED) continue;
      for (const hit of scanSpawnSource(file, readFileSync(file, "utf8"))) {
        offenders.push(`${rel}:${hit.line}: ${hit.text}`);
      }
    }
    expect(
      offenders,
      `these spawn without windowsHide (CLAUDE.md hard constraint):\n${offenders.join("\n")}\n` +
        "Add `windowsHide: true` to the options, or add the file to ALLOWED with the reason its window must be visible.",
    ).toEqual([]);
  });

  it("every allowlist entry still names a file that spawns", () => {
    const stale = Object.keys(ALLOWED).filter((rel) => {
      try {
        return !fileHasSpawnBinding(path.join(PACKAGES, rel));
      } catch {
        return true; // file gone
      }
    });
    expect(stale, `allowlist entries no longer spawning: ${stale.join(", ")}`).toEqual([]);
  });
});

/**
 * #779's proof obligation (#794): a conversion is worth nothing unless it is shown to catch
 * the form the old guard could not see, and to still catch what it already did.
 */
describe("the spawn scan sees forms the line-window version could not (#794)", () => {
  const scan = (name: string, lines: string[]): SpawnHit[] =>
    scanSpawnSource(`/virtual/windows-hide/${name}.ts`, lines.join("\n"));

  it("still catches the plain one-line spawn with no options at all", () => {
    const hits = scan("plain", ['import { spawn } from "node:child_process";', 'spawn("git", ["status"]);']);
    expect(hits.map((h) => h.line)).toEqual([2]);
  });

  it("still honours an `as` alias, and a windowsHide-carrying call is clean", () => {
    expect(
      scan("alias-ok", [
        'import { execFile as ef } from "child_process";',
        'ef("git", ["status"], { windowsHide: true }, cb);',
      ]),
    ).toEqual([]);
    expect(
      scan("alias-bad", ['import { execFile as ef } from "child_process";', 'ef("git", ["status"], { cwd }, cb);']),
    ).toHaveLength(1);
  });

  it("still ignores a same-named method on another object", () => {
    expect(
      scan("method", ['import { exec } from "node:child_process";', "const m = /re/.exec(text);", "use(m);"]),
    ).toEqual([]);
  });

  it("catches a spawn whose callee and argument list sit on DIFFERENT lines", () => {
    // The old match ran against one line at a time and required the callee and its opening
    // paren to share that line. A wrap between the two meant the call was never recognised
    // as a spawn at all, so it could omit windowsHide indefinitely.
    const hits = scan("wrapped-callee", [
      'import { spawn } from "node:child_process";',
      "const child = spawn",
      '  ("git", ["status"], { cwd });',
    ]);
    expect(hits.map((h) => h.line)).toEqual([2]);
  });

  it("no longer reports a correct call whose options object begins past the 16-line window", () => {
    // The window was a guess: a long argument list pushed windowsHide out of it and the
    // call read as an offender. The arguments of a CallExpression have no such horizon.
    const lines = [
      'import { spawn } from "node:child_process";',
      'spawn("node", [',
      ...Array.from({ length: 20 }, (_, i) => `  "--arg${i}",`),
      "], { windowsHide: true });",
    ];
    expect(scan("long-call", lines)).toEqual([]);
  });

  it("no longer truncates the call at a closing paren that lives inside a string literal", () => {
    const hits = scan("paren-in-string", [
      'import { spawn } from "node:child_process";',
      'spawn("sh", [',
      '  "-c",',
      '  "echo )))",',
      "], { windowsHide: true });",
    ]);
    expect(hits).toEqual([]);
  });

  it("does not count a spawn written in a comment or inside a string", () => {
    const hits = scan("prose", [
      'import { spawn } from "node:child_process";',
      'const doc = "spawn(cmd, args) without windowsHide is forbidden";',
      "run(); // spawn(cmd, args)",
      '/* spawn("git", ["status"]) is the shape this guard forbids. */',
      "export const noop = () => doc;",
    ]);
    expect(hits).toEqual([]);
  });
});
