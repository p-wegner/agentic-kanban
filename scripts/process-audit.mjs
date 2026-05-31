import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function processAuditLogPath() {
  return process.env.AGENTIC_KANBAN_PROCESS_AUDIT_LOG
    || join(homedir(), ".agentic-kanban", "process-audit.log");
}

export function writeProcessAudit(event) {
  const payload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    cwd: process.cwd(),
    ...event,
  };
  const line = JSON.stringify(payload);
  console.log(`[process-audit] ${payload.action} ${line}`);
  try {
    const logPath = processAuditLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line + "\n", "utf8");
  } catch (err) {
    console.warn(`[process-audit] failed to write audit log: ${err instanceof Error ? err.message : String(err)}`);
  }
}
