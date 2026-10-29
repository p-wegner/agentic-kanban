// Leaf helpers split out of worker-daemon.ts (god-module line ceiling, function-nloc ratchet).
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { attestAndNotice } from "./worker-provider-notice.js";
import { WORKER_DUPLICATE_IDENTITY_CLOSE_CODE, type WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import type { WorkerDaemonOptions } from "./worker-daemon.js";

/** Flush queued exit/assign_failed frames. Returns how many could NOT be delivered. */
export function flushCritical(ws: WebSocket | null, pendingCritical: WorkerToBoardMessage[]): number {
  while (pendingCritical.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(pendingCritical.shift()));
    } catch {
      break; // socket died mid-flush; the remainder is counted as lost
    }
  }
  return pendingCritical.length;
}

/** #895: re-attest the declared providers; logs a change, returns null when attestation is off. */
export async function reattestProviders(
  opts: WorkerDaemonOptions, declared: string[] | undefined, advertised: string[] | undefined, log: (line: string) => void,
): Promise<{ advertised: string[]; notice?: string } | null> {
  if (opts.attestProviders === false || !declared || declared.length === 0) return null;
  const att = await attestAndNotice(declared, () => {}, opts.harness);
  if (att.advertised.join(",") !== (advertised ?? []).join(",")) {
    log(
      `[worker] provider attestation changed: now advertising [${att.advertised.join(", ") || "none"}] ` +
        `(was [${(advertised ?? []).join(", ") || "none"}])`,
    );
  }
  return att;
}

/** #1754: identifies this PROCESS, so the board can tell it from a second daemon sharing the same pairing. */
export function newInstanceId(): string {
  return randomUUID();
}

/** #1754: the give-up reason when the board closed us as a duplicate identity; null for any other close. */
export function duplicateIdentityGiveUp(code: number, workerId: string, detail: string): string | null {
  if (code !== WORKER_DUPLICATE_IDENTITY_CLOSE_CODE) return null;
  return (
    `another daemon process already holds worker ${workerId} on the board (duplicate identity${detail}). ` +
    `Two daemons cannot share one pairing/worker-state.json: stop one, or give this machine its own pairing.`
  );
}
