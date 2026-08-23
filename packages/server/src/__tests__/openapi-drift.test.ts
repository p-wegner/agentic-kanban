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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/** Run the generator in --check mode; never throws, so the assertion carries the output. */
function runCheck(): { ok: boolean; output: string } {
  try {
    const out = execFileSync(
      process.execPath,
      [TSX_CLI, GENERATOR, "--check"],
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
    // A gate nobody has seen fail is indistinguishable from a no-op, so prove it bites:
    // perturb the committed spec (one line), assert --check reports OUT OF DATE, restore.
    // The restore is in a `finally`, so even a crashed assertion cannot leave the working
    // tree dirty — which matters because several agents share this checkout.
    const original = readFileSync(SPEC, "utf8");
    try {
      writeFileSync(SPEC, original.replace(/^  version: .*$/m, "  version: 0.0.0-drifted"), "utf8");
      const { ok, output } = runCheck();
      expect(ok, "the drift gate PASSED against a spec we deliberately broke — it is a no-op").toBe(false);
      expect(output).toMatch(/OUT OF DATE/);
      expect(output).toMatch(/pnpm openapi:generate/);
    } finally {
      writeFileSync(SPEC, original, "utf8");
    }
  }, 180_000);
});
