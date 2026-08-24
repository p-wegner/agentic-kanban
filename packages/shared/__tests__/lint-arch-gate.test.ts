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
    // Explicit budget (#680): this spawns dependency-cruiser across four package trees, which is
    // minutes of real work on a loaded box — measured timing out at the 60s config default during
    // a guards-only sweep. A scan of the whole repo cannot be budgeted like a unit test.
  }, 4 * 60_000);

  it("exits NON-ZERO when a route reaches down into persistence", () => {
    // The exact violation shape #602 found red on master, rebuilt in an isolated tree so
    // the live source the parallel arch gates walk is never touched (same hazard the
    // god-module probe hit: a probe file written into real src races the other scanners).
    const root = mkdtempSync(join(tmpdir(), "ak-lint-arch-probe-"));
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

  // #694 — `lint:arch`'s exit code counts only ERROR-severity violations, so the one
  // `severity: "warn"` rule in the set (`startup-bypasses-repositories`, #595)
  // is invisible to
  // the assertion above: deleting that rule fails nothing at all. A rule nothing would miss is
  // not enforcement, so the rule INVENTORY is ratcheted by name here, independent of severity.
  //
  // Names rather than a count, because a count is satisfied by any replacement and would go
  // green on a rename that silently drops coverage.
  const EXPECTED_RULES = [
    "no-circular",
    "shared-is-a-leaf",
    "mcp-no-server-internals",
    "services-not-up-to-routes",
    "repositories-not-up-to-routes",
    "client-no-drizzle-or-schema",
    "routes-not-down-to-persistence",
    "cli-not-down-to-persistence",
    "repositories-are-infra-pure",
    "repositories-not-up-to-services",
    "client-lib-is-leaf",
    "client-hooks-not-up-to-components-or-routes",
    "client-components-not-up-to-routes",
    "services-bypass-repositories",
    "startup-bypasses-repositories",
  ];

  it("no layering rule disappears silently — including the warn-severity one", async () => {
    const config = await import(join(REPO_ROOT, ".dependency-cruiser.cjs"));
    const rules: { name: string; severity?: string }[] =
      (config.default ?? config).forbidden ?? [];
    const present = new Set(rules.map((r) => r.name));
    const missing = EXPECTED_RULES.filter((n) => !present.has(n));
    expect(
      missing,
      "a layering rule was removed or renamed. If that is deliberate, remove it from " +
        "EXPECTED_RULES in the same commit and say why — the point is that dropping a rule is a " +
        "reviewed decision rather than a silent one:" + String.fromCharCode(10) + "  " + missing.join(", "),
    ).toEqual([]);
  });

  it("the warn-severity rule is still declared, though lint:arch cannot fail on it", () => {
    const raw = readFileSync(join(REPO_ROOT, ".dependency-cruiser.cjs"), "utf8");
    // Asserted on the source text as well as the loaded config: this rule's whole risk is that
    // nothing observes it, so both the declaration and the loaded shape are pinned.
    expect(raw).toContain("startup-bypasses-repositories");
    expect(raw).toMatch(/severity:\s*"warn"/);
  });
});
