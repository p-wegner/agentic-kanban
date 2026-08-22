// @gate:always-run — scans every package's src tree for the client-port ladder; imports
// nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  walkPackageSources,
  compareRatchet,
  parseGuardSource,
  forEachNode,
  lineOf,
} from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * ONE board-client port ladder (#690, the sibling of #615's server-port guard), asserted on
 * the AST (#721).
 *
 * `process.env.KANBAN_CLIENT_PORT || process.env.VITE_PORT || "5173"` was copied verbatim
 * into the agent launch env, the review-agent prompt, and the post-merge verify-agent prompt,
 * while `shared/lib/board-server-url.ts` now exports `resolveBoardClientPort` for exactly
 * this.
 *
 * ## Why this is an AST pass and not a regex (#721)
 *
 * The regex was `/\bKANBAN_CLIENT_PORT\b\s*\)?\s*(?:\|\||\?\?)/` — the name, then a
 * coalescing operator. #721 fault-injected it and three forms walked through: a `VITE_PORT`
 * fallback with no mention of `KANBAN_CLIENT_PORT` at all, a two-paren
 * `Number(String(process.env.KANBAN_CLIENT_PORT)) || 5173`, and the ternary form. The first
 * of those is the exact miss #690 was filed to fix, and it shipped in the same commit as the
 * guard: `seed-example-session.ts` has been writing `process.env.VITE_PORT || 5173` the whole
 * time.
 *
 * So the property is asserted in two halves, and neither depends on the spelling of the
 * expression around it:
 *
 *   1. **any READ of the ladder's environment variables** — `process.env.KANBAN_CLIENT_PORT`,
 *      `process.env["VITE_PORT"]`, `env.VITE_PORT` on an injected env object. A read is
 *      enough; what follows it does not matter. WRITES are not reads: an object-literal
 *      `{ VITE_PORT: String(port) }` building a child process's env, and a
 *      `KANBAN_CLIENT_PORT?: string` field in a type, are how the ladder's values get
 *      PROPAGATED and are untouched by this guard.
 *   2. **the default 5173 in a defaulting position** — an operand of `||`/`??`, a branch of a
 *      ternary, a parameter default, or the initialiser of a `*ClientPort*` constant. That
 *      catches `Number(String(…)) || 5173` and `x ? Number(x) : 5173` without knowing either
 *      shape, and it deliberately does NOT catch `5173` inside a URL or a UI placeholder
 *      (`placeholder="5173"`, `"http://localhost:5173"`), which default nothing.
 *
 * Comments are not AST nodes, so the old `stripComments` step is gone with the regex.
 */
const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const repoRoot = path.join(packagesRoot, "..");
const SCAN_ROOTS = ["server/src", "shared/src", "mcp-server/src", "client/src"];

/** The ladder's rungs. Reading either one is what `resolveBoardClientPort` is for. */
const LADDER_VARS = new Set(["KANBAN_CLIENT_PORT", "VITE_PORT"]);
/** The ladder's last rung. */
const DEFAULT_PORT = "5173";

/**
 * Files that still hold a rung of the ladder, `[count, why]`, and only ever shrinking.
 *
 * The regex found 3 files; the AST finds 8, and the five extra entries are not new code —
 * they are what "one ladder" was never actually asserting. Two are the worktree port math
 * (`5173 + N`), a genuinely different ladder that happens to share its base; three are #690
 * leftovers, pinned here rather than fixed, because production code is not this ticket's to
 * touch.
 */
const SANCTIONED: Record<string, [count: number, why: string]> = {
  "packages/shared/src/lib/board-server-url.ts": [
    3,
    "the resolver itself — the one place the ladder may live: both env reads plus the 5173 default",
  ],
  "packages/server/src/services/preflight-check.ts": [
    2,
    "asks whether the operator SET a client port, so it must see the raw env — the resolver " +
      "always returns a number and would make the warning below it unreachable",
  ],
  "packages/server/src/routes/butler.ts": [
    2,
    "falls back to the already-resolved server port (single-port production deployment), " +
      "not the resolver's hardcoded 5173 dev default",
  ],
  "packages/server/src/services/worktree-ports.ts": [
    1,
    "`BASE_CLIENT_PORT = 5173` is the base of THIS app's private per-worktree math " +
      "(5173 + N), not an env fallback — a different ladder that shares a first rung",
  ],
  "packages/client/src/lib/workspace-preview.ts": [
    1,
    "the client half of the same worktree math, computing a preview URL for a branch it is " +
      "not running on; it reads no env at all",
  ],
  "packages/server/src/lib/agent-launch-env.ts": [
    1,
    "#690 leftover: `DEFAULT_BOARD_CLIENT_PORT = \"5173\"` is a second copy of the resolver's " +
      "default, kept only to seed the launch env — it should come from resolveBoardClientPort()",
  ],
  "packages/server/src/services/stale-dev-processes.ts": [
    3,
    "#690 leftover: its own `DEFAULT_BOARD_CLIENT_PORT` plus both env reads, parsed through a " +
      "local `parsePort` because it wants a port-or-nothing rather than a port-or-default",
  ],
  "packages/server/src/scripts/seed-example-session.ts": [
    2,
    "#690 leftover, and the exact form the old regex could not see: " +
      "`process.env.VITE_PORT || 5173` in a console hint, mentioning neither KANBAN_CLIENT_PORT " +
      "nor the resolver",
  ],
};

const relFromRepo = (abs: string): string => path.relative(repoRoot, abs).split(path.sep).join("/");

/** `process.env.X` / `process.env["X"]` / `env.X` — a READ of one of the ladder's variables. */
function ladderEnvRead(node: ts.Node): string | null {
  let object: ts.Expression | null = null;
  let key: string | null = null;
  if (ts.isPropertyAccessExpression(node)) {
    object = node.expression;
    key = node.name.text;
  } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    object = node.expression;
    key = node.argumentExpression.text;
  }
  if (!object || key === null || !LADDER_VARS.has(key)) return null;
  // The container must be an env bag: `process.env`, a bare `env`, or `<something>.env`.
  const objectText = ts.isPropertyAccessExpression(object)
    ? object.name.text
    : ts.isIdentifier(object)
      ? object.text
      : null;
  return objectText !== null && /^env$/i.test(objectText) ? key : null;
}

/** Is this literal `5173` sitting where a DEFAULT is chosen, rather than inside a URL or a label? */
function isDefaultingPosition(parent: ts.Node | undefined, node: ts.Node): boolean {
  if (!parent) return false;
  if (ts.isBinaryExpression(parent)) {
    return (
      (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
      parent.right === node
    );
  }
  if (ts.isConditionalExpression(parent)) return parent.whenTrue === node || parent.whenFalse === node;
  if (ts.isParameter(parent) || ts.isPropertyDeclaration(parent)) return parent.initializer === node;
  // `const DEFAULT_BOARD_CLIENT_PORT = 5173` — a named second copy of the resolver's default.
  if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
    return /client_?port/i.test(parent.name.text.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
  }
  return false;
}

/** Every place this file holds a rung of the client-port ladder, with the line and the reason. */
function offencesIn(sf: ts.SourceFile): string[] {
  const hits: string[] = [];
  forEachNode(sf, (node, parent) => {
    const envVar = ladderEnvRead(node);
    if (envVar !== null) {
      hits.push(`line ${lineOf(sf, node)}: reads ${envVar}`);
      return;
    }
    const isPort =
      (ts.isNumericLiteral(node) && node.text === DEFAULT_PORT) ||
      (ts.isStringLiteralLike(node) && node.text === DEFAULT_PORT);
    if (isPort && isDefaultingPosition(parent, node)) {
      hits.push(`line ${lineOf(sf, node)}: defaults to ${DEFAULT_PORT}`);
    }
  });
  return hits;
}

function scan(): { counts: Record<string, number>; detail: Record<string, string[]> } {
  const counts: Record<string, number> = {};
  const detail: Record<string, string[]> = {};
  for (const root of SCAN_ROOTS) {
    for (const file of walkPackageSources(path.join(packagesRoot, root))) {
      const hits = offencesIn(parseGuardSource(file, fs.readFileSync(file, "utf8")));
      if (hits.length === 0) continue;
      const rel = relFromRepo(file);
      counts[rel] = hits.length;
      detail[rel] = hits;
    }
  }
  return { counts, detail };
}

describe("board-client port ladder is single-source (#690, #721)", () => {
  const { counts, detail } = scan();

  it("no file outside the sanctioned resolver hand-rolls a rung of the ladder", () => {
    const baseline = Object.fromEntries(Object.entries(SANCTIONED).map(([file, [count]]) => [file, count]));
    const { over, stale } = compareRatchet(baseline, counts);

    expect(
      over,
      [
        "use `resolveBoardClientPort()` from @agentic-kanban/shared/lib/board-server-url",
        "(it takes an injectable `env`), or add a reason to SANCTIONED:",
        "",
        ...over.map((entry) => {
          const file = entry.split(":")[0]!;
          return `${entry}\n    ${(detail[file] ?? []).join("\n    ")}`;
        }),
      ].join("\n"),
    ).toEqual([]);

    // The other direction: an exception that has grown generous stops being an exception.
    expect(stale, ["SANCTIONED is now generous — lower or delete these:", ...stale].join("\n")).toEqual([]);
  });

  it("every sanctioned exception still exists and still holds a rung", () => {
    for (const [rel, [, why]] of Object.entries(SANCTIONED)) {
      const abs = path.join(repoRoot, rel);
      expect(fs.existsSync(abs), `${rel} is gone — drop it from SANCTIONED (${why})`).toBe(true);
      expect(
        counts[rel] ?? 0,
        `${rel} no longer holds a rung of the ladder — drop it from SANCTIONED (${why})`,
      ).toBeGreaterThan(0);
    }
  });
});
