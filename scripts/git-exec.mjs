/**
 * The sanctioned git spawn site for the repo's PLAIN-NODE `scripts/*.mjs`.
 *
 * `packages/shared/src/lib/git-exec.ts` is the adapter every module must go through, but it is
 * TypeScript under `packages/shared/src`: a script run as a bare `node scripts/<x>.mjs` — with no
 * bundler, no tsx, and often before `packages/shared/dist` exists at all — cannot import it. That
 * is a real constraint, not a preference (see the ALLOWLIST entries in
 * `packages/shared/__tests__/git-exec-single-spawn.test.ts`), and the historical answer was for
 * each such script to grow its own private `git()` helper. That is exactly the drift the
 * architecture gate exists to prevent, just one directory over.
 *
 * So this module is the scripts-tier twin of that adapter, in the same spirit as
 * `scripts/pnpm-exec.mjs`: dependency-free, importable by any `.mjs` in `scripts/`, and the ONE
 * place in that tier that names the `git` binary. It keeps the Windows quirk (`windowsHide`, so a
 * spawned child never flashes a console window on a machine running several agents), a generous
 * buffer default, and one error shape.
 *
 * It deliberately does NOT mirror the shared adapter's scheduler, priority lanes or async surface:
 * these scripts run one command at a time and want the synchronous form. When a script needs more
 * than this, the answer is to make it able to import the shared adapter, not to widen this file.
 */
import { spawnSync } from "node:child_process";

/** Generous by default — a full-history log is a normal call here. */
export const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * @typedef {object} GitExecScriptOptions
 * @property {string} [cwd] Directory to run in. Defaults to the process cwd.
 * @property {number} [maxBuffer] stdout/stderr cap in bytes.
 * @property {NodeJS.ProcessEnv} [env] Environment for the child.
 */

/**
 * @typedef {object} GitExecScriptResult
 * @property {number} code Exit code; 1 when the child could not be spawned at all.
 * @property {string} stdout Raw stdout — NOT trimmed, since callers that split on a record
 *   separator need it verbatim.
 * @property {string} stderr Raw stderr.
 * @property {Error | undefined} error Set when the spawn itself failed.
 */

/**
 * Run the CLI and NEVER throw. The primitive; everything else here builds on it.
 *
 * @param {string[]} args
 * @param {GitExecScriptOptions} [opts]
 * @returns {GitExecScriptResult}
 */
export function gitExecSyncResult(args, opts = {}) {
  const res = spawnSync("git", args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
  });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error,
  };
}

/**
 * Run the CLI and throw a normalised error on any non-zero exit, returning raw stdout.
 *
 * @param {string[]} args
 * @param {GitExecScriptOptions} [opts]
 * @returns {string}
 */
export function gitExecSync(args, opts = {}) {
  const r = gitExecSyncResult(args, opts);
  if (r.code !== 0) {
    const where = opts.cwd ? ` in ${opts.cwd}` : "";
    throw new Error(`git ${args.join(" ")} failed${where} (exit ${r.code}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}
