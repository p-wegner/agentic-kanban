// Leaf helpers split out of worker-daemon.ts (god-module line ceiling, function-nloc ratchet).
import WebSocket from "ws";
import { attestAndNotice } from "./worker-provider-notice.js";
import type { WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
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
