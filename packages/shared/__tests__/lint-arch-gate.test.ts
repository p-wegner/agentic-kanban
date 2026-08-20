// @gate:always-run — spawns depcruise over the whole source tree; its subject is not in
// this file's import graph, so scoped test selection must never skip it.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * The dependency-cruiser layering rules are the repo's ONLY machine-checked
 * pattern-language rule set — and #602 found them RED on master (two
 * `*-not-down-to-persistence` errors) with nobody noticing, because nothing in the
 * merge-blocking path ran them for the files they cover. `pnpm check:arch` runs
 * `lint:arch`, but check:arch is not what the pre-merge gate executes per ticket.
 *
 * This is the same idiom as check-god-modules-script.test.ts, and for the same reason:
 * a gate that only exists as a script someone remembers to run is decorative. Carrying
 * the `@gate:always-run` marker puts it in `scripts/test-mine.mjs`'s ALWAYS_RUN set, so
 * a change that introduces a layering violation cannot be merged by a scoped test run
 * that happens not to touch the offending file.
 *
 * Two guarantees, mirroring the god-module gate: green on the current tree, and
 * genuinely RED when a violation appears — otherwise "it passed" means nothing.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function runDepcruise(args: string[], cwd = REPO_ROOT): { code: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [join(REPO_ROOT, "node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs"), ...args],
      { cwd, encoding: "utf8", stdio: "pipe" },
    );
    return { code: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const SOURCE_DIRS = [
  "packages/server/src",
  "packages/shared/src",
  "packages/mcp-server/src",
  "packages/client/src",
];

describe("lint:arch — the merge-blocking layering gate (#602)", () => {
  it("exits 0 on the current source tree", () => {
    const { code, output } = runDepcruise([
      ...SOURCE_DIRS,
      "--config",
      ".dependency-cruiser.cjs",
      "--output-type",
      "err",
    ]);
    expect(code, output).toBe(0);
  });

  it("exits NON-ZERO when a route reaches down into persistence", () => {
    // The exact violation shape #602 found red on master, rebuilt in an isolated tree so
    // the live source the parallel arch gates walk is never touched (same hazard the
    // god-module probe hit: a probe file written into real src races the other scanners).
    const root = mkdtempSync(join(tmpdir(), "lint-arch-probe-"));
    try {
      const routesDir = join(root, "packages", "server", "src", "routes");
      const dbDir = join(root, "packages", "server", "src", "db");
      mkdirSync(routesDir, { recursive: true });
      mkdirSync(dbDir, { recursive: true });
      // A RELATIVE route -> db/index edge. The rule matches on `to.path`
      // (^packages/server/src/db/index), so this fires without node_modules in the temp
      // tree. A bare `@agentic-kanban/shared/schema` import is unresolvable here, so the
      // rule never sees it — the first version of this probe did that and the negative
      // control passed while proving nothing.
      writeFileSync(join(dbDir, "index.ts"), "export const db = {};\n", "utf8");
      writeFileSync(
        join(routesDir, "__probe_route__.ts"),
        'import { db } from "../db/index.js";\nexport const probe = db;\n',
        "utf8",
      );
      // Reuse the real rule set; only the scanned tree is the temp one. The resolution
      // tsconfig has to come along: without it depcruise exits non-zero on TS5083
      // instead of on a rule violation, which would make the exit-code assertion below
      // pass for entirely the wrong reason (it did, until the output assertion caught it).
      for (const f of [".dependency-cruiser.cjs", ".dependency-cruiser.tsconfig.json"]) {
        writeFileSync(join(root, f), readFileSync(join(REPO_ROOT, f), "utf8"), "utf8");
      }

      const { code, output } = runDepcruise(
        ["packages/server/src", "--config", ".dependency-cruiser.cjs", "--output-type", "err"],
        root,
      );
      expect(code, `expected the routes-not-down-to-persistence rule to fire:\n${output}`).not.toBe(0);
      expect(output).toContain("__probe_route__");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
