/**
 * The board boots from its BUILT artifact (#1012).
 *
 * `docs/proposals/2026-09-03-dev-board-vs-deployed-board.md` §3.A assumes a stable board runs
 * as `pnpm build` + `pnpm start` — `packages/server/dist`, no `tsx watch`. Two directories
 * resolve by a completely different path there than in a dev run, and both work for the wrong
 * reason under `tsx`: the drizzle MIGRATIONS (dev: `packages/shared/drizzle`; built:
 * `packages/server/dist/migrations`) and the BUNDLED SKILLS directory `packages/server/skills`,
 * which `findBundledSkillsDir()` locates by walking up from the RUNNING module. The npm publish
 * pipeline claims both; nothing proved either.
 *
 * The work is in `scripts/boot-dist-smoke.mjs` (a throwaway `git worktree`, because
 * `scripts/build-server.mjs` wipes `packages/server/dist` unconditionally and must not be
 * pointed at a live checkout). This suite is the vitest door onto it — see that script's header
 * for what it does and what it deliberately does not prove.
 *
 * ## NOT `@gate:always-run` — opt-in, and off by default
 *
 * Measured at **18.6 s** on an idle box, so it clears the ~60 s bar the ticket set. It is still
 * not a per-gate guard, for two reasons the wall clock does not show:
 *
 *  - it MUTATES THE SHARED REPO — `git worktree add` / `worktree prune` on the common `.git`.
 *    Several merge gates run concurrently on this machine; a guard suite that writes to the
 *    worktree registry from every one of them is a contention source, not a cheap check.
 *  - it BOOTS A REAL SERVER on a real port and runs esbuild. That is precisely the shape of the
 *    #173 contention flakes (`worker-git-transport-e2e`, `cli.test.ts`) that had to be excluded
 *    from `test:mine` after they turned merge gates red under load.
 *
 * So it is the nightly sweep's job, and it self-skips unless `KANBAN_BOOT_DIST_SMOKE=1` — which
 * costs `test:mine` and the full suite a collected-but-skipped file rather than an entry in the
 * exclusion list (that list is a ratcheted budget for FLAKES, and this is not one). Run it with:
 *
 *   pnpm smoke:boot-dist              # the script directly
 *   KANBAN_BOOT_DIST_SMOKE=1 pnpm --filter agentic-kanban exec vitest run src/__tests__/boot-from-dist-smoke.test.ts
 *
 * Promoting it to `@gate:always-run` is a one-line change (add the marker, drop the env guard)
 * once someone has measured what a concurrent gate does to it.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SMOKE_SCRIPT = resolve(REPO_ROOT, "scripts/boot-dist-smoke.mjs");
const ENABLED = process.env.KANBAN_BOOT_DIST_SMOKE === "1";

interface SmokeCheck { name: string; ok: boolean; detail: string }
interface SmokeResult { ok: boolean; mode: string; checks: SmokeCheck[] }

function runSmoke(extraArgs: string[]): { result: SmokeResult | null; status: number | null; output: string } {
  const res = spawnSync(process.execPath, [SMOKE_SCRIPT, "--json", ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
    // The script boots a server, so give it more than the build's worth of headroom.
    timeout: 9 * 60 * 1000,
  });
  const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  // The result is the last JSON line; anything the build printed comes before it.
  const jsonLine = (res.stdout ?? "").trim().split(/\r?\n/).filter(l => l.startsWith("{")).pop();
  return { result: jsonLine ? (JSON.parse(jsonLine) as SmokeResult) : null, status: res.status, output };
}

describe.skipIf(!ENABLED)("boot from the built artifact", () => {
  it("builds in a throwaway worktree and boots dist with migrations and bundled skills resolved", () => {
    const { result, status, output } = runSmoke([]);
    expect(result, `no JSON result from ${SMOKE_SCRIPT}:\n${output}`).not.toBeNull();
    expect(
      result!.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`),
      "checks that failed booting the built artifact",
    ).toEqual([]);
    expect(status).toBe(0);
  }, 10 * 60 * 1000);

  it("fails, naming the directory, when the bundled skills directory is missing", () => {
    const { result, status } = runSmoke(["--break-skills"]);
    expect(result).not.toBeNull();
    const skills = result!.checks.find(c => c.name === "built CLI resolves the bundled skills directory");
    // The point of the fault injection: it FAILS, and the failure says which directory was
    // looked for — a bare "no bundled skills" would leave an operator nowhere.
    expect(skills?.ok).toBe(false);
    expect(skills?.detail).toContain(join("packages", "server", "skills"));
    // Everything else still passes, so the run proves the injection is what broke it.
    expect(result!.checks.filter(c => c !== skills && !c.ok)).toEqual([]);
    expect(status).toBe(0); // the script inverts its own verdict under --break-skills
  }, 10 * 60 * 1000);
});
