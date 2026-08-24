// @gate:always-run — spawns `scripts/pack-worker.mjs` and reads its source; nothing here
// is reachable through this package's import graph, so scoped test selection would miss it.
/**
 * `scripts/pack-worker.mjs` is the fast track for handing a worker tarball to a machine
 * that cannot install from the registry. Two real round trips were lost to it (#844, #845),
 * both on a WORKER machine, i.e. exactly where nobody is watching this repo's test run:
 *
 *  - #844: `--blob` — the one flag whose whole purpose is a machine you cannot copy files
 *    to — hardcoded ONE machine's checkout path for the ACP CLI, and died with a raw ENOENT.
 *  - #845: packaging a WORKER ran the full `pnpm build`, so a client-only breakage (a corrupt
 *    rollup binary in the reporter's pnpm store) blocked pairing the machine entirely.
 *
 * The build path itself is far too slow to exercise here, so this suite covers the two
 * things that actually regressed: the ACP resolution (behaviourally, both directions) and
 * the shape of the build step list (statically).
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const script = join(repoRoot, "scripts", "pack-worker.mjs");
const source = readFileSync(script, "utf8");

/** Runs the script and returns its exit code plus both streams (never throws). */
function runScript(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; scriptPath?: string } = {},
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [opts.scriptPath ?? script, ...args], {
      cwd: opts.cwd ?? repoRoot,
      encoding: "utf8",
      env: opts.env ? (opts.env as NodeJS.ProcessEnv) : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("pack-worker.mjs — ACP CLI resolution (#844)", () => {
  it("resolves an ACP CLI given in ACP_CLI and reports where it came from", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-pack-worker-acp-"));
    const cli = join(dir, "acp.js");
    writeFileSync(cli, "// stand-in for the real acp CLI\n");

    const res = runScript(["--print-acp"], { env: { ...process.env, ACP_CLI: cli } });

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("(ACP_CLI)");
    expect(res.stdout).toContain(cli);
  });

  it("names ACP_CLI when it is set but points at nothing (not a raw ENOENT)", () => {
    const missing = join(tmpdir(), "definitely-not-here", "acp.js");

    const res = runScript(["--print-acp"], { env: { ...process.env, ACP_CLI: missing } });

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("ACP_CLI");
    expect(res.stderr).toContain(missing);
    expect(res.stderr).not.toContain("ENOENT");
  });

  it("names ACP_CLI when nothing can be discovered on the machine either", () => {
    // A tree with no `acp` sibling, an empty home (no agent profile skill dirs), and a PATH
    // holding only the node binary — the state of a fresh worker machine.
    const sandbox = mkdtempSync(join(tmpdir(), "ak-pack-worker-sandbox-"));
    const fakeHome = join(sandbox, "home");
    mkdirSync(join(sandbox, "scripts"), { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    copyFileSync(script, join(sandbox, "scripts", "pack-worker.mjs"));

    const res = runScript(["--print-acp"], {
      cwd: sandbox,
      scriptPath: join(sandbox, "scripts", "pack-worker.mjs"),
      env: { PATH: dirname(process.execPath), USERPROFILE: fakeHome, HOME: fakeHome },
    });

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("ACP_CLI");
    // The message must say where it looked, or it is unactionable on the machine that hit it.
    expect(res.stderr).toContain("Looked on PATH");
  });

  it("holds no hardcoded absolute machine path (the #844 defect itself)", () => {
    // A drive-letter or /home/<user> literal in this script is one machine's layout.
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    const absolute = codeOnly.match(/"[A-Za-z]:[\\/][^"]*"|"\/(?:home|Users)\/[^"]*"/g) ?? [];
    expect(absolute).toEqual([]);
  });
});

describe("pack-worker.mjs — the default build skips the React client (#845)", () => {
  it("lists build:client only under --with-client", () => {
    // The worker daemon is dist/worker.js; it never loads the UI. A client-only failure
    // must not be able to block packaging a worker.
    expect(source).toMatch(/if \(withClient\) steps\.push\(\{ script: "build:client"/);
    // The unconditional step list must not name it at all.
    const baseSteps = source.slice(source.indexOf("const steps = ["), source.indexOf("];", source.indexOf("const steps = [")));
    expect(baseSteps).toContain("build:worker");
    expect(baseSteps).not.toContain("build:client");
  });

  it("does not shell out to the umbrella `pnpm build`, which would drag the client in", () => {
    expect(source).not.toMatch(/\["build"\]/);
  });

  it("points a failed client build at the flag that gets you a tarball anyway", () => {
    expect(source).toContain("re-run WITHOUT --with-client");
  });
});
