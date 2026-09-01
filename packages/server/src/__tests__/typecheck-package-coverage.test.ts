// @gate:always-run
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * #980 — every workspace package that HAS a tsconfig is typechecked.
 *
 * `pnpm typecheck` used to be five `tsc --noEmit` calls chained with `&&` in `package.json`.
 * It is now `scripts/typecheck.mjs`, which runs them with bounded concurrency and an
 * incremental cache (measured: 54s serial -> 37s cold -> ~10s warm). The list of packages
 * moved with it, and a list in a script is exactly the kind of thing that silently falls
 * behind: a sixth package added later would typecheck nowhere and nothing would say so.
 *
 * This walks `packages/` instead of trusting the list. It is a guard suite — it reads the repo
 * tree rather than its own imports — hence the marker.
 */
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

/**
 * A package with no `tsconfig.json` has nothing for `tsc --noEmit` to read, so it is not a
 * gap. `desktop` is the current instance (a Tauri shell whose Rust half is built elsewhere).
 */
function packagesWithTsconfig(): string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(PACKAGES_DIR, entry.name, "tsconfig.json")))
    .map((entry) => entry.name);
}

describe("#980: the typecheck runner covers every typed package", () => {
  it("names each package that has a tsconfig", () => {
    const script = readFileSync(join(REPO_ROOT, "scripts", "typecheck.mjs"), "utf8");
    // The `dir` field is the unambiguous anchor: `label` and `filter` are both free text
    // (`agentic-kanban` is the server's package NAME), so matching on either would let a
    // typo pass as coverage.
    const missing = packagesWithTsconfig().filter((name) => !script.includes(`packages/${name}`));

    expect(
      missing,
      `scripts/typecheck.mjs does not run these package(s), so nothing typechecks them: ` +
        `${missing.join(", ")}. Add them to PACKAGES there.`,
    ).toEqual([]);
  });

  it("`pnpm typecheck` still points at the runner", () => {
    // A revert to an inline `&&` chain would take the concurrency, the cache AND the duration
    // summary with it while every check above kept passing.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.typecheck).toContain("scripts/typecheck.mjs");
  });
});
