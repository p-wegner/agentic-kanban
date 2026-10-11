/**
 * Pair with a board and save the identity WITHOUT starting the daemon (#1368 `setup`).
 * The same registration `startWorkerDaemon` does on first run; an existing pairing is kept.
 */
import { hostname } from "node:os";
import {
  defaultWorkerStateFile,
  loadState,
  normalizeBoardUrl,
  registerWithBoard,
  saveIdentity,
  type WorkerDaemonOptions,
} from "./worker-daemon.js";
import { attestProviders } from "./worker-provider-notice.js";

export async function pairWorker(opts: WorkerDaemonOptions): Promise<{ alreadyPaired: boolean; name: string }> {
  const stateFile = opts.stateFile ?? defaultWorkerStateFile();
  const boardUrl = normalizeBoardUrl(opts.boardUrl);
  const existing = loadState(stateFile).boards[boardUrl];
  if (existing) return { alreadyPaired: true, name: existing.name };
  const declared = opts.providers ?? [];
  const providers = opts.attestProviders === false
    ? declared
    : await attestProviders(declared, opts.log ?? console.log, opts.harness);
  const identity = await registerWithBoard({ ...opts, providers }, boardUrl, opts.name ?? hostname());
  saveIdentity(stateFile, boardUrl, identity);
  return { alreadyPaired: false, name: identity.name };
}
