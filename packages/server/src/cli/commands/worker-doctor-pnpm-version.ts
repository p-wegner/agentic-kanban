/**
 * `worker doctor` check (#1483): is this machine's pnpm the one the repo pins in `packageManager`?
 * A different pnpm can rewrite `pnpm-lock.yaml` on install — one that ignored the overrides in
 * `pnpm-workspace.yaml` dropped the security pins from a landed train. WARN: doctor cannot know which
 * project a worker will serve. The pin is hard-coded (the worker tarball ships no root package.json);
 * bump it with the root `packageManager` — `worker-doctor-pnpm-version.test.ts` fails on drift.
 */
import type { CheckStatus } from "./worker-doctor.js";
import type { ProbeFn } from "./worker-doctor-git-prereqs.js";

export const EXPECTED_PNPM_VERSION = "10.34.6";

export async function checkPnpmVersion(
  probe: ProbeFn,
  expected: string = EXPECTED_PNPM_VERSION,
): Promise<{ name: string; status: CheckStatus; detail: string; remedy?: string } | null> {
  const res = await probe("pnpm", ["--version"]);
  if (!res.found || res.code !== 0) return null; // absence is `checkPackageManager`'s finding
  const have = res.output.split("\n")[0]?.trim() ?? "";
  if (have === expected) return { name: "pnpm version", status: "pass", detail: `pnpm ${have} matches the repo's packageManager` };
  return {
    name: "pnpm version",
    status: "warn",
    detail:
      `this machine runs pnpm ${have || "(unreadable)"}, the repo pins pnpm@${expected}. A different pnpm can rewrite pnpm-lock.yaml ` +
      "on install (e.g. dropping the pnpm-workspace.yaml overrides); the gate refuses a lockfile-only drift and one-shot auto-commits exclude lockfiles, but builds here are not reproducible",
    remedy: `corepack enable pnpm && corepack prepare pnpm@${expected} --activate (or: npm i -g pnpm@${expected})`,
  };
}
