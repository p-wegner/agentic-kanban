// @gate:always-run — spawns tsc over the whole client package and reads its `tsconfig.json` by path; imports nothing it checks (#809).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

/**
 * #809, the client half of #788's hole.
 *
 * `packages/client/tsconfig.json` used to carry `"exclude": ["src/**\u002f*.test.ts",
 * "src/**\u002f*.test.tsx"]`, so `pnpm typecheck` never looked at a single client test. With the
 * exclude gone the package reported **90 errors across 29 files**; 44 of those were real
 * fixture drift and are fixed, leaving 46 in the 10 files listed below.
 *
 * Why those 10 resist, and why the remainder is a DEPENDENCY problem rather than broken code:
 * every one of them is a node-side guard/ratchet suite that walks the source tree with
 * `node:fs`, and `packages/client` does not depend on `@types/node`. So the errors are
 * `Cannot find module 'node:fs'`, `Cannot find name 'process'`, `import.meta.dirname`, and the
 * implicit `any`s that follow from those modules having no types — not one of them is a wrong
 * call site. Adding `@types/node` to the client package would clear all 46 at once, but that is
 * a dependency + lockfile change rather than a test fix, so it is filed separately (#818) and
 * the 10 files are grandfathered here in the meantime.
 *
 * This file lives in `packages/shared/__tests__` and not in the client's own, for the reason
 * it is guarding: a ratchet that spawns tsc needs `node:child_process`, and inside the client
 * program that import does not typecheck — it would have to grandfather ITSELF, growing the
 * very list it exists to shrink. `packages/shared` has `@types/node`, so the guard compiles
 * where it is honest to compile it.
 *
 * Two halves, both necessary (#691), copied from `server-test-typecheck-ratchet.test.ts`:
 *  - **may only shrink** — the list can never grow, so a newly-broken test cannot be silenced
 *    by parking it here.
 *  - **no stale entries** — every listed file must STILL fail `tsc`. A file fixed but left in
 *    the list is what turns a ratchet into decoration.
 *
 * To shrink it: fix the file's type errors (or land #818), delete its line from the client
 * `tsconfig.json`'s `exclude`, and lower `BASELINE_GRANDFATHERED_FILES` to match.
 */

const BASELINE_GRANDFATHERED_FILES = 10;

const clientRoot = path.join(import.meta.dirname!, "..", "..", "client");
const tsconfigPath = path.join(clientRoot, "tsconfig.json");

function readGrandfathered(): string[] {
  const raw = JSON.parse(fs.readFileSync(tsconfigPath, "utf8")) as { exclude?: string[] };
  return raw.exclude ?? [];
}

/** The set of files `tsc` reports at least one error in, with tests fully included. */
function filesWithTypeErrors(): Set<string> {
  const require_ = createRequire(import.meta.url);
  const tsc = require_.resolve("typescript/lib/tsc.js");
  const res = spawnSync(process.execPath, [tsc, "-p", "tsconfig.typecheck-all.json", "--pretty", "false"], {
    cwd: clientRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const files = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S[^(]*)\(\d+,\d+\): error TS\d+:/.exec(line);
    if (m) files.add(m[1].replace(/\\/g, "/"));
  }
  return files;
}

describe("client test typecheck ratchet (#809)", () => {
  it("grandfathers only real test files, and the list may only shrink", () => {
    const grandfathered = readGrandfathered();

    const missing = grandfathered.filter((rel) => !fs.existsSync(path.join(clientRoot, rel)));
    expect(
      missing,
      `packages/client/tsconfig.json excludes files that no longer exist. Delete these lines:\n${missing.join("\n")}`,
    ).toEqual([]);

    const strays = grandfathered.filter((rel) => !/\.test\.tsx?$/.test(rel));
    expect(
      strays,
      `Only client TEST files may be grandfathered out of typechecking, never production code:\n${strays.join("\n")}`,
    ).toEqual([]);

    expect(
      grandfathered.length,
      `The client typecheck exclude list grew to ${grandfathered.length} (baseline ${BASELINE_GRANDFATHERED_FILES}). ` +
        "It is shrink-only: fix the file's type errors instead of parking it here.",
    ).toBeLessThanOrEqual(BASELINE_GRANDFATHERED_FILES);
  });

  it(
    "has no stale entry — every grandfathered file still fails tsc",
    { timeout: 300_000 },
    () => {
      const grandfathered = readGrandfathered();
      const failing = filesWithTypeErrors();

      const stale = grandfathered.filter((rel) => !failing.has(rel));
      expect(
        stale,
        `These files typecheck clean now. Remove them from packages/client/tsconfig.json's "exclude" ` +
          `and lower BASELINE_GRANDFATHERED_FILES to ${grandfathered.length - stale.length}:\n${stale.join("\n")}`,
      ).toEqual([]);
    },
  );
});
