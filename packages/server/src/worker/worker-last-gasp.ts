/**
 * #1661 — the worker's last line. `desktop-stable` died mid-gate and its log just stopped
 * (`session probe ... state=unknown`): no exit code, no signal, no job, so the cause could not
 * be seen afterwards. This writes ONE line, synchronously (`appendFileSync`, so it is on disk
 * before the process is gone), on `exit`, on a fatal signal, and on every uncaught
 * exception / unhandled rejection. The daemon keeps running after the latter two (#754);
 * the line is still written so a later silent death has a trail to follow.
 *
 * Standalone-worker module: no db, no board services (worker-cli-isolation.test.ts).
 */
import { appendFileSync } from "node:fs";

export interface LastGaspContext {
  logFile: string;
  /** What the worker is running right now, e.g. session ids; called at death, must not throw. */
  describeJobs?: () => string[];
}

export interface LastGaspDeps {
  proc?: Pick<NodeJS.Process, "on" | "memoryUsage" | "pid">;
  nowMs?: number;
  append?: (file: string, text: string) => void;
}

let context: LastGaspContext | null = null;

/** Point the handlers at the log file once the state file is known (they are installed earlier). */
export function setLastGaspContext(next: LastGaspContext | null): void {
  context = next;
}

export function formatLastGasp(kind: string, detail: string, jobs: string[], mem: NodeJS.MemoryUsage, pid: number, nowMs: number): string {
  const mb = (n: number): string => `${Math.round(n / 1048576)}MB`;
  return (
    `${new Date(nowMs).toISOString()} [worker] LAST-GASP ${kind}${detail ? ` ${detail}` : ""} pid=${pid} ` +
    `jobs=${jobs.length > 0 ? jobs.join(",") : "none"} rss=${mb(mem.rss)} heapUsed=${mb(mem.heapUsed)}\n`
  );
}

function reasonText(reason: unknown): string {
  if (reason instanceof Error) return (reason.stack ?? reason.message).replace(/\s*\n\s*/g, " | ");
  return String(reason);
}

export function installLastGasp(deps: LastGaspDeps = {}): void {
  const proc = deps.proc ?? process;
  const append = deps.append ?? ((f, t) => appendFileSync(f, t));
  const write = (kind: string, detail: string): void => {
    const ctx = context;
    if (!ctx) return;
    try {
      let jobs: string[] = [];
      try { jobs = ctx.describeJobs?.() ?? []; } catch { /* best effort */ }
      append(ctx.logFile, formatLastGasp(kind, detail, jobs, proc.memoryUsage(), proc.pid, deps.nowMs ?? Date.now()));
    } catch {
      /* dying: nothing left to report to */
    }
  };
  proc.on("exit", (code: number) => write("exit", `code=${code}`));
  proc.on("uncaughtException", (err: unknown) => write("uncaughtException", reasonText(err)));
  proc.on("unhandledRejection", (reason: unknown) => write("unhandledRejection", reasonText(reason)));
  // No signal listeners on purpose: adding one removes Node's default "die on SIGINT" for every
  // worker subcommand. A signal-driven stop still reaches `exit` above; SIGKILL cannot be caught
  // by anything, which is what the restarting launcher's exit-code line is for.
}
