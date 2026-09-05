import { isAbsolute, resolve } from "node:path";

/**
 * Where a relative CLI path argument is resolved FROM (#1038).
 *
 * `pnpm cli -- …` expands to `pnpm --filter agentic-kanban exec node … src/cli/index.ts`,
 * which runs with cwd = `packages/server`. So `pnpm cli -- backlog export --out BACKLOG.md`
 * from the repo root wrote `packages/server/BACKLOG.md` while printing `wrote BACKLOG.md` —
 * a miss that looks exactly like a success, and left the stale root file looking current.
 *
 * pnpm (and npm) set `INIT_CWD` to the directory the command was actually invoked from,
 * which is the directory the caller meant. Absent — a global `agentic-kanban` binary, a
 * worker machine, a spawned child — `process.cwd()` is already the invocation directory,
 * so the fallback is not a compromise.
 *
 * `INIT_CWD` is only trusted when it is absolute: a relative value cannot be a "the
 * directory you were in" answer, and resolving against it would land somewhere nobody
 * named. Reading `process.cwd()` lazily (not at module load) keeps it testable and
 * correct for anything that chdirs before parsing.
 */
export function invocationCwd(env: NodeJS.ProcessEnv = process.env): string {
  const initCwd = env.INIT_CWD;
  if (initCwd && isAbsolute(initCwd)) return initCwd;
  return process.cwd();
}

/**
 * Resolve a CLI path argument to an ABSOLUTE path against the invocation directory.
 * An already-absolute value is returned normalised, unchanged in meaning.
 */
export function resolveCliPath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(invocationCwd(env), value);
}

/**
 * The commander coercion — attach it at the DECLARATION of every path-taking option or
 * argument (`.option("--out <file>", "…", cliPathArg)`), never inside a handler. Doing it
 * at the argument boundary is what stops the next command that takes a path from
 * inheriting the bug, and it means every handler and every success message already holds
 * the absolute path, so a wrong answer is visible instead of silent.
 *
 * Deliberately one parameter: commander calls a parser as `fn(value, previous)`, and
 * `resolveCliPath`'s second parameter is the environment — passing it straight to
 * commander would hand `previous` to it as an env object.
 *
 * Enforced by `cli-path-resolution-guard.test.ts`.
 */
export const cliPathArg = (value: string): string => resolveCliPath(value);
