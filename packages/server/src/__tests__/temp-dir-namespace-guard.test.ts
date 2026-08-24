// @gate:always-run
/**
 * #839 — a temp dir minted OUTSIDE the reaper's swept namespace leaks permanently.
 *
 * The reaper (`helpers/reap-fixture-child-servers.ts`, vitest `globalSetup` for this package)
 * removes stale `%TEMP%` entries whose NAME starts with one of `SWEPT_TEMP_NAMESPACES` —
 * `kanban-`/`ak-` after two hours, the nine `plugin-*`/`view-*` fixture prefixes after 60s. A
 * fixture dir called anything else is in no swept namespace at all, so the moment its teardown
 * fails for any reason — a Windows handle still open, an exception earlier in the hook, a
 * killed worker that never reached `afterAll` — it stays on disk forever.
 *
 * #364 already fixed the accumulated ones (8,448 `kanban-*` dirs measured) and
 * `fixture-temp-dir-sweep.test.ts` locks THOSE prefixes in. But that test asserts a
 * hand-listed set of prefixes someone once counted; nothing stopped the NEXT suite minting a
 * fresh unswept prefix, which is exactly how the set re-accumulated: measured at this ticket,
 * **149 distinct unswept `mkdtemp` prefixes across 99 files**, including the five the ticket
 * was filed about. A list of known offenders cannot prevent a new one — only a scan can.
 *
 * So this walks the source tree and re-derives the offenders instead of listing them.
 *
 * **Site detection is on the TS AST; the MARKER lookup stays line-based (#849).** The three
 * passes used to match `mkdtemp(...)` / `join(tmpdir(), ...)` with a regex per LINE against real
 * TypeScript, so a call wrapped across two lines walked straight past:
 *
 * ```ts
 * const dir = join(
 *   tmpdir(),
 *   `leaky-${randomUUID()}`,
 * );
 * ```
 *
 * That is #779's defect exactly — `pref-polarity-ratchet` was green on a tree holding what it
 * forbids, because the violation sat in a two-line form. A guard this one is load-bearing:
 * it is what stands between the repo and a repeat of #843's 518,581 loose `test-db-*` files.
 *
 * The marker half genuinely needs lines and deliberately keeps them: `findOkMarker` walks the
 * contiguous comment block upward from a site, comment adjacency IS a line concept, and the
 * orphan check below needs the marker's own line number to report it. So this is an AST site
 * scan feeding a line-based marker lookup — not a wholesale rewrite.
 *
 * `node.getText(sf)` and `node.getStart(sf)` both work without parent pointers as long as the
 * source file is passed explicitly, which is why `setParentNodes: false` is no obstacle here.
 *
 * Three shapes are checked, and only the first is a grep:
 *
 *  1. A direct site: `mkdtempSync(join(tmpdir(), "some-prefix-"))`.
 *  2. A HELPER site: a suite that writes `makeTempDir("some-prefix-")`, where `makeTempDir`
 *     is a local function ending in `mkdtempSync(join(tmpdir(), prefix))`. Those account for
 *     38 of the offenders and a literal-only scan is blind to every one of them. The helper
 *     names are DERIVED (any function whose body mints a temp dir from a parameter), not
 *     hand-listed, so a newly written helper is covered without editing this file.
 *  3. A NON-`mkdtemp` child of `tmpdir()`: `join(tmpdir(), `thing-${randomUUID()}`)` (#840).
 *     Both passes above key off the word `mkdtemp`, so a path merely BUILT under `tmpdir()` and
 *     then `mkdirSync`'d — or written as a loose file — was invisible to this guard. That blind
 *     spot is not theoretical: it is how **518,581 `test-db-*` entries** accumulated in `%TEMP%`
 *     while this suite stayed green.
 *
 * **The discriminator for pass 3 is uniqueness per run, NOT `mkdtemp`.** `join(tmpdir(),
 * "agentic-kanban")` is a stable singleton: one entry, reused forever, cannot accumulate — and
 * sweeping it would delete a live cache out from under a running process. A name carrying a
 * uuid, a pid or a timestamp mints a fresh entry every run and therefore leaks. Only the second
 * kind is flagged; 15 stable singletons were measured at #840 and all are correct as they are.
 *
 * A loose FILE cannot be fixed by a rename — the reaper is gated on `statSync(…).isDirectory()`,
 * so `ak-thing-<uuid>.db` is exactly as unswept as `thing-<uuid>.db`. The fix for a file is to
 * mint it INSIDE an `ak-` directory (see `helpers/test-db.ts`). This guard cannot tell the two
 * apart from the call text, which is why its failure message says so rather than saying "rename".
 *
 * Escape hatch: `// TEMP-PREFIX OK: <reason>` on the offending line, or anywhere in the
 * contiguous run of comment lines directly above it (a reason worth writing rarely fits on one
 * line, and a marker on line 1 of a five-line block used to be silently ignored). It has a
 * staleness half — a marker that no longer sits at a temp-prefix site FAILS, so an exemption
 * cannot outlive the code it was written for.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  calleeName,
  forEachNode,
  lineOf,
  parseGuardSource,
  unwrapExpression,
} from "../../../shared/__tests__/helpers/guard-scan.js";
import { matchedNamespace } from "./helpers/reap-fixture-child-servers.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SCAN_ROOTS = ["packages", "scripts", "test-setup"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "test-results", "playwright-report", "drizzle"]);
const SOURCE_EXT = /\.(ts|tsx|mjs|cjs|js)$/;

const OK_MARKER = "TEMP-PREFIX OK:";

/**
 * SITES this ticket could not fix, with the reason. Keyed `<file>::<prefix>` — a whole-FILE
 * entry would hide every future offender in that file, which is exactly how #840's own third
 * finding stayed invisible under #839.
 *
 * Shrink-only: remove an entry when it is fixed, never add one to make a new offender pass —
 * and the staleness assertion below fails if an entry no longer offends, so a stale entry
 * cannot sit here looking like ongoing debt.
 */
const KNOWN_UNSWEPT: Record<string, string> = {
  "packages/shared/src/lib/db-path.ts::agentic-kanban-vitest-":
    "One `.db` per vitest PROCESS, so it genuinely accumulates — but `resolveDbLocation` is a " +
    "PURE resolver that never mkdirs (its own comment says so, and the file is deliberately " +
    "`tmpdir()` itself so the parent always exists). Minting inside an `ak-` directory would " +
    "break that contract, and libsql will not create a missing parent. Renaming it `ak-…` would " +
    "make this guard green while changing nothing — it is a loose FILE, and the reaper only " +
    "sweeps directories. Left as-is deliberately rather than fixed cosmetically (#840).",
};

interface Site {
  file: string;
  line: number;
  prefix: string;
  shape: string;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      // `readdir` reports a junction as a symlink, never a directory (plugin skills are
      // junctioned in), so ask `statSync` rather than trusting `isDirectory()`.
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) walk(full);
      else if (SOURCE_EXT.test(entry.name)) out.push(full);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return out;
}

/**
 * The name mints a NEW entry every run. That — not `mkdtemp` — is what separates a leak from a
 * stable singleton: `join(tmpdir(), "agentic-kanban")` is one reusable entry that can never
 * accumulate (and must never be swept), while anything carrying a uuid, a pid, a timestamp or a
 * random draw is a fresh entry per run.
 *
 * Applied to the ARGUMENT NODE's own text (`arg.getText(sf)`), so it reads the whole expression
 * however it is wrapped — the line-based version could only see the fragment that happened to
 * share a line with the `join(`.
 */
const PER_RUN_NAME = /\$\{|process\.pid|Date\.now\s*\(|randomUUID\s*\(|randomBytes\s*\(|Math\.random\s*\(/;
/** A line of PROSE about the shape is not the shape — kept for the ORPHAN scan, which is textual. */
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*)/;

const MKDTEMP_CALLEES = new Set(["mkdtemp", "mkdtempSync"]);
const PATH_JOINERS = new Set(["join", "resolve"]);

/** Is this expression a call to `tmpdir()` (bare or `os.tmpdir()`)? */
function isTmpdirCall(expr: ts.Expression): boolean {
  const inner = unwrapExpression(expr);
  return ts.isCallExpression(inner) && calleeName(inner) === "tmpdir";
}

/** For `join(tmpdir(), X)` / `resolve(tmpdir(), X)` return `X`; otherwise null. */
function tmpdirChildName(call: ts.CallExpression): ts.Expression | null {
  if (!PATH_JOINERS.has(calleeName(call) ?? "")) return null;
  if (call.arguments.length < 2) return null;
  if (!isTmpdirCall(call.arguments[0]!)) return null;
  return call.arguments[1]!;
}

/**
 * The LEADING string literal of a name expression — the part that decides which namespace the
 * entry lands in — or `null` when the name is decided elsewhere.
 *
 * `null` and `""` mean different things and both callers depend on the difference:
 *  - `null` — an identifier, a call, an interpolation in FIRST position: nothing to judge here.
 *  - `""`   — an empty leading literal (`` `${x}-thing` ``): the name IS decided by the caller,
 *             which is what makes the enclosing function a prefix-taking helper (pass 2).
 */
function literalHead(expr: ts.Expression): string | null {
  const node = unwrapExpression(expr);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  // `"prefix-" + suffix` — the leading literal still decides the namespace.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return literalHead(node.left);
  }
  return null;
}

/** A pure literal with no interpolation — what pass 2 requires of a helper's first argument. */
function pureLiteral(expr: ts.Expression): string | null {
  const node = unwrapExpression(expr);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * The name of the FUNCTION a node sits inside, for the walk-maintained stack.
 *
 * A plain `const path = mkdtempSync(...)` must NOT contribute a name: the enclosing helper is
 * `createManagedTempDir`, not `path`, and pass 2 looks up CALL SITES of that name. Naming the
 * variable instead silently emptied pass 2 for every helper whose mkdtemp result is assigned —
 * which is most of them.
 */
function declaredName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? null;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return node.name.text;
  }
  return null;
}

/**
 * Index of the `TEMP-PREFIX OK:` marker covering the site on `lineIndex`, or null.
 *
 * The marker may sit on the offending line itself, or ANYWHERE in the contiguous run of comment
 * lines directly above it. Checking only `lineIndex - 1` (what this did before #840) silently
 * ignores a marker written at the TOP of a multi-line block — and a marker worth writing usually
 * needs a paragraph, so that is the normal way to write one. `helpers/test-db.ts` already
 * carried exactly that shape, seven lines above its site.
 */
function findOkMarker(lines: string[], lineIndex: number): number | null {
  if ((lines[lineIndex] ?? "").includes(OK_MARKER)) return lineIndex;
  for (let i = lineIndex - 1; i >= 0 && COMMENT_LINE.test(lines[i] ?? ""); i--) {
    if (lines[i]!.includes(OK_MARKER)) return i;
  }
  return null;
}

interface ScanResult {
  sites: Site[];
  /** `line` is the MARKER's line, not the site's — the orphan check below matches on it. */
  exempted: Array<{ file: string; line: number; shape: string }>;
  helperNames: string[];
}

function scan(): ScanResult {
  const files = sourceFiles();
  /** `absPath -> { rel, lines, sf }` for every file that could hold a site or a marker. */
  const parsed = new Map<string, { rel: string; lines: string[]; sf: ts.SourceFile }>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!src.includes("tmpdir()") && !src.includes("TEMP-PREFIX OK")) continue;
    parsed.set(f, {
      rel: relative(REPO_ROOT, f).replace(/\\/g, "/"),
      lines: src.split(/\r?\n/),
      sf: parseGuardSource(f, src),
    });
  }

  const sites: Site[] = [];
  const exempted: Array<{ file: string; line: number; shape: string }> = [];
  const helperNames = new Set<string>();

  /** Record a site at `node`, unless a `TEMP-PREFIX OK:` marker covers its line. */
  const record = (
    entry: { rel: string; lines: string[]; sf: ts.SourceFile },
    node: ts.Node,
    prefix: string,
    shape: string,
  ): void => {
    const lineIndex = lineOf(entry.sf, node) - 1;
    const marker = findOkMarker(entry.lines, lineIndex);
    if (marker !== null) {
      exempted.push({ file: entry.rel, line: marker + 1, shape });
      return;
    }
    sites.push({ file: entry.rel, line: lineIndex + 1, prefix, shape });
  };

  /**
   * Walk once per file carrying the enclosing function's name, and collect all three shapes in
   * that single pass. The name stack is what replaces the old `enclosingFunctionName` lookback,
   * which guessed by scanning up to 30 lines for something that looked like a declaration — it
   * could name the wrong function for a site inside a nested callback, and could name none at
   * all for a site more than 30 lines into a long helper.
   */
  const walkFile = (entry: { rel: string; lines: string[]; sf: ts.SourceFile }): void => {
    const { sf } = entry;
    const stack: Array<string | null> = [];
    /** `join(...)` nodes that ARE the argument of a `mkdtemp*` call — pass 1's, not pass 3's. */
    const ownedByMkdtemp = new Set<ts.Node>();

    const visit = (node: ts.Node): void => {
      const named = declaredName(node);
      if (named !== null) stack.push(named);

      if (ts.isCallExpression(node)) {
        const callee = calleeName(node);

        // Pass 1 — `mkdtempSync(join(tmpdir(), <name>))`.
        if (MKDTEMP_CALLEES.has(callee ?? "") && node.arguments.length > 0) {
          const arg = unwrapExpression(node.arguments[0]!);
          if (ts.isCallExpression(arg)) {
            const name = tmpdirChildName(arg);
            if (name) {
              ownedByMkdtemp.add(arg);
              const head = literalHead(name);
              if (head) {
                record(entry, node, head, "mkdtemp");
              } else {
                // No literal head at all (an identifier), or an EMPTY one (a template opening
                // with an interpolation): either way the caller decides the name, so the
                // enclosing function is a prefix-taking helper and pass 2 judges its call
                // sites instead of guessing a prefix here.
                const fn = [...stack].reverse().find((n): n is string => n !== null);
                if (fn) helperNames.add(fn);
              }
            }
          }
        }

        // Pass 3 — a child of `tmpdir()` built WITHOUT `mkdtemp`, unique per run (#840).
        if (!ownedByMkdtemp.has(node)) {
          const name = tmpdirChildName(node);
          // `getText(sf)` reads the whole name expression however it is wrapped, which is the
          // half of #849 that the per-line regex could not do.
          if (name && PER_RUN_NAME.test(name.getText(sf))) {
            const head = literalHead(name);
            // No leading literal means the NAME is decided elsewhere; there is nothing to judge
            // here, so say nothing rather than guess.
            if (head) record(entry, node, head, "tmpdir-child");
          }
        }
      }

      node.forEachChild(visit);
      if (named !== null) stack.pop();
    };

    // `mkdtemp` sites must be seen BEFORE the `join` inside them is judged as a pass-3 site,
    // and a pre-order walk gives exactly that: the outer call is visited first.
    visit(sf);
  };

  for (const entry of parsed.values()) walkFile(entry);

  // Pass 2 — call sites of those helpers, whose literal first argument IS the prefix.
  if (helperNames.size > 0) {
    for (const entry of parsed.values()) {
      forEachNode(entry.sf, (node) => {
        if (!ts.isCallExpression(node)) return;
        if (!helperNames.has(calleeName(node) ?? "")) return;
        if (node.arguments.length === 0) return;
        // Only a PURE literal is a prefix. An interpolated argument is a name assembled at the
        // call site, which this guard has never claimed to judge.
        const prefix = pureLiteral(node.arguments[0]!);
        if (prefix !== null) record(entry, node, prefix, "helper-call");
      });
    }
  }

  return { sites, exempted, helperNames: [...helperNames] };
}

const result = scan();

describe("every fixture temp dir is minted in a swept namespace (#839)", () => {
  it("finds the temp-dir call sites at all — a scan that matches nothing proves nothing", () => {
    // The whole guard is a no-op if the regexes stop matching (a refactor to a different
    // helper shape, a rename of `tmpdir()`), and a silent no-op reads exactly like a pass.
    expect(result.sites.length + result.exempted.length).toBeGreaterThan(200);
    expect(result.helperNames.length).toBeGreaterThan(0);
    // Pass 3 has its own floor: it keys off the ABSENCE of `mkdtemp`, so it would go quietly
    // dead if `TMPDIR_CHILD` ever stopped matching, and the other two passes would still carry
    // the total above 200 — hiding it. Measured at #840: 43 unique-per-run non-mkdtemp sites.
    const pass3 =
      result.sites.filter((s) => s.shape === "tmpdir-child").length +
      result.exempted.filter((e) => e.shape === "tmpdir-child").length;
    expect(pass3, "the non-mkdtemp tmpdir-child pass matches nothing — it has gone dead").toBeGreaterThan(20);
  });

  it("no temp dir is minted outside the reaper's swept namespace", () => {
    const offenders = result.sites
      .filter((s) => matchedNamespace(`${s.prefix}x`) === null)
      .filter((s) => !(`${s.file}::${s.prefix}` in KNOWN_UNSWEPT))
      .map((s) => `${s.file}:${s.line} -> ${JSON.stringify(s.prefix)} [${s.shape}]`);
    expect(
      offenders,
      "These temp entries are in NO namespace the reaper sweeps, so the first teardown that " +
        "fails for any reason leaks them permanently — which is how 8,448 of them " +
        "accumulated (#364), and 518,581 more (#840) while this guard was green.\n\n" +
        "If it becomes a DIRECTORY, prefix the name with `ak-` (e.g. " +
        '`mkdtempSync(join(tmpdir(), "ak-my-fixture-"))`) — the reaper sweeps directories.\n' +
        "If it is a loose FILE, a rename buys NOTHING (the reaper is gated on " +
        "`statSync(...).isDirectory()`): mint it INSIDE an `ak-` directory instead — see " +
        "`helpers/test-db.ts` for the pattern.\n" +
        "If the path is deliberately never created (a negative test), put " +
        `\`// ${OK_MARKER} <reason>\` on the line, or anywhere in the comment block above it.`,
    ).toEqual([]);
  });

  it("a grandfathered site still offends — an entry that does not is deleted, not kept", () => {
    // The staleness half. Without it a fixed site sits in the list forever, and the list stops
    // describing anything: the next reader cannot tell debt from decoration.
    for (const [key, reason] of Object.entries(KNOWN_UNSWEPT)) {
      const [file, prefix] = key.split("::");
      const stillOffends = result.sites.some(
        (s) => s.file === file && s.prefix === prefix && matchedNamespace(`${s.prefix}x`) === null,
      );
      expect(
        stillOffends,
        `${key} is grandfathered ("${reason}") but no longer mints an unswept temp entry — ` +
          "DELETE its entry from KNOWN_UNSWEPT rather than leaving it.",
      ).toBe(true);
    }
  });

  it("every TEMP-PREFIX OK marker sits at a real temp-prefix site", () => {
    // The other staleness half: an exemption that outlives its call site is a licence nobody
    // is checking. Every marker must be claimed by the scan above.
    const claimed = new Set(result.exempted.map((e) => `${e.file}:${e.line}`));
    const orphans: string[] = [];
    for (const f of sourceFiles()) {
      const rel = relative(REPO_ROOT, f).replace(/\\/g, "/");
      // This file DEFINES the marker string; its own mentions are documentation.
      if (rel.endsWith("temp-dir-namespace-guard.test.ts")) continue;
      const src = readFileSync(f, "utf8");
      if (!src.includes(OK_MARKER)) continue;
      src.split(/\r?\n/).forEach((line, i) => {
        if (!line.includes(OK_MARKER)) return;
        // `exempted` records the MARKER's own line (see `findOkMarker`), so a marker anywhere in
        // a comment block above a site is claimed at its real position — no ±1 guessing.
        if (claimed.has(`${rel}:${i + 1}`)) return;
        orphans.push(`${rel}:${i + 1} -> ${line.trim().slice(0, 120)}`);
      });
    }
    expect(orphans, `A \`${OK_MARKER}\` marker no longer sits at a temp-prefix site — delete it.`).toEqual([]);
  });

  it("a call wrapped across lines is caught — the whole point of the AST conversion (#849)", () => {
    // The regex-per-line version was green on exactly this, which is #779's defect: a guard
    // that a line wrap defeats is how the next unswept site lands unnoticed. Synthesized
    // source, parsed the same way the scan parses the tree, so this proves the SHAPE matching
    // rather than restating it.
    const source = [
      'import { join } from "node:path";',
      'import { tmpdir } from "node:os";',
      'import { randomUUID } from "node:crypto";',
      "const wrapped = join(",
      "  tmpdir(),",
      "  `leaky-${randomUUID()}`,",
      ");",
      'const oneLine = join(tmpdir(), `also-leaky-${randomUUID()}`);',
      'const singleton = join(tmpdir(), "agentic-kanban");',
    ].join("\n");
    const sf = parseGuardSource(join(REPO_ROOT, "__synthetic__", "wrapped-site.ts"), source);

    const found: Array<{ prefix: string; perRun: boolean }> = [];
    forEachNode(sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const name = tmpdirChildName(node);
      if (!name) return;
      const head = literalHead(name);
      if (head === null) return;
      found.push({ prefix: head, perRun: PER_RUN_NAME.test(name.getText(sf)) });
    });

    // All three shapes are SEEN — the wrap does not hide the call from the scan.
    expect(found.map((f) => f.prefix)).toEqual(["leaky-", "also-leaky-", "agentic-kanban"]);
    // And the discriminator is still uniqueness per run, not the wrap and not `mkdtemp`:
    // the stable singleton is correctly NOT a leak, wrapped or otherwise.
    expect(found.map((f) => f.perRun)).toEqual([true, true, false]);
    // The prefix the wrapped site would be reported under is genuinely unswept, so it would
    // have been an offender — this is not a shape that passes for an unrelated reason.
    expect(matchedNamespace("leaky-abc")).toBeNull();
  });

  it("the guard bites — it flags an unswept prefix and clears the ak- form beside it", () => {
    // A guard nobody has seen fail is indistinguishable from a no-op, and "flags everything"
    // is as useless as "flags nothing", so prove both directions on the exact two shapes the
    // scan classifies.
    const unswept = ["fleet-listener-", "worker-close-code-", "mid-session-board-", "provision-test-worktree-"];
    for (const p of unswept) expect(matchedNamespace(`${p}abc`), `${p} must NOT be swept`).toBeNull();
    for (const p of unswept) expect(matchedNamespace(`ak-${p}abc`), `ak-${p} must be swept`).not.toBeNull();
  });
});
