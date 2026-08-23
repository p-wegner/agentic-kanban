// @gate:always-run — recursively walks every package and scripts/; imports nothing it checks (#828).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * A filesystem path derived from `import.meta.url` must go through `fileURLToPath`
 * (or `import.meta.dirname`/`import.meta.filename`), never through the URL's raw
 * `pathname` (#828).
 *
 * `new URL(import.meta.url).pathname` is a URL path, not a filesystem path, and the two
 * differ on EVERY platform — just in opposite directions:
 *
 *   - Windows: `/C:/projects/repo/x.ts`  — one leading separator too many.
 *   - POSIX:   `/home/runner/repo/x.ts`  — already correct, nothing to strip.
 *
 * Every hand-rolled repair therefore encodes one platform's answer. `.slice(1)` fixes
 * Windows and BREAKS POSIX: it turns an absolute path into a relative one, so the
 * `path.join` downstream hangs it off the process cwd. That is exactly how
 * `shared-lib-single-consumer-ratchet.test.ts` came to scan
 * `.../packages/shared/home/runner/work/.../packages/shared/src/lib` the first time this
 * suite ever ran on Linux, and it had been silently right on Windows for its whole life.
 *
 * Neither does the pathname URL-decode: a checkout under a directory with a space
 * arrives as `%20` and every `existsSync` below it answers false.
 *
 * `fileURLToPath` is the one function that knows both answers. There is no grandfathered
 * set — the population was driven to zero in the same commit as this guard.
 */

const REPO_ROOT = path.resolve(import.meta.dirname!, "../../..");
const SCAN_ROOTS = [path.join(REPO_ROOT, "packages"), path.join(REPO_ROOT, "scripts")];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "target", ".git", ".worktrees"]);

/** `new URL(import.meta.url).pathname` in any spacing, plus the `import.meta.url.slice` shorthand. */
const RAW_PATHNAME = /new\s+URL\(\s*import\.meta\.url\s*\)\s*\.\s*pathname/;

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
    }
  };
  walk(root);
  return out;
}

export function findRawPathnameDerivations(roots: readonly string[] = SCAN_ROOTS): string[] {
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const src = fs.readFileSync(file, "utf-8");
      if (!RAW_PATHNAME.test(src)) continue;
      // The guard describing the rule is allowed to quote it.
      if (path.basename(file) === "module-path-derivation.test.ts") continue;
      offenders.push(path.relative(REPO_ROOT, file).split(path.sep).join("/"));
    }
  }
  return offenders.sort();
}

describe("filesystem paths come from fileURLToPath, not a URL pathname (#828)", () => {
  it("no source file derives a path from new URL(import.meta.url).pathname", () => {
    expect(findRawPathnameDerivations()).toEqual([]);
  });

  it("the scan actually looks at files — a self-check against a silently empty walk", () => {
    const counted = SCAN_ROOTS.reduce((n, root) => n + sourceFiles(root).length, 0);
    expect(counted).toBeGreaterThan(500);
  });
});
