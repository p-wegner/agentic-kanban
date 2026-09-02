// @gate:always-run — scans the whole tracked tree and shells out to `git check-attr`;
// it imports nothing it checks, so `vitest related` is blind to it (#583).
//
// Guard for #703. A tracked file that starts with `#!` and is ALSO imported by test code
// gets transformed by vitest, and the transform's shebang strip does not match a CRLF
// `#!/usr/bin/env node\r\n`. The `#!` then survives into the wrapped module and the file
// dies with `SyntaxError: Invalid or unexpected token`, which vitest surfaces only as
// `no tests` — no line number, no frame, nothing naming the real file.
//
// What made #703 cost a whole session is that it was INVISIBLE in the main checkout:
// `scripts/ensure-shared-fresh.mjs` happened to sit there as LF, while every fresh clone
// and every board worktree receives CRLF from `core.autocrlf=true`. The suite that imports
// it is `@gate:always-run`, so the pre-merge gate failed on EVERY branch — no workspace
// could merge — while `pnpm test:mine` in main stayed green and denied the whole thing.
//
// The fix is the `scripts/** text eol=lf` pin in `.gitattributes`. This guard is the half
// that keeps it true.
//
// It asserts TWO things, because #716 showed that either one alone lies:
//
//  1. THE ATTRIBUTE. Every tracked shebang file must be pinned `eol=lf`, so a *future*
//     clone or worktree receives it as LF. This is the forward-looking half.
//
//  2. THE BYTES. No tracked shebang file may hold CRLF in the working tree right now.
//     This is the half #703 was actually about, and the half it was missing: an attribute
//     is applied at checkout, so adding a pin does NOTHING to a checkout that already
//     exists. The decisive evidence is `.claude/skills/** text eol=lf`, in place since
//     #217, whose files were still CRLF on disk when #716 was filed — as was
//     `scripts/board-monitor/loop.sh`, the Conductor loop, under the #703 pin itself.
//     48 tracked shebang files were CRLF while the attribute assertion stayed green.
//
// Note the asymmetry when this one fails: the repair is usually NOT a commit. The index
// holds LF already (git normalized on the way in), so `git add --renormalize` finds nothing
// to stage — the stale bytes live only in the working tree, and the fix is to rewrite them
// in place or re-checkout the paths. See REPAIR below.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

type ShebangFile = { path: string; hasCrlf: boolean };

/**
 * Tracked paths that MIGHT begin with `#!` — a superset, narrowed by the caller (#994).
 *
 * The obvious implementation is `git ls-files` plus a `readFileSync` per entry, and that is
 * what this was. It reads all 3704 tracked files, twice (once per assertion below). Warm that
 * costs ~1 s; cold it measured 61 s single-threaded and 202 s under load — past vitest's 120 s
 * timeout, which is reported as a FAILURE, i.e. as "a tracked shebang file is not pinned to
 * LF" when nothing is unpinned. `git grep` does the same scan in one process in ~0.5 s.
 *
 * `^#!` matches a line-initial `#!` ANYWHERE in a file, so this over-selects (83 candidates
 * against the 80 real ones here) — deliberately: over-selecting is safe because
 * {@link trackedShebangFiles} still checks the first two bytes itself, whereas under-selecting
 * would silently shrink the guard's subject. `-a` rather than `-I` for the same reason: a file
 * git considers binary is not a file this guard may skip on git's say-so.
 */
function shebangCandidates(): string[] {
  try {
    return git(["grep", "-l", "-a", "-z", "-e", "^#!", "--", "."]).split("\0").filter(Boolean);
  } catch (err) {
    // `git grep` exits 1 with no output when nothing matches. Any OTHER failure must not be
    // mistaken for "this repo has no shebang files" — hence the non-empty assertions below.
    const stdout = (err as { stdout?: string }).stdout;
    if (typeof stdout === "string") return stdout.split("\0").filter(Boolean);
    throw err;
  }
}

/**
 * Every tracked path whose on-disk content begins with `#!`, with its CRLF verdict. Memoised:
 * both assertions below need the same list, and computing it twice doubled the cost for
 * nothing.
 */
let shebangFileCache: ShebangFile[] | null = null;

function trackedShebangFiles(): ShebangFile[] {
  if (shebangFileCache) return shebangFileCache;
  const hits: ShebangFile[] = [];
  for (const rel of shebangCandidates()) {
    let content: Buffer;
    try {
      content = readFileSync(join(REPO_ROOT, rel));
    } catch {
      continue; // a path in the index but not on disk (sparse checkout, mid-rebase)
    }
    if (content.length >= 2 && content[0] === 0x23 && content[1] === 0x21) {
      hits.push({ path: rel, hasCrlf: content.includes("\r\n") });
    }
  }
  shebangFileCache = hits;
  return hits;
}

/** `git check-attr eol` for each path, as `{ path -> "lf" | "crlf" | "unspecified" }`. */
function eolAttrs(paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  // -z keeps paths with spaces/unicode intact; the stream is path\0attr\0value\0 triples.
  const raw = git(["check-attr", "-z", "eol", "--", ...paths]).split("\0");
  for (let i = 0; i + 2 < raw.length; i += 3) out.set(raw[i]!, raw[i + 2]!);
  return out;
}

/**
 * A tree-scanning guard is genuinely long-running, and vitest reports a TIMEOUT as a test
 * FAILURE — for this suite, as "a tracked shebang file is not pinned to LF" (#994). That is
 * indistinguishable from the real thing, which is a merge-blocking condition, so an operator
 * seeing it red has to re-run to learn anything. The scan itself is now ~0.5 s warm; this
 * ceiling exists for the loaded, cold-cache case, where the honest outcome is a slow PASS
 * rather than a fast lie.
 */
const SCAN_TIMEOUT_MS = 300_000;

describe("shebang files are pinned to LF on checkout (#703)", () => {
  it("every tracked shebang file has eol=lf, so a CRLF checkout cannot break its transform", () => {
    const shebangFiles = trackedShebangFiles();
    // A repo with no shebang files at all would make this test vacuously green; it has ~65.
    expect(shebangFiles.length).toBeGreaterThan(0);

    const paths = shebangFiles.map((f) => f.path);
    const attrs = eolAttrs(paths);
    const unpinned = paths.filter((p) => attrs.get(p) !== "lf");

    expect(
      unpinned,
      unpinned.length === 0
        ? ""
        : [
            "These tracked files start with `#!` but their checkout line endings are not pinned to LF.",
            "On Windows (core.autocrlf=true) a fresh clone or board worktree receives them as CRLF.",
            "If any of them is ever imported by test code, vitest's shebang strip misses the CRLF form,",
            "the `#!` survives into the wrapped module, and the suite dies as `SyntaxError:",
            "Invalid or unexpected token` reported only as `no tests` — the #703 outage, in which the",
            "pre-merge gate failed for every branch while the main checkout stayed green.",
            "",
            "Fix: add a `text eol=lf` rule covering them in .gitattributes.",
            "",
            ...unpinned.map((p) => `  ${p} (eol=${attrs.get(p) ?? "unspecified"})`),
          ].join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  // The byte-level half (#716). The attribute above is a promise about the NEXT checkout;
  // this is the only assertion that says anything about the one we are standing in.
  it("no tracked shebang file holds CRLF in the working tree (#716)", () => {
    const shebangFiles = trackedShebangFiles();
    expect(shebangFiles.length).toBeGreaterThan(0);

    const crlf = shebangFiles.filter((f) => f.hasCrlf).map((f) => f.path);

    expect(
      crlf,
      crlf.length === 0
        ? ""
        : [
            "These tracked files start with `#!` and hold CRLF bytes in THIS working tree.",
            "That is the #703 failure mode, live: any test that imports one of them dies as",
            "`SyntaxError: Invalid or unexpected token`, reported only as `no tests`. It also",
            "breaks anything that execs them through a shell (`scripts/board-monitor/loop.sh`",
            "is the Conductor loop) — a CRLF shebang makes the interpreter path unresolvable.",
            "",
            "A `.gitattributes` pin does NOT repair this. Attributes apply at checkout, so a",
            "checkout that predates the pin keeps its CRLF bytes forever — which is how",
            "`.claude/skills/** text eol=lf` (#217) sat beside 20+ CRLF files for months.",
            "",
            "REPAIR (working tree only — the index already holds LF, so there is usually",
            "nothing to commit):",
            "  git add --renormalize -- <paths>   # no-op if the index is already LF",
            "  # then rewrite the bytes, e.g. per path:",
            "  rm <path> && git checkout -- <path>",
            "",
            ...crlf.map((p) => `  ${p}`),
          ].join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);
});
