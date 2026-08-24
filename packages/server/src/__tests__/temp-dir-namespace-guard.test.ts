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
 * Deliberately regex over source TEXT, not the TS AST: the repo's scanners parse with
 * `setParentNodes: false`, which makes `node.parent`, `node.getText()` and
 * `node.getSourceFile()` unusable, and the thing being checked here is a string literal in a
 * call — no type information would make the answer better.
 *
 * Two shapes are checked, and the second is why this is not just a grep:
 *
 *  1. A direct site: `mkdtempSync(join(tmpdir(), "some-prefix-"))`.
 *  2. A HELPER site: a suite that writes `makeTempDir("some-prefix-")`, where `makeTempDir`
 *     is a local function ending in `mkdtempSync(join(tmpdir(), prefix))`. Those account for
 *     38 of the offenders and a literal-only scan is blind to every one of them. The helper
 *     names are DERIVED (any function whose body mints a temp dir from a parameter), not
 *     hand-listed, so a newly written helper is covered without editing this file.
 *
 * Escape hatch: `// TEMP-PREFIX OK: <reason>` on the offending line or the line above. It has
 * a staleness half — a marker that no longer sits at a temp-prefix site FAILS, so an
 * exemption cannot outlive the code it was written for.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { matchedNamespace } from "./helpers/reap-fixture-child-servers.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SCAN_ROOTS = ["packages", "scripts", "test-setup"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "test-results", "playwright-report", "drizzle"]);
const SOURCE_EXT = /\.(ts|tsx|mjs|cjs|js)$/;

const OK_MARKER = "TEMP-PREFIX OK:";

/**
 * Files whose offending sites this ticket could NOT rename, with the reason. Shrink-only:
 * remove an entry when it is fixed, never add one to make a new offender pass — and the
 * staleness assertion below fails if an entry no longer offends, so a stale entry cannot sit
 * here looking like ongoing debt.
 */
const KNOWN_UNSWEPT: Record<string, string> = {
  // Empty, and that is the intended resting state: #839's one grandfathered entry
  // (`test-tree-write-hermeticity.test.ts`, a concurrent-edit boundary at the time) was
  // renamed in #840 and its entry DELETED rather than zeroed, per the shrink-only rule above.
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

/** `join(tmpdir(), <arg>)` / `resolve(tmpdir(), <arg>)` — the argument is captured raw. */
const TMPDIR_CHILD = /(?:join|resolve)\s*\(\s*(?:os\.)?tmpdir\(\)\s*,\s*([^)]*)\)/g;
/** The literal head of the argument: `"lit"`, `'lit'`, or the leading chunk of `` `lit${x}` ``. */
const LITERAL_HEAD = /^["'](.*)["']$|^`([^`${]*)/;
const IDENTIFIER = /^[A-Za-z_$][\w$.]*$/;
/** A line of PROSE about the shape is not the shape — see the note at pass 1. */
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*)/;

function enclosingFunctionName(lines: string[], atIndex: number): string | null {
  for (let i = atIndex; i >= 0 && i > atIndex - 30; i--) {
    const named = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]!)
      ?? /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/.exec(lines[i]!);
    if (named) return named[1]!;
  }
  return null;
}

function hasOkMarker(lines: string[], lineIndex: number): boolean {
  return (lines[lineIndex] ?? "").includes(OK_MARKER) || (lines[lineIndex - 1] ?? "").includes(OK_MARKER);
}

interface ScanResult {
  sites: Site[];
  exempted: Array<{ file: string; line: number }>;
  helperNames: string[];
}

function scan(): ScanResult {
  const files = sourceFiles();
  const contents = new Map<string, string[]>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!src.includes("tmpdir()") && !src.includes("TEMP-PREFIX OK")) continue;
    contents.set(f, src.split(/\r?\n/));
  }

  const sites: Site[] = [];
  const exempted: Array<{ file: string; line: number }> = [];
  const helperNames = new Set<string>();

  const record = (file: string, lines: string[], i: number, prefix: string, shape: string): void => {
    if (hasOkMarker(lines, i)) {
      exempted.push({ file, line: i + 1 });
      return;
    }
    sites.push({ file, line: i + 1, prefix, shape });
  };

  // Pass 1 — direct `mkdtemp*(join(tmpdir(), …))` sites, and the helpers that take a prefix.
  for (const [f, lines] of contents) {
    const rel = relative(REPO_ROOT, f).replace(/\\/g, "/");
    lines.forEach((line, i) => {
      if (!line.includes("mkdtemp")) return;
      // A line of PROSE about the shape is not the shape: this file's own header, the one on
      // `shared/lib/temp-dir.ts`, and several suite docblocks all quote
      // `mkdtempSync(join(tmpdir(), "prefix-"))` as an example. Flagging those would train
      // everyone to ignore the guard, which is the one failure it cannot survive.
      if (COMMENT_LINE.test(line)) return;
      TMPDIR_CHILD.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TMPDIR_CHILD.exec(line))) {
        const arg = m[1]!.trim();
        const lit = LITERAL_HEAD.exec(arg);
        const head = lit ? (lit[1] ?? lit[2] ?? "") : null;
        if (head) {
          record(rel, lines, i, head, "mkdtemp");
        } else if (head === "" || IDENTIFIER.test(arg)) {
          // The argument is a bare identifier, or a template whose first character is already
          // an interpolation (`makeTempRepo`'s label form). Either way the NAME is decided by
          // the caller, so the enclosing function is a prefix-taking helper and pass 2 checks
          // its call sites instead of guessing here.
          const fn = enclosingFunctionName(lines, i);
          if (fn) helperNames.add(fn);
        }
      }
    });
  }

  // Pass 2 — call sites of those helpers, whose literal first argument IS the prefix.
  const names = [...helperNames];
  if (names.length) {
    const callRe = new RegExp("\\b(?:" + names.join("|") + ")\\s*\\(\\s*([`\"'])([^`\"'${]*)\\1", "g");
    for (const [f, lines] of contents) {
      const rel = relative(REPO_ROOT, f).replace(/\\/g, "/");
      lines.forEach((line, i) => {
        if (COMMENT_LINE.test(line)) return; // prose about the shape, not the shape
        callRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = callRe.exec(line))) record(rel, lines, i, m[2]!, "helper-call");
      });
    }
  }

  return { sites, exempted, helperNames: names };
}

const result = scan();

describe("every fixture temp dir is minted in a swept namespace (#839)", () => {
  it("finds the temp-dir call sites at all — a scan that matches nothing proves nothing", () => {
    // The whole guard is a no-op if the regexes stop matching (a refactor to a different
    // helper shape, a rename of `tmpdir()`), and a silent no-op reads exactly like a pass.
    expect(result.sites.length + result.exempted.length).toBeGreaterThan(200);
    expect(result.helperNames.length).toBeGreaterThan(0);
  });

  it("no temp dir is minted outside the reaper's swept namespace", () => {
    const offenders = result.sites
      .filter((s) => matchedNamespace(`${s.prefix}x`) === null)
      .filter((s) => !(s.file in KNOWN_UNSWEPT))
      .map((s) => `${s.file}:${s.line} -> ${JSON.stringify(s.prefix)} [${s.shape}]`);
    expect(
      offenders,
      "These temp dirs are in NO namespace the reaper sweeps, so the first teardown that " +
        "fails for any reason leaks them permanently — which is how 8,448 of them " +
        "accumulated (#364) while a working sweep was already in place.\n\n" +
        'Prefix the name with `ak-` (e.g. `mkdtempSync(join(tmpdir(), "ak-my-fixture-"))`). ' +
        "If the literal is deliberately NOT a real temp prefix (a negative test, a path that " +
        `is never created), put \`// ${OK_MARKER} <reason>\` on the line or the line above.`,
    ).toEqual([]);
  });

  it("a grandfathered file still offends — an entry that does not is deleted, not kept", () => {
    // The staleness half. Without it a fixed file sits in the list forever, and the list stops
    // describing anything: the next reader cannot tell debt from decoration.
    for (const [file, reason] of Object.entries(KNOWN_UNSWEPT)) {
      const stillOffends = result.sites.some((s) => s.file === file && matchedNamespace(`${s.prefix}x`) === null);
      expect(
        stillOffends,
        `${file} is grandfathered ("${reason}") but no longer mints an unswept temp dir — ` +
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
        // The marker covers its own line and the one below it.
        if (claimed.has(`${rel}:${i + 1}`) || claimed.has(`${rel}:${i + 2}`)) return;
        orphans.push(`${rel}:${i + 1} -> ${line.trim().slice(0, 120)}`);
      });
    }
    expect(orphans, `A \`${OK_MARKER}\` marker no longer sits at a temp-prefix site — delete it.`).toEqual([]);
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
