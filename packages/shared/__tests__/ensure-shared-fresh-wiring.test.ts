// @gate:always-run — reads the repo-root package.json, which it does not import (#583).
//
// Guard for #865/#582. `scripts/ensure-shared-fresh.mjs` rebuilds a stale
// `packages/shared/dist` before it can produce a plausible-looking
// `ERR_MODULE_NOT_FOUND` from deep inside `packages/server` (e.g.
// `db-client.js` imported from `pragmas.ts`) — an error that reads as a
// broken checkout, not a stale build, and that hits every `pnpm cli` verb
// including `worker instructions`/`worker doctor`, exactly what a first-time
// fleet-worker operator reaches for with the least context to diagnose it.
//
// The fix already landed once (#582) as a `&&`-prefix on the `cli` and
// `typecheck` npm scripts. Nothing pinned that wiring, so a future script
// cleanup (or a `cli` rename) could drop the prefix silently — this test is
// that pin.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

function readPackageJsonScripts(): Record<string, string> {
  const raw = readFileSync(join(REPO_ROOT, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
  return parsed.scripts ?? {};
}

describe("pnpm cli guards against a stale packages/shared/dist (#865)", () => {
  it("the `cli` script runs ensure-shared-fresh.mjs before invoking the CLI entrypoint", () => {
    const scripts = readPackageJsonScripts();
    const cliScript = scripts.cli;
    expect(cliScript, "package.json has no `cli` script").toBeDefined();
    expect(
      cliScript,
      "`pnpm cli` must run `node scripts/ensure-shared-fresh.mjs` before the CLI entrypoint, " +
        "so a stale packages/shared/dist is rebuilt instead of failing every verb " +
        "(including `worker instructions`/`worker doctor`) with an unhelpful ERR_MODULE_NOT_FOUND",
    ).toMatch(/node scripts\/ensure-shared-fresh\.mjs\s*&&/);
  });

  it("the `typecheck` script also runs ensure-shared-fresh.mjs first (#582)", () => {
    // #991: this matched `node scripts/ensure-shared-fresh.mjs &&`, which pinned the SHAPE of
    // the script (an `&&` chain led by the check) rather than the property (#582 protection is
    // reachable). #980 replaced the chain with `node scripts/typecheck.mjs` and moved the call
    // INSIDE the runner — verified at typecheck.mjs:98, and confirmed by touching
    // packages/shared/src and watching the rebuild fire — so the guard went red while what it
    // guards was intact.
    //
    // Assert the property instead: the check runs, in the script or in the runner the script
    // invokes. Still non-vacuous — no runner match leaves `runnerSource` empty, and a script
    // that dropped the check entirely fails on both halves.
    const scripts = readPackageJsonScripts();
    const typecheckScript = scripts.typecheck;
    expect(typecheckScript, "package.json has no `typecheck` script").toBeDefined();
    const runner = typecheckScript.match(/scripts\/([\w.-]+\.mjs)/);
    const runnerSource = runner ? readFileSync(join(REPO_ROOT, "scripts", runner[1]), "utf8") : "";
    expect(
      typecheckScript.includes("ensure-shared-fresh.mjs") || runnerSource.includes("ensure-shared-fresh.mjs"),
      `\`pnpm typecheck\` (${typecheckScript}) must run the shared-dist freshness check (#582), `
        + "directly or via the runner it invokes — otherwise tsc reads last build's .d.ts and "
        + "reports a plausible, specific error in innocent consuming code",
    ).toBe(true);
  });

  it("the `typecheck:serial` bisect path keeps the check inline (#980)", () => {
    // The serial chain has no runner to hide the check in, and its whole purpose is to be the
    // trustworthy comparison when you suspect a concurrency artifact — comparing a fresh run
    // against a stale one would defeat it.
    const scripts = readPackageJsonScripts();
    expect(scripts["typecheck:serial"], "package.json has no `typecheck:serial` script").toBeDefined();
    expect(scripts["typecheck:serial"]).toMatch(/node scripts\/ensure-shared-fresh\.mjs\s*&&/);
  });
});
