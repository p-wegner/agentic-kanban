// #1340: the daemon's own log file. An unsupervised self-update relaunches the new build
// detached with no terminal, so everything it prints used to go to null. The daemon now also
// appends every log line to `<worker-home>/worker.log`, and a relaunch points the child's
// stdout/stderr at that same file.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const WORKER_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Set on a relaunched child whose stdout/stderr already ARE the log file (no second tee). */
export const WORKER_LOG_INHERITED_ENV = "KANBAN_WORKER_LOG_INHERITED";

export function isWorkerLogInherited(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KANBAN_WORKER_LOG_INHERITED === "1";
}

/** `<worker-home>/worker.log` — beside the state file, so `--state-file` moves both together. */
export function workerLogFileFor(stateFile: string): string {
  return join(dirname(stateFile), "worker.log");
}

/** Keep one previous generation (`worker.log.1`) once the file passes `maxBytes`. */
export function rotateWorkerLog(logFile: string, maxBytes = WORKER_LOG_MAX_BYTES): void {
  try {
    if (statSync(logFile).size <= maxBytes) return;
    rmSync(`${logFile}.1`, { force: true });
    renameSync(logFile, `${logFile}.1`);
  } catch {
    /* no file yet, or in use — rotation is best-effort */
  }
}

/**
 * Wrap `base` so each line is also appended to `logFile`. A file failure never breaks logging.
 * `inherited`: stdout is already the file, so only `base` is called.
 */
export function teeLogToFile(
  base: (line: string) => void,
  logFile: string,
  opts: { inherited?: boolean; nowMs?: number } = {},
): (line: string) => void {
  if (opts.inherited) return base;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    rotateWorkerLog(logFile);
  } catch {
    /* fall through — appends below are guarded too */
  }
  return (line) => {
    base(line);
    try {
      appendFileSync(logFile, `${new Date(opts.nowMs ?? Date.now()).toISOString()} ${line}\n`);
    } catch {
      /* a full disk must not take the daemon down */
    }
  };
}
