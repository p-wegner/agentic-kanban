import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
    console.warn(`[process-audit] failed to write audit log: ${err instanceof Error ? err.message : String(err)}`);
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

export function protectedPids(): Set<number> {
  return new Set([
    process.pid,
    ...parsePidList(process.env.KANBAN_PROTECTED_PIDS),
    ...parsePidList(process.env.KANBAN_BOARD_SERVER_PID),
  ]);
}

export function guardProcessKill(pid: number, context: Record<string, unknown>): boolean {
  if (protectedPids().has(pid)) {
    auditProcessEvent({ action: "process-kill-blocked", pid, reason: "protected-pid", ...context });
    console.warn(`[process-guard] blocked protected pid kill: pid=${pid} reason=${String(context.reason ?? "unknown")}`);
    return false;
  }
  auditProcessEvent({ action: "process-kill-allowed", pid, ...context });
  return true;
}
