/**
 * `worker doctor` prerequisites a clean machine lacks (#1369): the git version, the git
 * commit identity, the package manager, and a blanket `safe.directory`.
 *
 * Its own module for the same reason the other doctor checks are: `worker-doctor.ts` sits at the
 * god-module gate's declaration ceiling (#889). The probe is INJECTED (the real one is
 * `probeCommand` there) so this file never imports its parent and the checks stay testable
 * without a git binary of a particular version.
 */
import type { CheckStatus } from "./worker-doctor.js";
import { execFile } from "node:child_process";
import { windowsOnlyMessage } from "../../worker/worker-path.js";
import type { WorkerPackageManagers } from "@agentic-kanban/shared/lib/worker-protocol";
import { parseToolVersion, type WorkerToolchains } from "@agentic-kanban/shared/lib/worker-toolchains";

type DoctorCheckLike = { name: string; status: CheckStatus; detail: string; remedy?: string };
export type ProbeFn = (command: string, args: string[]) => Promise<{ found: boolean; code: number | null; output: string }>;

/** `worker-repo.ts` passes the auth header through `GIT_CONFIG_COUNT`, which needs git >= 2.31. */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 31];

/** `[major, minor]` from `git version 2.30.0.windows.1`, or null when unparseable. */
export function parseGitVersion(output: string): [number, number] | null {
  const m = /git version (\d+)\.(\d+)/.exec(output);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function upgradeGitCommand(platform: NodeJS.Platform): string {
  if (platform === "win32") return "winget upgrade --id Git.Git -e (or download from https://git-scm.com/download/win)";
  if (platform === "darwin") return "brew upgrade git";
  return "sudo apt-get install --only-upgrade git (or add the git-core PPA: sudo add-apt-repository ppa:git-core/ppa)";
}

/** Check - git on PATH AND new enough for the env-based auth header the worker uses. */
export async function checkGitInstalled(probe: ProbeFn, platform: NodeJS.Platform = process.platform): Promise<DoctorCheckLike> {
  const res = await probe("git", ["--version"]);
  if (!res.found) {
    return {
      name: "git on PATH",
      status: "fail",
      detail: windowsOnlyMessage("git") ?? "git is not on this machine's PATH",
      remedy: `Install git >= ${MIN_GIT_VERSION.join(".")} and re-open the shell: ${upgradeGitCommand(platform)}`,
    };
  }
  const line = res.output.split("\n")[0] ?? "git present";
  const version = parseGitVersion(line);
  if (!version) return { name: "git on PATH", status: "pass", detail: `${line} (version not recognised, not checked)` };
  const [major, minor] = version;
  if (major < MIN_GIT_VERSION[0] || (major === MIN_GIT_VERSION[0] && minor < MIN_GIT_VERSION[1])) {
    return {
      name: "git on PATH",
      status: "fail",
      detail: `${line} - the worker needs git >= ${MIN_GIT_VERSION.join(".")} (it passes the board's git credential via GIT_CONFIG_COUNT), so every clone/fetch would be refused`,
      remedy: `Upgrade git: ${upgradeGitCommand(platform)}`,
    };
  }
  return { name: "git on PATH", status: "pass", detail: line };
}

async function globalGit(probe: ProbeFn, args: string[]): Promise<string> {
  const res = await probe("git", ["config", "--global", ...args]);
  return res.found && res.code === 0 ? res.output.trim() : "";
}

/**
 * Check - a global commit identity. WARN, not fail: the board sends its project's identity in
 * every assignment and the worker applies it per checkout, so a machine without one still
 * commits - but only for a project whose board checkout HAS an identity, which doctor cannot see.
 */
export async function checkGitIdentity(probe: ProbeFn): Promise<DoctorCheckLike> {
  const [name, email] = await Promise.all([globalGit(probe, ["user.name"]), globalGit(probe, ["user.email"])]);
  if (name && email) return { name: "git commit identity", status: "pass", detail: `${name} <${email}>` };
  const missing = [!name ? "user.name" : null, !email ? "user.email" : null].filter(Boolean).join(" and ");
  return {
    name: "git commit identity",
    status: "warn",
    detail:
      `no global ${missing}. The board sends its project's committer identity with each assignment and the worker ` +
      "applies it per checkout, but a project whose board checkout has no identity would fail its commits here",
    remedy: 'git config --global user.name "Your Name"; git config --global user.email "you@example.com"',
  };
}

/** Check - a global `safe.directory=*`. Informational: it is not a fault, it hides one. */
export async function checkGitSafeDirectory(probe: ProbeFn): Promise<DoctorCheckLike | null> {
  const values = (await globalGit(probe, ["--get-all", "safe.directory"])).split("\n").map((v) => v.trim());
  if (!values.includes("*")) return null;
  return {
    name: "git safe.directory",
    status: "pass",
    detail:
      "INFO: a global safe.directory=* is set. That is not a fault, but it hides the 'dubious ownership' errors a " +
      "fresh machine would otherwise hit, so this machine's results may not transfer to one without it",
  };
}

/** Check - pnpm. WARN: only projects with a pnpm lockfile need it, and doctor cannot know which. */
export async function checkPackageManager(
  detect: typeof detectPackageManagers = detectPackageManagers,
): Promise<DoctorCheckLike> {
  const have = await detect();
  if (have.pnpm) return { name: "pnpm on PATH", status: "pass", detail: "pnpm present" };
  return {
    name: "pnpm on PATH",
    status: "warn",
    detail:
      "pnpm is not on PATH. A project with a pnpm lockfile fails its install here as assign_failed " +
      `(yarn: ${have.yarn ? "present" : "absent"}, bun: ${have.bun ? "present" : "absent"}, corepack: ${have.corepack ? "present" : "absent"})`,
    remedy: have.corepack ? "corepack enable pnpm (or: npm i -g pnpm)" : "npm i -g pnpm (corepack is not available here)",
  };
}

// What the worker machine has on PATH, probed here so the heartbeat and doctor share one reading (#1369).
// Kept in this module, not its own file: the worker binary's import graph is size-bounded.



/**
 * `command args` as ONE string for a `shell: true` spawn on Windows (`.cmd` shims). Passing an args array together with
 * `shell: true` is Node's DEP0190 (args are concatenated unescaped); a single, quoted line is the documented pattern (#1453).
 */
export function shellLine(command: string, args: readonly string[]): string {
  return [command, ...args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(" ");
}

/** Does `command --version` run? Never throws; ENOENT (or any spawn failure) is "absent". */
export function commandExists(command: string, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    // `shell: true` on Windows: pnpm/yarn/corepack are `.cmd` shims there, which execFile
    // cannot spawn directly. The command name is a fixed literal, never operator input.
    const onDone = (err: unknown) => resolve(!err);
    if (process.platform === "win32") {
      execFile(shellLine(command, ["--version"]), { timeout: timeoutMs, windowsHide: true, shell: true }, onDone);
    } else {
      execFile(command, ["--version"], { timeout: timeoutMs, windowsHide: true }, onDone);
    }
  });
}

/** Probe pnpm / yarn / bun / corepack. */
export async function detectPackageManagers(
  exists: (command: string) => Promise<boolean> = commandExists,
): Promise<WorkerPackageManagers> {
  const [pnpm, yarn, bun, corepack] = await Promise.all([
    exists("pnpm"),
    exists("yarn"),
    exists("bun"),
    exists("corepack"),
  ]);
  return { pnpm, yarn, bun, corepack };
}

/** Re-probe at most this often from the heartbeat; an install made meanwhile shows up within it. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let cached: WorkerPackageManagers | undefined;
let refreshedAtMs = 0;
let inFlight: Promise<void> | null = null;

/** The last probe result, or undefined before the first one finishes. Synchronous, for heartbeats. */
export function cachedPackageManagers(): WorkerPackageManagers | undefined {
  return cached;
}

/** Probe now (awaitable), or return immediately if a probe is already running. */
export function refreshPackageManagers(
  nowMs: number = Date.now(),
  exists?: (command: string) => Promise<boolean>,
): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = detectPackageManagers(exists)
    .then((found) => {
      cached = found;
      refreshedAtMs = nowMs;
    })
    .catch(() => {
      /* keep the previous reading; absent stays "unknown" */
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Kick a background re-probe when the reading is older than the refresh interval. */
export function refreshPackageManagersIfStale(nowMs: number = Date.now()): void {
  if (cached && nowMs - refreshedAtMs < REFRESH_INTERVAL_MS) return;
  void refreshPackageManagers(nowMs);
}

/** Test seam: forget the cached reading. */
export function resetPackageManagerCache(): void {
  cached = undefined;
  refreshedAtMs = 0;
  inFlight = null;
}

/** The heartbeat's capability field: re-probes in the background when stale, spreads nothing before the first reading. */
export function packageManagersField(): { packageManagers?: WorkerPackageManagers } {
  refreshPackageManagersIfStale();
  return cached ? { packageManagers: cached } : {};
}

// Toolchains (#1382): what the worker can BUILD with, reported on the heartbeat so placement can route a
// project that declares `required_toolchains` (`pnpm, java>=21`). Same cache/refresh shape as the
// package managers above; kept in this module for the same import-graph reason.

/** Run `command args`, resolving the combined output, or null when it cannot be spawned / exits non-zero. */
export function runForOutput(command: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    const onDone = (err: unknown, stdout: string, stderr: string) => resolve(err ? null : `${stdout}
${stderr}`); // java prints its version on stderr
    if (process.platform === "win32") {
      execFile(shellLine(command, args), { timeout: timeoutMs, windowsHide: true, shell: true }, onDone);
    } else {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true }, onDone);
    }
  });
}

/** Per-toolchain probe: the command and args whose output carries the version. */
const TOOLCHAIN_PROBES: ReadonlyArray<readonly [name: string, command: string, args: string[]]> = [
  ["node", "node", ["--version"]],
  ["pnpm", "pnpm", ["--version"]],
  ["yarn", "yarn", ["--version"]],
  ["bun", "bun", ["--version"]],
  ["java", "java", ["-version"]],
  ["gradle", "gradle", ["--version"]],
  ["maven", "mvn", ["--version"]],
  ["go", "go", ["version"]],
  ["python", process.platform === "win32" ? "python" : "python3", ["--version"]],
  ["uv", "uv", ["--version"]],
  ["docker", "docker", ["--version"]],
];

/** Probe every known toolchain in parallel. A tool that is not found is simply absent from the result. */
export async function detectToolchains(
  run: (command: string, args: string[]) => Promise<string | null> = runForOutput,
): Promise<WorkerToolchains> {
  const found = await Promise.all(
    TOOLCHAIN_PROBES.map(async ([name, command, args]) => [name, await run(command, args)] as const),
  );
  const out: WorkerToolchains = {};
  for (const [name, output] of found) if (output !== null) out[name] = parseToolVersion(output);
  return out;
}

let cachedToolchains: WorkerToolchains | undefined;
let toolchainsRefreshedAtMs = 0;
let toolchainsInFlight: Promise<void> | null = null;

/** Probe now (awaitable), or return the probe already running. A failed probe keeps the previous reading. */
export function refreshToolchains(
  nowMs: number = Date.now(),
  run?: (command: string, args: string[]) => Promise<string | null>,
): Promise<void> {
  if (toolchainsInFlight) return toolchainsInFlight;
  toolchainsInFlight = detectToolchains(run)
    .then((found) => {
      cachedToolchains = found;
      toolchainsRefreshedAtMs = nowMs;
    })
    .catch(() => undefined)
    .finally(() => {
      toolchainsInFlight = null;
    });
  return toolchainsInFlight;
}

/** Test seam: forget the cached toolchains. */
export function resetToolchainCache(): void {
  cachedToolchains = undefined;
  toolchainsRefreshedAtMs = 0;
  toolchainsInFlight = null;
}

/** The heartbeat's toolchains field: re-probes in the background when stale, spreads nothing before the first reading. */
export function toolchainsField(nowMs: number = Date.now()): { toolchains?: WorkerToolchains } {
  if (!cachedToolchains || nowMs - toolchainsRefreshedAtMs >= REFRESH_INTERVAL_MS) void refreshToolchains(nowMs);
  return cachedToolchains ? { toolchains: cachedToolchains } : {};
}
