// @gate:always-run
//
// `packages/server/openapi.yaml` is GENERATED from the route sources by
// `scripts/generate-openapi.ts`. Nothing in its own import graph links a route change to
// that artifact, so `vitest related` scoping would drop this suite exactly when a route
// changed — hence the marker. This suite spawns the generator's `--check` mode, which
// reaches the whole `src/routes` tree.
//
// #780: before this existed, the spec had not been regenerated since the commit that
// created it (2026-06-24) while 33 commits changed 33 distinct DTO files. Regenerating
// added 61 paths and 68 operations and changed 74 existing ones. A generated artifact
// nobody regenerates and nobody diffs is not a contract — it is a stale snapshot that
// reads like one, and #730 cited it as evidence the client<->server seam was covered.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SERVER_ROOT = join(REPO_ROOT, "packages/server");
const GENERATOR = join(SERVER_ROOT, "scripts/generate-openapi.ts");
const SPEC = join(SERVER_ROOT, "openapi.yaml");

// pnpm does not hoist `tsx` to the root node_modules, so resolve its CLI entry from the
// server package (where it is a devDependency) rather than guessing a path.
// (`tsx/dist/cli.mjs` is not in tsx's exports map, so resolve the package root instead.)
const TSX_CLI = join(
  dirname(createRequire(join(SERVER_ROOT, "package.json")).resolve("tsx/package.json")),
  "dist/cli.mjs",
);

/**
 * Run the generator in --check mode; never throws, so the assertion carries the output.
 * `specPath` selects WHICH spec is compared against — the committed one by default, a
 * throwaway copy for the negative control (#814).
 */
function runCheck(specPath?: string): { ok: boolean; output: string } {
  const args = [TSX_CLI, GENERATOR, "--check", ...(specPath ? ["--spec", specPath] : [])];
  try {
    const out = execFileSync(
      process.execPath,
      args,
      { cwd: SERVER_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}${e.stdout || e.stderr ? "" : (e.message ?? "")}` };
  }
}

describe("openapi.yaml drift gate (#780)", () => {
  it("the generator and its --check mode are both present", () => {
    expect(existsSync(GENERATOR)).toBe(true);
    expect(existsSync(SPEC)).toBe(true);
  });

  it("openapi.yaml matches what the route sources generate — run `pnpm openapi:generate` if this fails", () => {
    const { ok, output } = runCheck();
    expect(ok, `openapi.yaml is out of date with packages/server/src/routes:\n${output}`).toBe(true);
    expect(output).toMatch(/is up to date/);
  }, 180_000);

  it("--check actually FAILS on a stale spec (the gate is proven, not assumed)", () => {
    // A gate nobody has seen fail is indistinguishable from a no-op, so prove it bites.
    //
    // #814/#680: this used to perturb the COMMITTED spec and restore it in a `finally`, and
    // the restore did not always happen — the checkout was found holding `version:
    // 0.0.0-drifted`. A `finally` is not a guarantee: a killed worker, a suite-level timeout
    // or a crashed vitest pool never runs it, and this checkout is shared, where any dirty
    // tracked file withholds every auto-merge board-wide. So the perturbation now happens on
    // a THROWAWAY COPY in os.tmpdir(); the real file is never opened for writing at all, which
    // is a property of the code rather than a promise about control flow.
    const original = readFileSync(SPEC, "utf8");
    const dir = mkdtempSync(join(tmpdir(), "ak-openapi-drift-"));
    try {
      const copy = join(dir, "openapi.yaml");
      writeFileSync(copy, original.replace(/^  version: .*$/m, "  version: 0.0.0-drifted"), "utf8");
      const { ok, output } = runCheck(copy);
      expect(ok, "the drift gate PASSED against a spec we deliberately broke — it is a no-op").toBe(false);
      expect(output).toMatch(/OUT OF DATE/);
      expect(output).toMatch(/pnpm openapi:generate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Belt and braces: a future edit that reaches for the real path again fails HERE rather
    // than silently leaking into the working tree the way #814 did.
    expect(readFileSync(SPEC, "utf8")).toBe(original);
  }, 180_000);
});
