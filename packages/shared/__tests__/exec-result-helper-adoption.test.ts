// @gate:always-run — walks every package's `src/` tree; it imports none of the files it judges.
/**
 * The `ExecResult` helpers are USED, and a new hand-rolled `.code` check cannot appear (#705).
 *
 * #591 introduced the one exec result shape and `execSucceeded` / `execFailedToRun` /
 * `execErrorMessage` beside it, and the shape half worked: git, docker and devcontainer all
 * report a spawn failure the same way now. The helper half did not. Measured when #705 was
 * filed: **0 non-test callers**, against 42 hand-rolled `.code === 0` / `!== 0` / `=== null`
 * comparisons — including four lines in `workspace-services.service.ts` that wrote
 * `res.code === 0` and called `execErrorMessage(res)` in the same expression.
 *
 * Unlike #569's duplicate-DTO ratchet and #513's fetch-in-effect ratchet, nothing at all stood
 * behind this one: a new adapter caller could add a 43rd hand-rolled check today and no gate
 * would notice. That absence is the actual finding of #705, and this file is it.
 *
 * ## Why this is an AST pass and not a regex (#721)
 *
 * The first version of this guard matched `<ident>.code === 0 | !== 0 | === null` in a file
 * that imported an adapter. #721 fault-injected it and every one of these walked straight
 * through: `res.code > 0`, `!res.code`, `if (res.code)`, `res.code == 0`,
 * `const { code } = res; code === 0`, and `res.code === 1`. Four of them are the SAME mistake
 * the guard was written to stop, and the last one was already live in
 * `merge-backoff.service.ts`. A text scan can only ever assert one spelling of its invariant,
 * so the operators and the destructuring form are enumerated here by the parser instead:
 *
 *   - **which values are exec results** is inferred (see {@link collectExecBindings}), not
 *     assumed from the file's import list;
 *   - **what counts as reading the field** is every comparison operator, `!`, and plain
 *     truthiness in an `if` / `while` / `?:` / `&&` / `||`;
 *   - **the field itself** is reached through `res.code`, `res["code"]`, and
 *     `const { code } = res` alike.
 *
 * ## Identifying an `ExecResult` — by type, not by filename
 *
 * There is no type checker here (a full `ts.Program` over this tree costs ~50 s; parsing it
 * costs 0.7 s), so provenance is inferred syntactically, and only POSITIVELY:
 *
 *   1. an annotation naming `ExecResult` — on a parameter, a variable, or a property;
 *   2. a structural annotation carrying `code` beside `stdout`/`stderr` — the same type
 *      written inline, which no import list would reveal;
 *   3. a value initialised from an adapter call (`gitExec`, `gitExecSync`, `gitExecOrThrow`,
 *      `dockerExec`, `devcontainerExec`, …), which is how most of them arrive;
 *   4. anything destructured out of 1–3.
 *
 * That is what lets the genuine exception stay excluded WITHOUT naming a file: the
 * plugin-script result (`plugin-exec.ts`'s `PluginCommandResult`, which carries `timedOut`
 * beside `code`) is a different type with a different contract, so its callers in
 * `plugin-loop.service.ts` and the two client components are simply never inferred as exec
 * results. Rename that file, move those callers, add a fourth one — the exclusion still holds,
 * because it was never about the path.
 *
 * The remaining tier is the one the regex had: a `.code` read on a value whose provenance is
 * NOT resolvable, in a file that imports an adapter. It keeps the old coverage for values
 * arriving from somewhere this file cannot see, and it drops any comparison whose other side
 * is a string literal — `ExecResult.code` is `number | null`, so `err.code === "ENOENT"` and
 * `typeof err.code === "number"` are provably a different field.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import {
  walkPackageSources,
  compareRatchet,
  parseGuardSource,
  forEachNode,
  lineOf,
  unwrapExpression,
  calleeName,
} from "./helpers/guard-scan.js";

const packagesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES = ["shared", "server", "client", "mcp-server"];

/** A file that imports one of these is a file that can hold an `ExecResult`. */
const IMPORTS_EXEC_ADAPTER =
  /from "(?:@agentic-kanban\/shared\/lib\/)?(?:\.\.?\/)*(?:lib\/)?(git-exec|docker-exec|devcontainer-exec|exec-result)(?:\.js)?"/;

/** Functions that RETURN an `ExecResult`. Provenance tier 3. */
const ADAPTER_CALL = /^(?:git|docker|devcontainer)Exec(?:Sync|OrThrow)?$/;

/** The helper module itself decides what goes IN the field, so it is the one place that reads it. */
const HELPER_MODULE = "shared/src/lib/exec-result.ts";

/**
 * Files that still read `.code` directly — `[count, why]`, and only ever shrinking.
 *
 * This map was `{}` while the guard was a regex, and #721 showed that zero to be an artefact
 * of the predicate rather than a fact about the codebase. The stricter AST predicate finds
 * four live reads in three files, every one of them through the destructured
 * `const { code } = await gitExec(…)` form that a `<ident>.code` regex cannot see. Two are a
 * genuine raw-exit-code read that no helper expresses; two are unmigrated #705 debt, pinned
 * here rather than fixed, because production code is not this ticket's to touch.
 */
const ALLOWED: Record<string, [count: number, why: string]> = {
  "server/src/services/merge-backoff.service.ts": [
    1,
    "reads git's exit code 1 as DATA — `git diff --quiet` exits 1 to mean 'the trees differ', " +
      "which is neither success nor failure-to-run, so no helper expresses it (the line above " +
      "it does use execSucceeded for the 0 case)",
  ],
  "shared/src/lib/git-service/merge.ts": [
    2,
    "one of each: `code === 1` is `git merge-tree`'s conflict exit read as data (legitimate, " +
      "like merge-backoff), while `code === 0 && !error` in `casUpdateRef` is #705 debt that " +
      "should become `execSucceeded(res) && !res.error` — lower this to 1 when it does",
  ],
  "server/src/services/bisect.service.ts": [
    1,
    "`allowedExitCodes.includes(code)` — a bisect step's caller declares WHICH non-zero exits " +
      "are expected, so the raw number is the datum and 'did it succeed' is the wrong question",
  ],
};

interface ExecBindings {
  /** Identifiers holding an `ExecResult`. */
  values: Set<string>;
  /** Identifiers bound to the `code` FIELD of one, via destructuring. */
  codes: Set<string>;
  /** Identifiers with a resolvable non-exec provenance — a different `.code` entirely. */
  notExec: Set<string>;
}

const isExecTypeNode = (type: ts.TypeNode | undefined): boolean => {
  if (!type) return false;
  // 1. an annotation naming ExecResult, however wrapped (`Promise<ExecResult>`, `ExecResult | null`).
  let named = false;
  forEachNode(type, (node) => {
    if (ts.isIdentifier(node) && node.text === "ExecResult") named = true;
  });
  if (named) return true;
  // 2. the same type written structurally, which no import list would reveal.
  let structural = false;
  forEachNode(type, (node) => {
    if (!ts.isTypeLiteralNode(node)) return;
    const members = new Set(
      node.members.map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : "")).filter(Boolean),
    );
    if (members.has("code") && (members.has("stdout") || members.has("stderr"))) structural = true;
  });
  return structural;
};

/** True when `expr` is a call to one of the exec adapters. Provenance tier 3. */
const isAdapterCall = (expr: ts.Expression | undefined): boolean => {
  if (!expr) return false;
  const inner = unwrapExpression(expr);
  if (!ts.isCallExpression(inner)) return false;
  const name = calleeName(inner);
  return name !== null && ADAPTER_CALL.test(name);
};

/** Record the `code` binding out of `const { code } = <execResult>` / `const { code: rc } = …`. */
function collectCodeBindings(name: ts.BindingName, into: Set<string>): void {
  if (!ts.isObjectBindingPattern(name)) return;
  for (const element of name.elements) {
    const source = element.propertyName ?? element.name;
    if (ts.isIdentifier(source) && source.text === "code" && ts.isIdentifier(element.name)) into.add(element.name.text);
  }
}

/**
 * Which of this file's identifiers hold an exec result, its `code`, or provably neither.
 *
 * File-scoped rather than lexically scoped: a guard does not need to know that two functions
 * each have their own `res`, only that a name in this file means an exec result somewhere in
 * it. Shadowing would over-report, which for a ratchet is the safe side.
 */
function collectExecBindings(sf: ts.SourceFile): ExecBindings {
  const bindings: ExecBindings = { values: new Set(), codes: new Set(), notExec: new Set() };
  forEachNode(sf, (node) => {
    if (ts.isVariableDeclaration(node)) {
      // `const { code } = res` and `const rc = res.code` — the field surviving an alias is
      // exactly the escape a `<ident>.code` regex cannot see, so follow it one hop.
      const aliasesAnExecResult =
        node.initializer !== undefined &&
        ts.isIdentifier(unwrapExpression(node.initializer)) &&
        bindings.values.has((unwrapExpression(node.initializer) as ts.Identifier).text);
      if (node.initializer && readsExecCode(node.initializer, bindings, false) && ts.isIdentifier(node.name)) {
        bindings.codes.add(node.name.text);
        return;
      }
      if (isExecTypeNode(node.type) || isAdapterCall(node.initializer) || aliasesAnExecResult) {
        if (ts.isIdentifier(node.name)) bindings.values.add(node.name.text);
        collectCodeBindings(node.name, bindings.codes);
        return;
      }
      // A resolvable initialiser that is NOT an adapter call is positive evidence of another
      // shape — this is what keeps `runPluginCommand`'s result out without naming its file.
      if (node.initializer && ts.isIdentifier(node.name)) {
        const inner = unwrapExpression(node.initializer);
        if (ts.isCallExpression(inner) || ts.isNewExpression(inner) || ts.isObjectLiteralExpression(inner)) {
          bindings.notExec.add(node.name.text);
        }
      }
      return;
    }
    if (ts.isParameter(node)) {
      if (isExecTypeNode(node.type)) {
        if (ts.isIdentifier(node.name)) bindings.values.add(node.name.text);
        collectCodeBindings(node.name, bindings.codes);
      } else if (node.type && ts.isIdentifier(node.name)) {
        bindings.notExec.add(node.name.text);
      }
      return;
    }
    // `catch (err)` — an Error's `.code` is a string errno, never an exit status.
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
      bindings.notExec.add(node.variableDeclaration.name.text);
      return;
    }
    // `res: ExecResult` as an interface/class member, so a result carried in a struct counts.
    if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && isExecTypeNode(node.type)) {
      if (ts.isIdentifier(node.name)) bindings.values.add(node.name.text);
    }
  });
  return bindings;
}

/** `res.code`, `res["code"]`, or a `code` identifier destructured out of one. */
function readsExecCode(expr: ts.Expression | undefined, bindings: ExecBindings, importsAdapter: boolean): boolean {
  if (!expr) return false;
  const node = unwrapExpression(expr);
  if (ts.isIdentifier(node)) return bindings.codes.has(node.text);
  let target: ts.Expression | null = null;
  if (ts.isPropertyAccessExpression(node) && node.name.text === "code") target = node.expression;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === "code"
  ) {
    target = node.expression;
  }
  if (!target) return false;
  const root = unwrapExpression(target);
  if (!ts.isIdentifier(root)) return false;
  if (bindings.values.has(root.text)) return true;
  if (bindings.notExec.has(root.text)) return false;
  // The last tier: provenance unknown, but this file handles exec results.
  return importsAdapter;
}

/** A comparison against a string literal is provably a different `code` field (`number | null` here). */
const comparesToString = (node: ts.BinaryExpression): boolean =>
  ts.isStringLiteralLike(unwrapExpression(node.left)) || ts.isStringLiteralLike(unwrapExpression(node.right));

const COMPARISONS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
]);

const TRUTHINESS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/** Every place this file TESTS the `code` field of something it holds as an exec result. */
function offencesIn(sf: ts.SourceFile, importsAdapter: boolean): string[] {
  const bindings = collectExecBindings(sf);
  const hits: string[] = [];
  const flag = (node: ts.Node, what: string): void => {
    hits.push(`line ${lineOf(sf, node)}: ${what}`);
  };
  const reads = (expr: ts.Expression | undefined): boolean => readsExecCode(expr, bindings, importsAdapter);
  forEachNode(sf, (node) => {
    if (ts.isBinaryExpression(node)) {
      if (COMPARISONS.has(node.operatorToken.kind) && !comparesToString(node)) {
        if (reads(node.left) || reads(node.right)) {
          flag(node, `comparison ${ts.tokenToString(node.operatorToken.kind)}`);
        }
      } else if (TRUTHINESS.has(node.operatorToken.kind) && (reads(node.left) || reads(node.right))) {
        flag(node, `truthiness in ${ts.tokenToString(node.operatorToken.kind)}`);
      }
      return;
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && reads(node.operand)) {
      flag(node, "negation !");
      return;
    }
    if ((ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) && reads(node.expression)) {
      flag(node, "truthiness in a condition");
      return;
    }
    if (ts.isConditionalExpression(node) && reads(node.condition)) flag(node, "truthiness in a ternary");
  });
  return hits;
}

const rel = (abs: string): string => path.relative(packagesRoot, abs).replace(/\\/g, "/");

const sourceFiles = (): string[] => PACKAGES.flatMap((pkg) => walkPackageSources(path.join(packagesRoot, pkg, "src")));

function scan(): { counts: Record<string, number>; detail: Record<string, string[]> } {
  const counts: Record<string, number> = {};
  const detail: Record<string, string[]> = {};
  for (const file of sourceFiles()) {
    const relPath = rel(file);
    if (relPath === HELPER_MODULE) continue;
    const text = fs.readFileSync(file, "utf8");
    const hits = offencesIn(parseGuardSource(file, text), IMPORTS_EXEC_ADAPTER.test(text));
    if (hits.length > 0) {
      counts[relPath] = hits.length;
      detail[relPath] = hits;
    }
  }
  return { counts, detail };
}

/** Non-test callers of a helper, so "it is exported" cannot be mistaken for "it is used". */
function callersOf(helper: string): string[] {
  const files: string[] = [];
  for (const file of sourceFiles()) {
    // The declaration itself is not a call site.
    if (rel(file) === HELPER_MODULE) continue;
    let called = false;
    forEachNode(parseGuardSource(file), (node) => {
      if (ts.isCallExpression(node) && calleeName(node) === helper) called = true;
    });
    if (called) files.push(rel(file));
  }
  return files;
}

describe("ExecResult helpers are adopted, and hand-rolled .code checks cannot come back (#705, #721)", () => {
  const { counts, detail } = scan();

  it("has no hand-rolled read of an ExecResult's .code field", () => {
    const baseline = Object.fromEntries(Object.entries(ALLOWED).map(([file, [count]]) => [file, count]));
    const { over, stale } = compareRatchet(baseline, counts);

    expect(
      over,
      over.length === 0
        ? ""
        : [
            "A comparison, negation or truthiness test on what is almost certainly an",
            "ExecResult's exit code. Use the helper that says what you mean:",
            "",
            "  x.code === 0     -> execSucceeded(x)",
            "  x.code !== 0     -> !execSucceeded(x)",
            "  x.code === null  -> execFailedToRun(x)      (never spawned, or signal-killed)",
            "  `${x.error}`     -> execErrorMessage(x)     (stderr first, never empty)",
            "",
            "If this site genuinely must read the raw field, add it to ALLOWED with the reason.",
            "",
            ...over.map((entry) => {
              const file = entry.split(":")[0]!;
              return `${entry}\n    ${(detail[file] ?? []).join("\n    ")}`;
            }),
          ].join("\n"),
    ).toEqual([]);

    // The other direction. A baseline nobody ever LOWERS stops being a ceiling and becomes a
    // budget, and the next hand-rolled check hides in the slack an earlier migration opened up.
    expect(stale, ["ALLOWED is now generous — lower or delete these entries:", ...stale].join("\n")).toEqual([]);
  });

  it("execSucceeded has real non-test callers — #705 was filed because it had none", () => {
    // The ratchet above is satisfied by a codebase that calls NOTHING, which is exactly the
    // state #591 left behind: no hand-rolled checks would be reported if there were no exec
    // callers at all. This is the other half, and it is what actually fails if someone
    // migrates the call sites back.
    const callers = callersOf("execSucceeded");
    expect(callers.length, `execSucceeded call sites: ${callers.join(", ") || "(none)"}`).toBeGreaterThanOrEqual(10);
  });

  it("execErrorMessage and execFailedToRun are used too, so the trio is not one adopted helper", () => {
    // Floors, not targets, and deliberately set at the CURRENT counts rather than aspirational
    // ones: 3 files call execErrorMessage (agent, devcontainer-workspace, workspace-services)
    // and 1 calls execFailedToRun (git-exec's memo, which is the only place asking "did this
    // ever run?" rather than "did it succeed?"). Both are genuinely small because the question
    // they answer is rarer than "did it exit 0", not because adoption stalled — the sweep for
    // #705 found no further site formatting an ExecResult failure by hand. Raise a floor when a
    // migration raises the count; do not lower one to make a red gate green.
    expect(callersOf("execErrorMessage").length).toBeGreaterThanOrEqual(3);
    expect(callersOf("execFailedToRun").length).toBeGreaterThanOrEqual(1);
  });
});
