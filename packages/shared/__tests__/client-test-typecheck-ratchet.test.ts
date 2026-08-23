// @gate:always-run — spawns tsc over the whole client package and reads its `tsconfig.json` by path; imports nothing it checks (#809).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

/**
 * #809, the client half of #788's hole — **now closed, and held at zero (#818).**
 *
 * `packages/client/tsconfig.json` used to carry `"exclude": ["src/**\u002f*.test.ts",
 * "src/**\u002f*.test.tsx"]`, so `pnpm typecheck` never looked at a single client test. With the
 * exclude gone the package reported **90 errors across 29 files**; 44 were real fixture drift
 * and were fixed under #809, leaving 46 in 10 files (an 11th arrived with #810) that were
 * grandfathered here.
 *
 * Every one of those 11 was the SAME error, and it was never broken code: they are node-side
 * guard/ratchet suites that walk the source tree with `node:fs`, and `packages/client` did not
 * depend on `@types/node`. So the errors were `Cannot find module 'node:fs'`, `Cannot find name
 * 'process'`, `import.meta.dirname`, and the implicit `any`s that follow — not one a wrong call
 * site. #818 added the dev dependency; all 46 cleared at once, the exclude list went to `[]`,
 * and the baseline below to 0.
 *
 * **The list is empty and this file stays**, because the two halves now assert different and
 * still-live things:
 *  - **may only shrink** — with a baseline of 0 that is an outright ban. Adding ANY exclusion
 *    fails here, which is precisely the regression #810 introduced (it parked a new node-side
 *    guard suite rather than fixing the dependency) and the reason this ticket became urgent.
 *  - **no type errors at all** — the second test used to check the grandfathered files STILL
 *    failed, so an empty list would make it vacuous while still paying for a full `tsc` spawn.
 *    It now asserts the stronger property the empty list is supposed to mean: the client
 *    program, tests included, typechecks clean. Same cost, real assertion.
 *
 * `tsconfig.typecheck-all.json` is kept even though it is currently identical to
 * `tsconfig.json`: if someone does re-add an exclusion, it is what lets the second test still
 * SEE the errors, so both halves go red together with a usable message instead of only the first.
 *
 * This file lives in `packages/shared/__tests__` and not in the client's own, for the reason it
 * is guarding: a ratchet that spawns tsc needs `node:child_process`. That is no longer a
 * typecheck problem now that the client has `@types/node`, but it remains the honest home — a
 * guard over the client's tsconfig should not be a file the client's tsconfig governs.
 *
 * The companion guard is `packages/client/src/__tests__/client-conventions-guard.test.ts`,
 * which forbids `node:*`/`process`/`__dirname` in browser-side source. It is the OTHER half of
 * #818: `@types/node` is visible to the whole client program, so without it this ratchet would
 * have traded a false red for a false green — shipping code could reference `process.env` and
 * typecheck happily, then explode in the browser.
 */

const BASELINE_GRANDFATHERED_FILES = 0;

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
    "the client program — tests included — has no type errors",
    { timeout: 300_000 },
    () => {
      const failing = [...filesWithTypeErrors()].sort();
      expect(
        failing,
        "The client package no longer typechecks with its tests included. Fix the errors — " +
          "do NOT add the file to packages/client/tsconfig.json's \"exclude\", which the " +
          "shrink-only check above now bans outright (baseline 0):\n" +
          failing.join("\n"),
      ).toEqual([]);
    },
  );
});
