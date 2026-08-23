// @gate:always-run — recursively walks every package's source and test tree; imports nothing it checks (#816).
import { describe, expect, it } from "vitest";
import path, { join } from "node:path";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import ts from "typescript";
import {
  forEachNode,
  leadingCommentText,
  lineOf,
  packagesRootFrom,
  parseGuardSource,
  walkPackageSources,
} from "./helpers/guard-scan.js";

/**
 * A test hook may not DROP a promise (#816, item 2).
 *
 * #777 found the shape in both fleet e2e suites: `afterAll` called the worker daemon's
 * `stop()` — which is async and DRAINS (#754) — without awaiting it, then immediately closed
 * the board server and `rmSync(recursive)`'d the fixture tree. That is two defects wearing one
 * coat:
 *
 *  1. It RACES the teardown. The tree is deleted while the daemon is still signalling kills,
 *     finishing result pushes and closing its socket, which is exactly how a Windows `EPERM`
 *     in an `afterAll` gets manufactured.
 *  2. It leaves the returned promise UNHANDLED. A rejection then surfaces after the hook has
 *     returned, and vitest reports it against WHATEVER FILE RUNS NEXT. So the pair was
 *     PRODUCING the cross-file misattribution of #680, not only suffering it — and #680 is the
 *     ticket for a gate that goes red under load and green in isolation, which cost a 36-commit
 *     wave three full server passes plus nine isolation re-runs to establish that only three of
 *     its failures were real.
 *
 * (2) is why this is a static guard and not a review habit. A misattributed failure carries no
 * pointer back to the file that caused it, so the ordinary feedback loop — the suite that broke
 * is the suite that is wrong — is precisely the loop this shape breaks.
 *
 * **The rule**: inside a `beforeAll` / `beforeEach` / `afterAll` / `afterEach` callback, an
 * expression statement that CALLS a provably promise-returning function and neither `await`s
 * nor `void`s it fails. Returning it is fine (a `return` is not an expression statement) and so
 * is `.then(...)` / `.catch(...)` chaining — both hand the promise to someone.
 *
 * **This is a heuristic net, not a proof**, in the same sense as the other AST guards here: a
 * type checker would answer "is this call's type thenable?" exactly, and a checker over the
 * 1204 test files costs ~40 s, which an `@gate:always-run` suite cannot spend on every merge.
 * So promise-ness is established WITHOUT a checker, from two evidence sources that are cheap
 * and conservative:
 *
 *  - `recv.m()` where `recv` carries a TYPE ANNOTATION in the same file, and the named type is
 *    declared somewhere in this repo with `m` returning a promise (`async`, or an explicit
 *    `Promise<…>` return type). This is the #777 shape verbatim: `let daemon:
 *    WorkerDaemonHandle | undefined` → `WorkerDaemonHandle.stop(): Promise<void>`.
 *  - `f()` where `f` is declared IN THE SAME FILE as an async function/arrow or with a
 *    `() => Promise<…>` annotation.
 *
 * What it deliberately does NOT do is match on the callee's NAME. That was measured and it
 * fails in both directions at once: a name-only net produced 129 hits against a ground truth of
 * 0 (`push`, `clear`, `close`, `git`, `exec` all have async namesakes here), and narrowing it
 * to names that are NEVER declared sync silently dropped `stop` — which is 2 async declarations
 * against 24 sync ones in this repo, i.e. the filter would have missed all four real offenders
 * the guard exists for.
 *
 * **Known blind spots**, stated rather than papered over: an untyped receiver, one typed only
 * through an initializer's inferred return type, a promise-returning function imported from
 * another file and called bare, and a promise stored in a variable that is never awaited. The
 * net narrows the gap; it does not close it.
 *
 * **Deliberately zero-tolerance rather than a shrink-only ratchet.** The measured count after
 * #777's two fixes and this ticket's four is 0 across all packages, and a baseline of zero IS
 * the ratchet — there is nothing to grandfather, so any allowance would only be somewhere for
 * the first regression to land. A genuinely-deliberate fire-and-forget takes an explicit
 * `// UNAWAITED TEARDOWN OK: <reason>` comment on the line above the call, which puts the
 * reason in the diff where a reviewer sees it.
 *
 * Ground truth for both directions was established with a real `ts.createProgram` type-checker
 * sweep over all 1204 test files (0 unresolved imports; 746 of 752 awaited hook statements
 * confirmed thenable, so the checker was not blind): it found exactly four offenders, and this
 * guard reproduces 4/4 of them from their pre-fix text with 0 false positives on the fixed tree.
 */

const PACKAGES_ROOT = packagesRootFrom(import.meta.dirname!, 2);
const REPO_ROOT = path.resolve(PACKAGES_ROOT, "..");

/** The hooks whose body runs as part of the suite's own control flow. */
const HOOKS = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);
/** Chaining onto one of these HANDS the promise on, so the statement is not a drop. */
const PROMISE_SINKS = new Set(["then", "catch", "finally"]);
/** The per-call opt-out, written on the line above. */
const OPT_OUT = /UNAWAITED TEARDOWN OK:/;

/** `true` when a function-like node is declared to produce a promise. */
function returnsPromise(node: ts.SignatureDeclarationBase): boolean {
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  if (modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return true;
  const rt = node.type;
  return (
    !!rt && ts.isTypeReferenceNode(rt) && ts.isIdentifier(rt.typeName) && /^Promise(Like)?$/.test(rt.typeName.text)
  );
}

function declaredName(name: ts.Node | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

/** Strip `!`, `(...)` and `as` to reach the expression a call or member access is really on. */
function unwrapTarget(expr: ts.Expression): ts.Expression {
  let cur = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

/**
 * Is this member declared to return a promise? `null` means "not a method-shaped member", which
 * is not the same as "not a promise" — only a definite `true` ever flags.
 */
function memberIsPromise(m: ts.ClassElement | ts.TypeElement): boolean | null {
  if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) return returnsPromise(m);
  if (ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) {
    if (m.type && ts.isFunctionTypeNode(m.type)) return returnsPromise(m.type);
    const init = (m as ts.PropertyDeclaration).initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return returnsPromise(init);
  }
  return null;
}

/** `true` promise, `false` sync, `"ambiguous"` when two same-named declarations disagree. */
type Verdict = boolean | "ambiguous";

/**
 * `TypeName -> member -> verdict`, over every interface / class / object-type alias in the repo.
 *
 * Keyed by the type's SIMPLE name, because resolving the import graph would cost more than the
 * guard is worth. Two same-named types that disagree about a member collapse to `"ambiguous"`
 * and stop flagging, so a name collision loses the guard a catch rather than inventing one.
 */
function buildTypeIndex(files: string[]): Map<string, Map<string, Verdict>> {
  const index = new Map<string, Map<string, Verdict>>();
  const add = (typeName: string | null, members: readonly (ts.ClassElement | ts.TypeElement)[]): void => {
    if (!typeName) return;
    let byMember = index.get(typeName);
    if (!byMember) index.set(typeName, (byMember = new Map()));
    for (const m of members) {
      const name = declaredName(m.name);
      if (!name) continue;
      const verdict = memberIsPromise(m);
      if (verdict === null) continue;
      const prev = byMember.get(name);
      byMember.set(name, prev === undefined || prev === verdict ? verdict : "ambiguous");
    }
  };
  for (const file of files) {
    const sf = parseGuardSource(file);
    forEachNode(sf, (node) => {
      if (ts.isInterfaceDeclaration(node)) add(node.name.text, node.members);
      else if (ts.isClassDeclaration(node) && node.name) add(node.name.text, node.members);
      else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) add(node.name.text, node.type.members);
    });
  }
  return index;
}

/** The type names a declaration is annotated with — `A | undefined` yields `A`. */
function annotatedTypeNames(type: ts.TypeNode | undefined, out = new Set<string>()): Set<string> {
  if (!type) return out;
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) out.add(type.typeName.text);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) for (const t of type.types) annotatedTypeNames(t, out);
  return out;
}

interface Offender {
  file: string;
  line: number;
  text: string;
  /** Why the call is believed to return a promise — printed so a false positive is arguable. */
  because: string;
}

/**
 * Every expression statement in a hook body, EXCLUDING the bodies of functions nested inside it.
 *
 * A callback passed to `vi.waitFor` or `server.close(() => …)` has its own control flow; a call
 * there is not something the hook forgot to await.
 */
function hookStatements(body: ts.Node): ts.ExpressionStatement[] {
  const out: ts.ExpressionStatement[] = [];
  const collect = (node: ts.Node): void => {
    node.forEachChild((child) => {
      if (
        ts.isFunctionExpression(child) ||
        ts.isArrowFunction(child) ||
        ts.isFunctionDeclaration(child) ||
        ts.isMethodDeclaration(child)
      ) {
        return;
      }
      if (ts.isExpressionStatement(child)) out.push(child);
      collect(child);
    });
  };
  collect(body);
  return out;
}

function scanFile(absFile: string, typeIndex: Map<string, Map<string, Verdict>>, text?: string): Offender[] {
  const sf = parseGuardSource(absFile, text);
  const full = sf.getFullText();

  // File-local bindings: a name's annotated type, and a name bound to an async function.
  const receiverTypes = new Map<string, Set<string>>();
  const localAsyncFns = new Map<string, boolean>();
  forEachNode(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    const name = node.name.text;
    if (node.type && ts.isFunctionTypeNode(node.type)) {
      localAsyncFns.set(name, returnsPromise(node.type));
      return;
    }
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      localAsyncFns.set(name, returnsPromise(init));
      return;
    }
    const names = annotatedTypeNames(node.type);
    if (names.size) receiverTypes.set(name, names);
  });

  const out: Offender[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrapTarget(node.expression);
    if (!ts.isIdentifier(callee) || !HOOKS.has(callee.text)) return;
    const cb = node.arguments[0];
    if (!cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) return;

    for (const stmt of hookStatements(cb.body)) {
      const expr = stmt.expression;
      // `await x()` and `void x()` both dispose of the promise deliberately.
      if (ts.isAwaitExpression(expr) || ts.isVoidExpression(expr)) continue;
      if (!ts.isCallExpression(expr)) continue;
      const target = unwrapTarget(expr.expression);

      let because: string | null = null;
      if (ts.isIdentifier(target)) {
        if (localAsyncFns.get(target.text) === true) {
          because = `${target.text}() is an async function declared in this file`;
        }
      } else if (ts.isPropertyAccessExpression(target)) {
        const method = target.name.text;
        if (PROMISE_SINKS.has(method)) continue;
        const recv = unwrapTarget(target.expression);
        if (ts.isIdentifier(recv)) {
          for (const typeName of receiverTypes.get(recv.text) ?? []) {
            if (typeIndex.get(typeName)?.get(method) === true) because = `${typeName}.${method}() returns a promise`;
          }
        }
      }
      if (!because) continue;
      if (OPT_OUT.test(leadingCommentText(sf, expr))) continue;
      out.push({
        file: path.relative(REPO_ROOT, absFile).split(path.sep).join("/"),
        line: lineOf(sf, stmt),
        text: full.slice(stmt.getStart(sf), stmt.end).replace(/\s+/g, " ").slice(0, 120),
        because,
      });
    }
  });
  return out;
}

/** Every package that holds sources, so adding one cannot silently escape the scan. */
function packageDirs(): string[] {
  return fs
    .readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => path.join(PACKAGES_ROOT, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, "package.json")));
}

/** All TS sources of a package, tests included — a handle type is often declared in a test helper. */
function allSources(packageDir: string): string[] {
  return walkPackageSources(packageDir, {
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    includeTests: true,
    skipDirs: new Set(["node_modules", "dist", "coverage", ".git"]),
  });
}

function isTestScope(file: string): boolean {
  const rel = file.split(path.sep).join("/");
  return rel.includes("/__tests__/") || /\.test\.[a-z]+$/.test(path.basename(file));
}

describe("no test hook drops a promise (#816)", () => {
  const sources = packageDirs().flatMap(allSources);
  const testScope = sources.filter(isTestScope);
  const typeIndex = buildTypeIndex(sources);

  it("the scan actually reaches the packages — a broken path must not read as 'clean'", () => {
    // A guard that silently scans nothing passes forever. Pin all three inputs: the packages
    // are found, the test scope is the order of magnitude this repo has, and the type index
    // resolved the one type all four real offenders went through.
    expect(packageDirs().length).toBeGreaterThanOrEqual(4);
    expect(testScope.length).toBeGreaterThan(300);
    expect(typeIndex.size).toBeGreaterThan(500);
    expect(typeIndex.get("WorkerDaemonHandle")?.get("stop"), "the #777 type must resolve").toBe(true);
  });

  it("no hook calls a promise-returning function without awaiting it", () => {
    const offenders = testScope.flatMap((f) => scanFile(f, typeIndex));
    expect(
      offenders.map((o) => `${o.file}:${o.line} -> ${o.text}   [${o.because}]`),
      "A test hook called an async function and dropped its promise. Two things go wrong at " +
        "once: the hook returns before that work finishes, so a teardown step after it " +
        "(`close()`, `rmSync`) races it — and the unhandled rejection is reported by vitest " +
        "against WHATEVER FILE RUNS NEXT, which is the cross-file misattribution of #680 " +
        "(#777 measured this exact pair PRODUCING it).\n\n" +
        "`await` it. If the fire-and-forget is deliberate, `void` it AND attach a `.catch(...)`, " +
        "then put `// UNAWAITED TEARDOWN OK: <reason>` on the line above the call.",
    ).toEqual([]);
  });

  it("the guard bites — the real #777 shape, and not its fixed form", () => {
    // A guard nobody has seen fail is indistinguishable from a no-op. Prove it on the ACTUAL
    // shape that leaked (the fleet suites before #777/#816) rather than on a toy, and prove the
    // sanctioned forms beside it — a guard that flags everything is as useless as one that
    // flags nothing, and the name-only version of this scan produced 129 of those.
    const dir = mkdtempSync(join(tmpdir(), "ak-hook-await-guard-"));
    try {
      const leaky = join(dir, "leaky.test.ts");
      writeFileSync(
        leaky,
        [
          "let daemon: WorkerDaemonHandle | undefined;",
          "afterAll(async () => {",
          "  daemon?.stop({ killAgents: true });",
          "  await new Promise<void>((resolve) => server.close(() => resolve()));",
          "  rmSync(stateFile, { force: true });",
          "});",
        ].join("\n"),
        "utf8",
      );
      const hits = scanFile(leaky, typeIndex);
      expect(hits.length, "the pre-#777 shape must be caught").toBe(1);
      expect(hits[0]!.text).toContain("daemon?.stop(");
      expect(hits[0]!.because).toBe("WorkerDaemonHandle.stop() returns a promise");

      const fixed = join(dir, "fixed.test.ts");
      writeFileSync(
        fixed,
        [
          "let daemon: WorkerDaemonHandle | undefined;",
          "afterAll(async () => {",
          "  await daemon?.stop({ killAgents: true });",
          "  daemon?.stop({ killAgents: true }).catch(() => {});",
          "  void daemon?.stop({ killAgents: true });",
          "  server.close(() => daemon?.stop({ killAgents: true }));",
          "  // UNAWAITED TEARDOWN OK: the socket is already gone, nothing can reject",
          "  daemon?.stop({ killAgents: true });",
          "});",
        ].join("\n"),
        "utf8",
      );
      expect(
        scanFile(fixed, typeIndex).map((o) => o.text),
        "awaited, sunk into .catch, explicitly voided, nested in another callback, and opted out " +
          "are all sanctioned and must not flag",
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
