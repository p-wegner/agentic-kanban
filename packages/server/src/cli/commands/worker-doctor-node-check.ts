import type { DoctorCheck } from "./worker-doctor.js";

/**
 * The board declared Node floor (root CLAUDE.md: "Node LTS 22 floor (#731)"). Hard-coded
 * rather than read from `engines.node` because that field lives only in the MONOREPO ROOT
 * `package.json` — the worker tarball ships `packages/server`'s own `package.json`
 * (`scripts/pack-worker.mjs`), which carries no `engines` field at all, so there is nothing
 * to read live from inside the worker binary. Bump this if the root floor changes; nothing
 * keeps the two in sync automatically (#860).
 */
export const MIN_SUPPORTED_NODE_MAJOR = 22;

/**
 * Check 8 — is this machine's Node runtime new enough for the worker daemon (#860)?
 *
 * A worker checkout installs its own dependencies and builds `packages/shared/dist` via the
 * project's setup script, on THIS machine's toolchain — an old Node here can fail in ways
 * that look nothing like a version problem (a syntax error deep in a dependency, a build step
 * that silently no-ops). Nothing else on the worker side checked this before.
 *
 * Lives in its own module rather than `worker-doctor.ts` because that file sits exactly at
 * the god-module gate's 20-declaration ceiling (#889) — this check pushed it to 21.
 */
export function checkNodeVersion(nodeVersion: string = process.version): DoctorCheck {
  const match = /^v?(\d+)\./.exec(nodeVersion);
  const major = match ? Number(match[1]) : null;
  if (major === null) {
    return {
      name: "node runtime version",
      status: "unknown",
      detail: `could not parse a major version out of "${nodeVersion}"`,
    };
  }
  if (major < MIN_SUPPORTED_NODE_MAJOR) {
    return {
      name: "node runtime version",
      status: "fail",
      detail: `this machine runs Node ${nodeVersion}, older than the board's declared floor (>=${MIN_SUPPORTED_NODE_MAJOR})`,
      remedy: `Install Node ${MIN_SUPPORTED_NODE_MAJOR} LTS or newer, then reinstall the worker package under it.`,
    };
  }
  return {
    name: "node runtime version",
    status: "pass",
    detail: `Node ${nodeVersion} (floor is >=${MIN_SUPPORTED_NODE_MAJOR})`,
  };
}
