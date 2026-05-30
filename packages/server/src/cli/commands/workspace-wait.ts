import { db } from "../../db/index.js";
import { issues, workspaces } from "@agentic-kanban/shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { runMigrations, getActiveProjectId } from "../shared.js";

/**
 * Workspace statuses that mean the agent has finished its turn successfully and
 * the CLI `wait` command should resolve with exit code 0.
 */
const SUCCESS_STATUSES = new Set(["idle", "ready_for_merge", "closed", "merged"]);

/**
 * Workspace statuses that represent a failure — `wait` resolves with exit code 1.
 */
const ERROR_STATUSES = new Set(["error", "failed"]);

/**
 * Classify a workspace status into a terminal exit code, or null if the status
 * is non-terminal (still "active" / in-flight) and `wait` should keep blocking.
 *
 * - 0 → success terminal state (idle, ready_for_merge, closed, merged)
 * - 1 → error terminal state (error, failed)
 * - null → not terminal, keep waiting
 */
export function classifyStatus(status: string): number | null {
  if (ERROR_STATUSES.has(status)) return 1;
  if (SUCCESS_STATUSES.has(status)) return 0;
  return null;
}

interface WaitOptions {
  port?: string;
  timeout?: string;
}

/**
 * Look up the latest workspace for an issue number and block until its status
 * leaves the "active" family, reacting to board WebSocket events instead of
 * polling. Returns the process exit code.
 */
export async function runWorkspaceWait(issueNumberArg: string, options: WaitOptions): Promise<number> {
  await runMigrations();
  const projectId = await getActiveProjectId();

  const num = Number(issueNumberArg);
  if (!Number.isInteger(num) || num <= 0) {
    console.error(`Invalid issue number: ${issueNumberArg}`);
    return 1;
  }

  const issueRows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.issueNumber, num), eq(issues.projectId, projectId)))
    .limit(1);

  if (issueRows.length === 0) {
    console.error(`Issue #${num} not found.`);
    return 1;
  }

  const wsRows = await db
    .select({ id: workspaces.id, status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.issueId, issueRows[0].id))
    .orderBy(desc(workspaces.updatedAt))
    .limit(1);

  if (wsRows.length === 0) {
    console.error(`No workspace found for issue #${num}. Create one first.`);
    return 1;
  }

  const workspaceId = wsRows[0].id;
  let lastStatus = wsRows[0].status;

  // Fast path: already terminal, no need to open a socket.
  const already = classifyStatus(lastStatus);
  if (already !== null) {
    console.log(`#${num} ${lastStatus} (already terminal)`);
    return already;
  }

  console.log(`#${num} waiting (current status: ${lastStatus})`);

  // Re-read the workspace status straight from the DB. The board WS broadcast
  // carries only { reason } — not the per-workspace status — so each event is a
  // trigger to re-query here.
  const readStatus = async (): Promise<string | null> => {
    const rows = await db
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return rows.length > 0 ? rows[0].status : null;
  };

  const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
  const url = `ws://127.0.0.1:${port}/ws/board/${projectId}`;

  const timeoutSec = options.timeout !== undefined ? Number(options.timeout) : undefined;
  if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) {
    console.error(`Invalid --timeout value: ${options.timeout}`);
    return 1;
  }

  return await new Promise<number>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore — already closing/closed
      }
      resolve(code);
    };

    // Re-check the current status and emit a transition line if it changed.
    // Returns true once a terminal state has been reached (caller has resolved).
    const check = async (): Promise<void> => {
      if (settled) return;
      let status: string | null;
      try {
        status = await readStatus();
      } catch (err) {
        console.error("Error reading workspace status:", err instanceof Error ? err.message : String(err));
        finish(1);
        return;
      }
      if (status === null) {
        console.error(`Workspace for #${num} no longer exists.`);
        finish(1);
        return;
      }
      if (status !== lastStatus) {
        console.log(`#${num} ${lastStatus} → ${status}`);
        lastStatus = status;
      }
      const code = classifyStatus(status);
      if (code !== null) finish(code);
    };

    const ws = new WebSocket(url);

    ws.onopen = () => {
      // Re-check immediately in case the status changed between our initial DB
      // read and the socket opening.
      void check();
    };

    ws.onmessage = (event: MessageEvent) => {
      let reason: string | undefined;
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        if (msg?.type !== "board_changed") return;
        reason = msg.reason;
      } catch {
        return; // ignore malformed frames
      }
      // workflow_error is a board-level failure signal that may not be reflected
      // as an "error" workspace status — treat it as a terminal failure.
      if (reason === "workflow_error") {
        void (async () => {
          await check();
          if (!settled) {
            console.error(`#${num} workflow error.`);
            finish(1);
          }
        })();
        return;
      }
      void check();
    };

    ws.onerror = () => {
      // onerror is followed by onclose; let onclose handle resolution.
    };

    ws.onclose = () => {
      if (settled) return;
      console.error("WebSocket closed before workspace reached a terminal state.");
      finish(1);
    };

    if (timeoutSec !== undefined) {
      timer = setTimeout(() => {
        if (settled) return;
        console.error(`Timed out after ${timeoutSec}s waiting for #${num} (last status: ${lastStatus}).`);
        finish(1);
      }, timeoutSec * 1000);
      (timer as NodeJS.Timeout).unref?.();
    }
  });
}
