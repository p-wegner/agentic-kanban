// @gate:always-run — walks the whole tracked tree and shells out to `git check-attr`;
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
// that keeps it true: a shebang file whose checkout eol is not pinned to `lf` is one
// `import` away from reopening the same outage, so the rule is checked rather than
// remembered. Assert on the ATTRIBUTE, not on the bytes currently on disk — the bytes are
// correct in main by accident, which is exactly the accident that hid the bug.

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

/** Every tracked path whose on-disk content begins with `#!`. */
function trackedShebangFiles(): string[] {
  const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const hits: string[] = [];
  for (const rel of tracked) {
    let head: Buffer;
    try {
      head = readFileSync(join(REPO_ROOT, rel));
    } catch {
      continue; // a path in the index but not on disk (sparse checkout, mid-rebase)
    }
    if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) hits.push(rel);
  }
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

describe("shebang files are pinned to LF on checkout (#703)", () => {
  it("every tracked shebang file has eol=lf, so a CRLF checkout cannot break its transform", () => {
    const shebangFiles = trackedShebangFiles();
    // A repo with no shebang files at all would make this test vacuously green; it has ~13.
    expect(shebangFiles.length).toBeGreaterThan(0);

    const attrs = eolAttrs(shebangFiles);
    const unpinned = shebangFiles.filter((p) => attrs.get(p) !== "lf");

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
  });
});
