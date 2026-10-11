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
import { detectPackageManagers } from "../../worker/worker-toolchain.js";

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
      detail: "git is not on this machine's PATH",
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
