// @gate:always-run — scans the __tests__ tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import path from "node:path";
import ts from "typescript";
import { walkTestFiles, parseGuardSource, forEachNode, lineOf } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * #921: `vi.useFakeTimers()` called at MODULE scope (outside any `beforeEach`/`it`) with no
 * matching `vi.useRealTimers()` anywhere in the file leaves fake timers installed for the rest
 * of the vitest worker's lifetime — real timers in whatever test file runs next in that
 * fork/thread stop firing, and `Date.now()` freezes.
 *
 * That is exactly how `worker-running-session-silence-ttl.test.ts` went order-dependent
 * (7/7 alone, one failure only in the full run): `broadcast-batch.test.ts` and
 * `broadcast-flush-on-exit.test.ts` both called `vi.useFakeTimers()` at the top of the file
 * and only ever `vi.clearAllTimers()` in `afterEach` — never `vi.useRealTimers()`.
 *
 * A per-test `it(() => { vi.useFakeTimers(); ...; vi.useRealTimers(); })` pair is fine and not
 * what this guards against; the failure mode is specifically a call that sits OUTSIDE every
 * hook/test body, because nothing then scopes its lifetime to a single test.
 */
const SRC = path.join(import.meta.dirname!, "..");

function isModuleScopeFakeTimersCall(node: ts.Node, sf: ts.SourceFile): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "useFakeTimers") return false;
  if (!ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "vi") return false;
  // Walk up: if any ancestor is a function body (arrow/function expression passed to
  // `it`/`beforeEach`/etc., or any other function), this call is scoped to that function
  // and its lifetime is not "for the rest of the file/worker".
  let cur: ts.Node = node;
  while (cur.parent) {
    cur = cur.parent;
    if (ts.isFunctionLike(cur)) return false;
    if (ts.isSourceFile(cur)) break;
  }
  return true;
}

function hasUseRealTimersCall(sf: ts.SourceFile): boolean {
  let found = false;
  forEachNode(sf, (node) => {
    if (found) return;
    if (!ts.isCallExpression(node)) return;
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    if (node.expression.name.text !== "useRealTimers") return;
    if (!ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "vi") return;
    found = true;
  });
  return found;
}

describe("a module-scope vi.useFakeTimers() is always paired with vi.useRealTimers() (#921)", () => {
  it("no test file leaves fake timers installed past its own run", () => {
    const offenders: string[] = [];
    for (const file of walkTestFiles(SRC)) {
      const sf = parseGuardSource(file);
      let moduleScopeCall: ts.Node | null = null;
      forEachNode(sf, (node) => {
        if (!moduleScopeCall && isModuleScopeFakeTimersCall(node, sf)) moduleScopeCall = node;
      });
      if (!moduleScopeCall) continue;
      if (!hasUseRealTimersCall(sf)) {
        offenders.push(`${path.relative(SRC, file)}:${lineOf(sf, moduleScopeCall)}`);
      }
    }
    expect(
      offenders,
      `Module-scope vi.useFakeTimers() with no vi.useRealTimers() anywhere in the file — ` +
        `fake timers leak into whatever test file vitest runs next in this worker:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
