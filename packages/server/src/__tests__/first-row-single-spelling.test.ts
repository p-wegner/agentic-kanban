// @gate:always-run
//
// #772 — the `firstRow` ratchet.
//
// `const rows = await …limit(1); return rows[0] ?? null;` was written out by hand ~84 times
// across the repository layer, and the spelling had already drifted three ways
// (`rows.length === 0 ? null : rows[0].id`, `pref.length === 0 ? null : pref[0].value`, and a
// raw one-element array every caller then indexed). #772 collapsed all of them onto the one
// helper `server/src/lib/first-row.ts`.
//
// Shrink-only in both directions:
//   - the hand-written spellings are frozen at ZERO and may never come back;
//   - the OTHER drift — a repository function that returns the `.limit(1)` builder itself, so
//     its callers index a one-element array — is NOT migrated (that changes 50 exported
//     signatures and every call site, which is a bigger job than #772 names). It is
//     grandfathered at its measured count and may only shrink.
//
// Matched on the AST, not per line (#779): `const rows = await q;` / `return rows[0] ?? null;`
// is a two-statement shape and `rows.length === 0 ? null : rows[0]` wraps trivially, so a
// line-oriented version of this guard would hand out exemptions wherever a formatter broke a
// line. It reads the repository tree directly rather than importing it, hence the marker.
import { describe, expect, it } from "vitest";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import {
  forEachNode,
  lineOf,
  parseGuardSource,
  unwrapExpression,
  walkPackageSources,
} from "../../../shared/__tests__/helpers/guard-scan.js";

const REPOSITORIES_DIR = fileURLToPath(new URL("../repositories", import.meta.url));
const FILES = walkPackageSources(REPOSITORIES_DIR);

function where(sf: ts.SourceFile, node: ts.Node): string {
  const rel = path.relative(REPOSITORIES_DIR, sf.fileName).replace(/[\\]/g, "/");
  return rel + ":" + lineOf(sf, node);
}

/** `expr` is `<name>[0]`, possibly with further property access on top (`rows[0].id`). */
function indexesZeroOf(expr: ts.Expression, name: string): boolean {
  let cur: ts.Expression = unwrapExpression(expr);
  while (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
  if (!ts.isElementAccessExpression(cur)) return false;
  const arg = cur.argumentExpression;
  return (
    ts.isIdentifier(cur.expression) &&
    cur.expression.text === name &&
    ts.isNumericLiteral(arg) &&
    arg.text === "0"
  );
}

function isNullLiteral(expr: ts.Expression): boolean {
  return unwrapExpression(expr).kind === ts.SyntaxKind.NullKeyword;
}

function statementListOf(node: ts.Node): ts.NodeArray<ts.Statement> | undefined {
  if (ts.isBlock(node) || ts.isSourceFile(node)) return node.statements;
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
  return undefined;
}

/** `const <name> = await <query>;` immediately followed by `return <name>[0] ?? null;`. */
function handWrittenFirstRow(sf: ts.SourceFile): string[] {
  const hits: string[] = [];
  forEachNode(sf, (node) => {
    const statements = statementListOf(node);
    if (!statements) return;
    for (let i = 0; i + 1 < statements.length; i++) {
      const decl = statements[i];
      const next = statements[i + 1];
      if (!ts.isVariableStatement(decl) || !ts.isReturnStatement(next) || !next.expression) continue;
      if (decl.declarationList.declarations.length !== 1) continue;
      const only = decl.declarationList.declarations[0];
      if (!ts.isIdentifier(only.name) || !only.initializer) continue;
      if (!ts.isAwaitExpression(only.initializer)) continue;
      const returned = next.expression;
      if (!ts.isBinaryExpression(returned)) continue;
      if (returned.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) continue;
      if (!isNullLiteral(returned.right)) continue;
      if (!indexesZeroOf(returned.left, only.name.text)) continue;
      hits.push(where(sf, decl));
    }
  });
  return hits;
}

/** `<name>.length === 0 ? null : <name>[0]…` — the ternary spelling of the same thing. */
function lengthTernary(sf: ts.SourceFile): string[] {
  const hits: string[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isConditionalExpression(node)) return;
    const condition = unwrapExpression(node.condition);
    if (!ts.isBinaryExpression(condition)) return;
    if (condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return;
    const left = unwrapExpression(condition.left);
    if (!ts.isPropertyAccessExpression(left) || left.name.text !== "length") return;
    if (!ts.isIdentifier(left.expression)) return;
    const right = unwrapExpression(condition.right);
    if (!ts.isNumericLiteral(right) || right.text !== "0") return;
    if (!isNullLiteral(node.whenTrue)) return;
    if (!indexesZeroOf(node.whenFalse, left.expression.text)) return;
    hits.push(where(sf, node));
  });
  return hits;
}

/** A repository function that RETURNS the `.limit(1)` builder, leaving the caller to index it. */
function returnsLimitOneArray(sf: ts.SourceFile): string[] {
  const hits: string[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isReturnStatement(node) || !node.expression) return;
    // An awaited result is a row array the function itself consumes, not a builder handed out.
    if (ts.isAwaitExpression(node.expression)) return;
    let cur: ts.Expression = unwrapExpression(node.expression);
    let sawLimitOne = false;
    while (ts.isCallExpression(cur)) {
      const target = unwrapExpression(cur.expression);
      if (!ts.isPropertyAccessExpression(target)) return;
      if (target.name.text === "limit") {
        const arg = cur.arguments[0];
        if (arg && ts.isNumericLiteral(arg) && arg.text === "1") sawLimitOne = true;
      }
      cur = unwrapExpression(target.expression);
    }
    if (!sawLimitOne) return;
    if (!ts.isIdentifier(cur)) return;
    if (cur.text !== "db" && cur.text !== "database") return;
    hits.push(where(sf, node));
  });
  return hits;
}

/**
 * Frozen at the count measured when #772 landed. A CAP, not a zero: migrating these changes
 * the return type of 50 exported repository functions and every call site, which #772
 * deliberately did not attempt. It may only go down.
 */
const LIMIT_ONE_ARRAY_CAP = 50;

const parsed = FILES.map((f) => parseGuardSource(f));

describe("firstRow is the single spelling for a limit(1) lookup (#772)", () => {
  it("scans the repository layer at all, so this ratchet cannot pass vacuously", () => {
    expect(parsed.length).toBeGreaterThan(50);
  });

  it("no repository hand-writes `const rows = await …; return rows[0] ?? null;`", () => {
    expect(
      parsed.flatMap(handWrittenFirstRow),
      "Use `firstRow(query)` from server/src/lib/first-row.ts instead (#772).",
    ).toEqual([]);
  });

  it("no repository hand-writes the `rows.length === 0 ? null : rows[0]` ternary", () => {
    expect(
      parsed.flatMap(lengthTernary),
      "Use `(await firstRow(query))?.field ?? null` instead (#772).",
    ).toEqual([]);
  });

  it("the un-migrated array-returning `.limit(1)` repositories only shrink", () => {
    const hits = parsed.flatMap(returnsLimitOneArray);
    expect(
      hits.length,
      "Returning a one-element array from a repository is the drift #772 froze. " +
        "Migrate one to firstRow and LOWER LIMIT_ONE_ARRAY_CAP; never raise it. Found:\n" +
        hits.join("\n"),
    ).toBeLessThanOrEqual(LIMIT_ONE_ARRAY_CAP);
  });

  it("firstRow is actually used across the repository layer", () => {
    const users = parsed.filter((sf) =>
      sf.statements.some(
        (s) =>
          ts.isImportDeclaration(s) &&
          ts.isStringLiteral(s.moduleSpecifier) &&
          s.moduleSpecifier.text.endsWith("lib/first-row.js"),
      ),
    );
    expect(users.length).toBeGreaterThanOrEqual(40);
  });
});
