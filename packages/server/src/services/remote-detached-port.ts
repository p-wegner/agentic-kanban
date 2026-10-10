/**
 * Where the board's read paths learn which remote sessions are DETACHED (#1317).
 *
 * A detached session keeps `status: running` in the DB — the board holds it rather than failing
 * it — so the only record of "its worker is unreachable" is the in-memory remote session map.
 * Same reason and same shape as `remote-unlanded-port.ts`: read paths must not import the remote
 * agent service, so they ask the fleet facade and get null/empty when none is wired in.
 */
import { getWorkerFleet } from "./worker-fleet.service.js";
import { getWorkerNamesByIds } from "../repositories/placement-observability.repository.js";
import type { Database } from "../db/index.js";
import type { DetachedWorkerInfo } from "@agentic-kanban/shared";
import type { DetachedRemoteSession } from "./agent-remote.types.js";

/** sessionId -> detached info, empty when nothing is detached or no fleet is wired in. */
export async function resolveDetachedWorkers(database: Database): Promise<Map<string, DetachedWorkerInfo>> {
  let rows: DetachedRemoteSession[] = [];
  try {
    const ops = getWorkerFleet(database).remoteAgentService as unknown as { detachedSessions?: () => DetachedRemoteSession[] };
    rows = typeof ops.detachedSessions === "function" ? ops.detachedSessions() : [];
  } catch {
    return new Map();
  }
  if (rows.length === 0) return new Map();
  const names = await getWorkerNamesByIds(rows.map((r) => r.workerId), database).catch(() => new Map<string, string>());
  return new Map(
    rows.map((r) => [
      r.sessionId,
      {
        workerId: r.workerId,
        workerName: names.get(r.workerId) ?? null,
        detachedSince: new Date(r.detachedSinceMs).toISOString(),
        abandonAt: new Date(r.abandonAtMs).toISOString(),
      },
    ]),
  );
}
