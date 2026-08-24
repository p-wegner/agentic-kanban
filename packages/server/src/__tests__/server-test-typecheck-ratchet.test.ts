// @gate:always-run — spawns tsc over the whole server package and reads `tsconfig.json`; imports nothing it checks (#788).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

/**
 * #788 — `packages/server/tsconfig.json` used to carry `"exclude": ["src/__tests__"]`, so
 * `pnpm typecheck` (and every `tsc --noEmit` in this package) skipped the largest test suite
 * in the repo. A refactor could change a signature, update the production call sites, go
 * green, and leave every test call site passing the old shape — the exact false-green class
 * of #483/#679/#721/#779, except here it was a config line rather than a heuristic gap.
 *
 * Measured when the hole was opened up: **1047 type errors across 133 server test files**,
 * and zero in production code. Deleting the exclude outright would have made `pnpm typecheck`
 * permanently red, so the exclude was NARROWED to exactly those 133 files — a named,
 * grandfathered set (one of which — `helpers/rm-or-report-holder.ts` — was fixed on the spot,
 * leaving 132). The other ~578 server test files are typechecked from now on.
 *
 * This is the shrink-only ratchet the partial-refactor rule (#691) requires for that
 * remainder. Two halves, both necessary:
 *
 *  - **may only shrink** — the grandfathered list can never grow, so a new test file cannot be
 *    parked in it, and a newly-broken existing test file cannot be silenced by adding it.
 *  - **no stale entries** — every listed file must STILL fail `tsc`. Fixing a file's errors
 *    without removing it from the list is what turns a ratchet into decoration (the
 *    stale-entry half of `wire-dto-single-declaration.test.ts`).
 *
 * Cost: it runs a real `tsc` over the whole package (~30s). That is the price of the stale
 * half — there is no static way to know whether a file still type-errors. It carries the
 * always-run marker because the list it guards is repo state it reaches by path, not by
 * import, so scoped selection could never pick it.
 *
 * To shrink it: fix a file's type errors, then delete its line from `tsconfig.json`'s
 * `exclude` and lower `BASELINE_GRANDFATHERED_FILES` to match. Follow-up: #808.
 *
 * #808 batch 1 (2026-08-23): 61 files fixed, 132 -> 71 grandfathered and 1044 -> 962 errors.
 * The bulk of that batch was one bug class the exclude had been hiding — fixtures writing
 * columns their table does not have (`sessions.createdAt/updatedAt`, `project_statuses.position`
 * and `.updatedAt`, `issues.position`, `workspaces.projectId/worktreePath/mergeCommitSha`,
 * `preferences.createdAt`, `workflow_nodes.updatedAt`), silently dropped on insert. The
 * remaining 71 are dominated by four files and by `await res.json()` returning `unknown`.
 *
 * #835 (2026-08-23): 71 -> 65 grandfathered and 962 -> 898 errors, from ONE declaration.
 * `RepoMergeLock.resultPromise` was `Promise<unknown>` and `PreMergeResolutionOutcome.result`
 * was `Record<string, unknown>`, between them widening `mergeWorkspace`'s inferred return to
 * `unknown` for every caller — 298 of the 962 were TS18046 and 25 TS2571, concentrated in the
 * merge-family suites. Both now name `MergeWorkspaceResult`, the union those five paths
 * actually produce, and the six-file `helpers/merge-result.ts` workaround alias that existed
 * only because the production type was `unknown` is gone.
 */

const BASELINE_GRANDFATHERED_FILES = 6;

const serverRoot = path.join(import.meta.dirname!, "..", "..");
const tsconfigPath = path.join(serverRoot, "tsconfig.json");

function readGrandfathered(): string[] {
  const raw = JSON.parse(fs.readFileSync(tsconfigPath, "utf8")) as { exclude?: string[] };
  return raw.exclude ?? [];
}

/** The set of files `tsc` reports at least one error in, with tests fully included. */
function filesWithTypeErrors(): Set<string> {
  const require_ = createRequire(import.meta.url);
  const tsc = require_.resolve("typescript/lib/tsc.js");
  const res = spawnSync(process.execPath, [tsc, "-p", "tsconfig.typecheck-all.json", "--pretty", "false"], {
    cwd: serverRoot,
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

describe("server test typecheck ratchet (#788)", () => {
  it("grandfathers only real files, and the list may only shrink", () => {
    const grandfathered = readGrandfathered();

    const missing = grandfathered.filter((rel) => !fs.existsSync(path.join(serverRoot, rel)));
    expect(
      missing,
      `tsconfig.json excludes files that no longer exist. Delete these lines:\n${missing.join("\n")}`,
    ).toEqual([]);

    const strays = grandfathered.filter((rel) => !rel.startsWith("src/__tests__/"));
    expect(
      strays,
      `Only server test files may be grandfathered out of typechecking, never production code:\n${strays.join("\n")}`,
    ).toEqual([]);

    expect(
      grandfathered.length,
      `The typecheck exclude list grew to ${grandfathered.length} (baseline ${BASELINE_GRANDFATHERED_FILES}). ` +
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
        `These files typecheck clean now. Remove them from tsconfig.json's "exclude" and lower ` +
          `BASELINE_GRANDFATHERED_FILES to ${grandfathered.length - stale.length}:\n${stale.join("\n")}`,
      ).toEqual([]);
    },
  );
});
