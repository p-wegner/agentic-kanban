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

function isViCall(node: ts.Node, methodName: string): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== methodName) return false;
  return ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "vi";
}

// `setParentNodes: false` (see guard-scan.ts) means `node.parent` is undefined, so ancestry
// has to come from forEachNode's own parent-tracking walk, not from the node itself.
function isScopedToAFunction(node: ts.Node, parentOf: Map<ts.Node, ts.Node>): boolean {
  let cur: ts.Node | undefined = node;
  while ((cur = parentOf.get(cur))) {
    if (ts.isFunctionLike(cur)) return true;
  }
  return false;
}

describe("a module-scope vi.useFakeTimers() is always paired with vi.useRealTimers() (#921)", () => {
  it("no test file leaves fake timers installed past its own run", () => {
    const offenders: string[] = [];
    for (const file of walkTestFiles(SRC)) {
      const sf = parseGuardSource(file);
      const parentOf = new Map<ts.Node, ts.Node>();
      let moduleScopeCall: ts.Node | null = null;
      let hasRealTimersAnywhere = false;
      forEachNode(sf, (node, parent) => {
        if (parent) parentOf.set(node, parent);
        if (isViCall(node, "useRealTimers")) hasRealTimersAnywhere = true;
        // Only the FIRST module-scope offender per file needs reporting; a function-scoped
        // call (inside `it`/`beforeEach`/etc.) is not what this guards against.
        if (!moduleScopeCall && isViCall(node, "useFakeTimers") && !isScopedToAFunction(node, parentOf)) {
          moduleScopeCall = node;
        }
      });
      if (!moduleScopeCall) continue;
      if (!hasRealTimersAnywhere) {
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
