import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export type ProcessAuditEvent = Record<string, unknown> & {
  action: string;
};

export function processAuditLogPath(): string {
  return process.env.AGENTIC_KANBAN_PROCESS_AUDIT_LOG
    || join(homedir(), ".agentic-kanban", "process-audit.log");
}

export function auditProcessEvent(event: ProcessAuditEvent): void {
  const payload = {
    ts: new Date().toISOString(),
    boardPid: process.pid,
    ...event,
  };
  const line = JSON.stringify(payload);
  console.log(`[process-audit] ${event.action} ${line}`);
  try {
    const logPath = processAuditLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line + "\n", "utf8");
  } catch (err) {
    console.warn(`[process-audit] failed to write audit log: ${errorMessage(err)}`);
  }
}

function parsePidList(value: string | undefined): Set<number> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  );
}

/* ---------------------------------------------------------------------------
 * #1059 — a RUNTIME protected set, beside the environment ones
 *
 * `KANBAN_PROTECTED_PIDS` / `KANBAN_BOARD_SERVER_PID` are fixed at launch, so they can
 * only ever describe processes that existed before this one did. A verify child the board
 * spawned SECONDS ago and is actively awaiting was therefore invisible to the guard that
 * decides what to kill — and the sweeper duly killed two of them (see the note in
 * `shared/lib/setup-script.ts`).
 *
 * Registration is REFERENCE COUNTED. Two concurrent runs can legitimately be handed the
 * same pid only if one has already exited and the OS reused the number, but the counter
 * also makes an unbalanced release harmless: the entry survives until every registration
 * has been released, and the alternative (a plain delete) would strip protection from a
 * live run because an unrelated one finished.
 * ------------------------------------------------------------------------ */
const runtimeProtectedPids = new Map<number, number>();

/** Protect `pid` (and thus its process tree) from the sweeper until released. */
export function registerProtectedPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  runtimeProtectedPids.set(pid, (runtimeProtectedPids.get(pid) ?? 0) + 1);
}

/** Release one registration of `pid`; the pid stays protected while others remain. */
export function releaseProtectedPid(pid: number): void {
  const count = runtimeProtectedPids.get(pid);
  if (count === undefined) return;
  if (count <= 1) runtimeProtectedPids.delete(pid);
  else runtimeProtectedPids.set(pid, count - 1);
}

/** Test seam — the registry is module state and would otherwise leak between cases. */
export function clearRuntimeProtectedPids(): void {
  runtimeProtectedPids.clear();
}

/** Currently-registered runtime pids, for assertions and diagnostics. */
export function runtimeProtectedPidList(): number[] {
  return [...runtimeProtectedPids.keys()].sort((a, b) => a - b);
}

export function protectedPids(): Set<number> {
  return new Set([
    process.pid,
    ...runtimeProtectedPids.keys(),
    ...parsePidList(process.env.KANBAN_PROTECTED_PIDS),
    ...parsePidList(process.env.KANBAN_BOARD_SERVER_PID),
  ]);
}

export function guardProcessKill(pid: number, context: Record<string, unknown>): boolean {
  if (protectedPids().has(pid)) {
    auditProcessEvent({ action: "process-kill-blocked", pid, reason: "protected-pid", ...context });
    console.warn(`[process-guard] blocked protected pid kill: pid=${pid} reason=${(context.reason as string | undefined) ?? "unknown"}`);
    return false;
  }
  auditProcessEvent({ action: "process-kill-allowed", pid, ...context });
  return true;
}
