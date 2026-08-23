// @gate:always-run — scans the whole client source tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  parseGuardSource,
  forEachNode,
  lineOf,
  calleeName,
  leadingCommentText,
} from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * The client's stated conventions, enforced (#601).
 *
 * `packages/client/CLAUDE.md` states three rules — one transport, one URL writer, one
 * settings reader — and until now all three were convention only. The client is also the
 * package whose guards reach the gate LAST: `test-mine`'s `PACKAGES` and the marker
 * ratchet's roots both had to be widened to include it (#639/#647), and even then the
 * client's two existing guard suites carried no `@gate:always-run`, so "classify by
 * declaration" stopped at the package boundary.
 *
 * Deliberately a TEST rather than only an eslint rule. `pnpm lint` is part of `pnpm check`,
 * but the pre-merge gate's `verify_script` is `test:mine` — so an eslint-only rule does not
 * gate a merge, which is exactly where these conventions need to hold.
 *
 * ## Why the two scanners are AST passes and not per-line regexes (#794, following #779)
 *
 * Both matched a regex against one LINE, which #779 proved is not evidence — the verdict
 * depends on where a formatter wrapped:
 *
 *   - `history.pushState` written as `history` / `.pushState(…)` across two lines matched
 *     nothing, and `location.pathname =` with the value on the next line failed the old
 *     `=[^=]` (there is no character after the `=` on that line) — so the URL-writer rule
 *     was evadable by a reflow nobody chose;
 *   - both scanners ran on a `stripComments` copy of the text, and stripping is a guess: a
 *     line whose string literal contains `//` lost everything after it, taking a real call
 *     with it. Comments are not nodes, so the AST needs no stripping at all;
 *   - the fetch exemption was read from the TWO raw lines above the match, so one exempted
 *     call granted its unexempted NEIGHBOUR the same pass — the comment was still within
 *     the lookback. `leadingCommentText` reads only the comment block directly above the
 *     call, at any nesting depth.
 */
const clientSrc = path.join(import.meta.dirname!, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

const files = walk(clientSrc);
const rel = (f: string) => path.relative(clientSrc, f).split(path.sep).join("/");
/**
 * Read each file at most ONCE for the whole suite.
 *
 * Every `it` below walks the same ~500-file list, so an uncached read did the same I/O
 * four times over. Alone that still finished inside vitest's 5s default; under
 * `pnpm test:mine`, where this suite competes with the other workers, it did not — and
 * because `test:mine` doubles as the merge verify_script, the timeout read as a FAILING
 * GATE on diffs that had nothing to do with it. Same failure mode, and same reasoning, as
 * the git suites' `GIT_IO_TIMEOUT_MS` note: the cost is I/O, not the code under test.
 * (`parseGuardSource` is memoised per path for the same reason, one layer down.)
 */
const readCache = new Map<string, string>();
const read = (f: string) => {
  let cached = readCache.get(f);
  if (cached === undefined) {
    cached = fs.readFileSync(f, "utf8");
    readCache.set(f, cached);
  }
  return cached;
};

/**
 * Explicit budget for the scanning tests. Belt to the cache's braces: it removes the
 * redundant work, this survives a slow or loaded machine. A hang still never completes,
 * so this only removes the false red.
 */
const SCAN_TIMEOUT_MS = Number(process.env.VITEST_GUARD_SCAN_TIMEOUT) || 60_000;

export interface ConventionHit {
  line: number;
  text: string;
}

const hit = (sf: ts.SourceFile, node: ts.Node): ConventionHit => ({
  line: lineOf(sf, node),
  text: node.getText(sf).replace(/\s+/g, " ").slice(0, 120),
});

/**
 * Raw `fetch(…)` calls with no `no-restricted-syntax` exemption above them. A bare
 * identifier only — a `.fetch(…)` method on some object belongs to that object, which is
 * what the old lookbehind expressed. Exported so the proof cases drive the REAL scanner.
 */
export function scanRawFetch(cacheKey: string, text: string): ConventionHit[] {
  const sf = parseGuardSource(cacheKey, text);
  const hits: ConventionHit[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "fetch") return;
    if (leadingCommentText(sf, node).includes("no-restricted-syntax")) return;
    hits.push(hit(sf, node));
  });
  return hits;
}

/** Writes to the URL: `history.pushState/replaceState(…)` and `location.pathname = …`. */
export function scanUrlWrites(cacheKey: string, text: string): ConventionHit[] {
  const sf = parseGuardSource(cacheKey, text);
  const hits: ConventionHit[] = [];
  /** `history`, `window.history`, `globalThis.history` — the receiver, not a same-named local field. */
  const receiverIs = (expr: ts.Expression, name: string): boolean =>
    new RegExp(`(^|\\.)${name}$`).test(expr.getText(sf).replace(/\s+/g, ""));
  forEachNode(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (
        (method === "pushState" || method === "replaceState") &&
        receiverIs(node.expression.expression, "history")
      ) {
        hits.push(hit(sf, node));
      }
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "pathname" &&
      receiverIs(node.left.expression, "location")
    ) {
      hits.push(hit(sf, node));
    }
  });
  return hits;
}

/**
 * Node-only APIs in browser-side source (#818).
 *
 * `packages/client` gained `@types/node` so that its ~11 node-side guard/ratchet suites could
 * typecheck instead of being excluded from `pnpm typecheck` altogether. But `types` is visible
 * to the WHOLE program, not just to test files — so the same change that removed a false red
 * opens a false GREEN: `import fs from "node:fs"` or `process.env.FOO` in a component now
 * typechecks perfectly and then throws at runtime in the browser, where neither exists.
 *
 * Hence this scanner. It is the half of #818 that makes the dependency safe to have, and the
 * `client-test-typecheck-ratchet` docblock points back here for the same reason.
 *
 * Scoped to source OUTSIDE `__tests__/`: node-side test support (`function-nloc-baseline.ts`
 * and friends) is legitimately node-side and never reaches a bundle. `.test.ts`/`.test.tsx` are
 * already out — `walk()` drops them.
 *
 * The check is an AST pass, not a regex, for the #794 reason: a formatter's line break must not
 * change the verdict, and a `node:fs` written inside a STRING is prose, not an import.
 */
export function scanNodeOnlyApis(cacheKey: string, text: string): ConventionHit[] {
  const sf = parseGuardSource(cacheKey, text);
  const hits: ConventionHit[] = [];
  const isNodeSpecifier = (node: ts.Node): boolean =>
    ts.isStringLiteralLike(node) && node.text.startsWith("node:");
  /**
   * `__dirname`/`__filename` are matched as bare identifiers, so the two positions where that
   * spelling is NOT a read of the global have to be excluded: a property NAME (`o.__dirname`)
   * and a property KEY (`{ __dirname: 1 }`).
   *
   * They are collected into a set rather than tested via `node.parent`, because the shared
   * `parseGuardSource` does not request parent pointers — `node.parent` is `undefined` here, so
   * a parent check silently passes everything. That is not a hypothetical: the first version of
   * this scanner used one, and its own proof case is what caught it.
   */
  const notAGlobalRead = new Set<ts.Node>();
  forEachNode(sf, (node) => {
    if (ts.isPropertyAccessExpression(node)) notAGlobalRead.add(node.name);
    else if (ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) notAGlobalRead.add(node.name);
  });
  forEachNode(sf, (node) => {
    // `import … from "node:fs"`, `export … from "node:fs"`, `import("node:fs")`, `require("node:fs")`
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (isNodeSpecifier(node.moduleSpecifier)) hits.push(hit(sf, node));
      return;
    }
    if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && node.arguments.length > 0 && isNodeSpecifier(node.arguments[0])) {
        hits.push(hit(sf, node));
      }
      return;
    }
    // `process.env`, `process.platform`, … — the global, not a same-named local field.
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process") {
      hits.push(hit(sf, node));
      return;
    }
    // `import.meta.dirname` / `import.meta.filename` — node-only, unlike Vite's `import.meta.env`.
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      (node.name.text === "dirname" || node.name.text === "filename")
    ) {
      hits.push(hit(sf, node));
      return;
    }
    if (ts.isIdentifier(node) && (node.text === "__dirname" || node.text === "__filename")) {
      if (notAGlobalRead.has(node)) return;
      hits.push(hit(sf, node));
    }
  });
  return hits;
}

describe("client conventions (#601)", () => {
  it("the scan reaches the client tree", () => {
    expect(files.length).toBeGreaterThan(200);
  }, SCAN_TIMEOUT_MS);

  /**
   * One transport. A raw `fetch` outside `lib/api.ts` is allowed ONLY with the
   * `eslint-disable-next-line no-restricted-syntax` exemption the eslint rule's own message
   * prescribes — which forces the reason to be written AT the call site rather than in an
   * allow-list in this file, where it would rot out of sight of the code it excuses.
   *
   * The existing rule only covers `components/`; both undocumented bypasses were in
   * `hooks/`, so this scanner covers the whole tree.
   */
  it("raw fetch() outside lib/api.ts carries a documented exemption", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (rel(file) === "lib/api.ts") continue;
      for (const h of scanRawFetch(file, read(file))) offenders.push(`${rel(file)}:${h.line}`);
    }
    expect(
      offenders,
      "use apiFetch/apiPost/… from lib/api.ts, or add an `eslint-disable-next-line " +
        "no-restricted-syntax -- <reason>` above the call:\n" + offenders.join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  /**
   * One URL writer (#446). Components change STATE; `routes/` decides the path and whether
   * it is a push or a replace. A component writing `history.pushState` is how the two
   * disagree about what one logical navigation means.
   */
  it("only routes/ writes the URL", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const r = rel(file);
      if (r.startsWith("routes/")) continue;
      for (const h of scanUrlWrites(file, read(file))) offenders.push(`${r}:${h.line}`);
    }
    expect(
      offenders,
      "change state and let routes/boardRouteSync.ts decide the path (see client/CLAUDE.md " +
        "“URL scheme”):\n" + offenders.join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  /**
   * One settings reader. `settingsStore` owns `/api/preferences` — a raw hit bypasses
   * `invalidateSettings()`, so the store and the server disagree until something else
   * refetches. 15 files still do it; frozen and shrink-only rather than allow-listed,
   * because a 15-entry list is a count wearing a disguise.
   *
   * #774 landed two more against the frozen 15 (#811): `WorkerDispatchPrefs` read AND WROTE
   * the settings map raw, which is the invariant hole rather than a style nit — its PUT
   * skipped `invalidateSettings()`, so every other consumer kept the pre-write dispatch
   * preferences for up to the store's 30s TTL. Both are now migrated (`getSettings`/
   * `setSettings`, and `useActiveProjectPreferenceQuery` for the fleet panel's
   * active-project read), so the count is back AT the baseline rather than the baseline
   * being raised to meet it. The number below has never moved and must not.
   */
  const PREFERENCES_BYPASS_BASELINE = 15;
  const preferenceBypasses = () =>
    files.filter((f) => !rel(f).includes("settingsStore") && read(f).includes("/api/preferences")).map(rel);

  it("the raw /api/preferences count only ever shrinks", () => {
    const hits = preferenceBypasses();
    expect(
      hits.length,
      "read/write settings through lib/settingsStore (it calls invalidateSettings):\n" + hits.join("\n"),
    ).toBeLessThanOrEqual(PREFERENCES_BYPASS_BASELINE);
  }, SCAN_TIMEOUT_MS);

  it("the baseline is not stale — lower it when the count drops", () => {
    expect(preferenceBypasses().length).toBe(PREFERENCES_BYPASS_BASELINE);
  }, SCAN_TIMEOUT_MS);

  /**
   * Browser-side source uses browser APIs. See `scanNodeOnlyApis` above for why this rule had
   * to arrive in the same change that gave the client `@types/node` (#818).
   *
   * There is no allow-list and no exemption comment, deliberately: unlike a raw `fetch` — which
   * has legitimate one-off uses that a comment can justify at the call site — `node:fs` in a
   * bundled module has none. If a genuine case appears, it belongs behind a lib/ seam, not
   * behind a waiver here.
   */
  it("browser-side source uses no node-only APIs", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relative = rel(file);
      if (relative.startsWith("__tests__/") || relative.includes("/__tests__/")) continue;
      for (const h of scanNodeOnlyApis(file, read(file))) {
        offenders.push(`${relative}:${h.line}  ${h.text}`);
      }
    }
    expect(
      offenders,
      "node-only APIs are not available in the browser. The client depends on @types/node so " +
        "its node-side guard suites can typecheck (#818), which means tsc will NOT catch this " +
        "for you:\n" + offenders.join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);
});

/**
 * #779's proof obligation (#794): each conversion must catch the form the old per-line
 * version could not see, and still catch the ones it did.
 */
describe("the client-convention scans see forms the per-line version could not (#794)", () => {
  const fetchScan = (name: string, lines: string[]) => scanRawFetch(`/virtual/client-fetch/${name}.ts`, lines.join("\n"));
  const urlScan = (name: string, lines: string[]) => scanUrlWrites(`/virtual/client-url/${name}.ts`, lines.join("\n"));

  it("still catches a plain raw fetch, and still honours the exemption above it", () => {
    expect(fetchScan("plain", ['const r = await fetch("/api/x");'])).toHaveLength(1);
    expect(
      fetchScan("exempt", [
        "// eslint-disable-next-line no-restricted-syntax -- streams SSE, apiFetch cannot",
        'const r = await fetch("/api/x");',
      ]),
    ).toEqual([]);
  });



  it("no longer lets ONE exemption excuse the NEXT call two lines below it", () => {
    // The old lookback joined the two preceding RAW lines, so the second call saw the first
    // call's comment at i-2 and was silently excused — an undocumented bypass of the rule
    // this guard exists to enforce.
    const hits = fetchScan("neighbour", [
      "// eslint-disable-next-line no-restricted-syntax -- streams SSE, apiFetch cannot",
      'const a = await fetch("/api/stream");',
      'const b = await fetch("/api/undocumented");',
    ]);
    expect(hits.map((h) => h.line)).toEqual([3]);
  });

  it("catches a fetch the comment-stripping pass used to delete along with a string", () => {
    // stripComments removed everything after a `//`, including one inside a string literal,
    // so the rest of that line — the call — disappeared before the pattern ever ran.
    const hits = fetchScan("string-slashes", ['const r = sep === "//" ? fetch(a) : fetch(b);']);
    expect(hits).toHaveLength(2);
  });

  it("still ignores prose and a fetch written inside a string", () => {
    expect(
      fetchScan("prose", [
        "// the timeline's own fetch (…) is described here",
        'const doc = "call fetch(url) directly";',
        "export const noop = () => doc;",
      ]),
    ).toEqual([]);
  });

  it("still catches the one-line URL writes the regex caught", () => {
    expect(urlScan("plain-push", ['history.pushState({}, "", "/p/x");'])).toHaveLength(1);
    expect(urlScan("plain-path", ['location.pathname = "/p/x";'])).toHaveLength(1);
    expect(urlScan("windowed", ['window.history.replaceState({}, "", "/p/x");'])).toHaveLength(1);
  });

  it("catches `history` / `.pushState()` split across lines", () => {
    const hits = urlScan("wrapped-push", ["window.history", '  .pushState({}, "", "/p/x");']);
    expect(hits).toHaveLength(1);
  });

  it("catches a pathname assignment whose value is on the NEXT line", () => {
    // The old pattern required a non-`=` character after the `=` ON THAT LINE, so a wrapped
    // assignment — where the `=` is the last thing on the line — matched nothing at all.
    const hits = urlScan("wrapped-path", ["window.location.pathname =", '  buildAppPath(state);']);
    expect(hits).toHaveLength(1);
  });

  it("does not count an equality comparison or prose as a URL write", () => {
    expect(
      urlScan("not-writes", [
        'if (location.pathname === "/p/x") return;',
        "// never call history.pushState from a component",
        'const doc = "location.pathname = \\"/p/x\\"";',
        "export const noop = () => doc;",
      ]),
    ).toEqual([]);
  });
});

/**
 * The node-only-API scanner bites (#818).
 *
 * This guard is the thing standing between `@types/node` and a false green, so "it passes on
 * today's tree" is not evidence — an empty scanner passes that too. Each case below drives the
 * REAL exported scanner, not a copy of its regexes.
 */
describe("the node-only-API scan bites (#818)", () => {
  const scan = (name: string, lines: string[]) => scanNodeOnlyApis(`/virtual/client-node/${name}.ts`, lines.join("\n"));

  it("catches every import form of a node builtin", () => {
    expect(scan("static", ['import fs from "node:fs";'])).toHaveLength(1);
    expect(scan("named", ['import { readFileSync } from "node:fs";'])).toHaveLength(1);
    expect(scan("reexport", ['export { join } from "node:path";'])).toHaveLength(1);
    expect(scan("dynamic", ['const fs = await import("node:fs");'])).toHaveLength(1);
    expect(scan("require", ['const fs = require("node:fs");'])).toHaveLength(1);
  });

  it("catches the node globals", () => {
    expect(scan("env", ["const mode = process.env.NODE_ENV;"])).toHaveLength(1);
    expect(scan("platform", ["if (process.platform === 'win32') {}"])).toHaveLength(1);
    expect(scan("dirname", ["const here = __dirname;"])).toHaveLength(1);
    expect(scan("metadirname", ["const here = import.meta.dirname;"])).toHaveLength(1);
  });

  it("catches an import a per-line regex would miss because the specifier wrapped", () => {
    expect(scan("wrapped", ["import {", "  readFileSync,", '} from "node:fs";'])).toHaveLength(1);
  });

  it("does not fire on browser APIs or on prose that merely mentions node", () => {
    expect(scan("vite", ["const url = import.meta.env.VITE_API_URL;"])).toEqual([]);
    expect(scan("browserimport", ['import { useState } from "react";'])).toEqual([]);
    expect(scan("string", ['const doc = "import fs from node:fs is banned here";'])).toEqual([]);
    expect(scan("comment", ["// node:fs is not available in the browser", "const x = 1;"])).toEqual([]);
  });

  it("does not fire on a same-named local, which is what makes the AST pass worth having", () => {
    // A field called `process` on some object is not the node global.
    expect(scan("field", ["const job = { process: { env: {} } };", "const e = job.process.env;"])).toEqual([]);
    expect(scan("prop", ["const o = { __dirname: 1 };", "const v = o.__dirname;"])).toEqual([]);
  });
});
