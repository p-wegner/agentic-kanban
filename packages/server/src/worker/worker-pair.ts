/**
 * Pair with a board and save the identity WITHOUT starting the daemon (#1368 `setup`).
 * The same registration `startWorkerDaemon` does on first run; an existing pairing is kept.
 */
import { defaultWorkerName } from "./worker-name.js";
import { defaultWorkerStateFile, registerWithBoard, type WorkerDaemonOptions } from "./worker-daemon.js";
import { adoptBoardId, findIdentity, loadState, parseBoardList, probeBoard, saveIdentity } from "./worker-state.js";
import { attestProviders } from "./worker-provider-notice.js";
import { readPersistedHarness, writePersistedHarness, type PersistedHarness, type WorkerHarness } from "./worker-harness.js";
import { join } from "node:path";

/** The state-file record for the harness a pairing used; no harness = the default, clean. */
function harnessRecordOf(harness: WorkerHarness | undefined): PersistedHarness {
  if (!harness || harness.mode !== "custom") return { mode: harness?.mode ?? "clean" };
  const own = (provider: string): string | undefined => {
    const dir = harness.dirFor(provider);
    return dir && dir !== join(harness.root, provider) ? dir : undefined;
  };
  const claudeConfigDir = own("claude");
  const codexHome = own("codex");
  return { mode: "custom", ...(claudeConfigDir ? { claudeConfigDir } : {}), ...(codexHome ? { codexHome } : {}) };
}

export async function pairWorker(opts: WorkerDaemonOptions): Promise<{ alreadyPaired: boolean; name: string }> {
  const stateFile = opts.stateFile ?? defaultWorkerStateFile();
  // #1337: several URLs of one board share a pairing, keyed by the board's identity.
  const boardUrls = parseBoardList([opts.boardUrl, ...(opts.boardUrls ?? [])]);
  const probes = await Promise.all(boardUrls.map((u) => probeBoard(u)));
  for (const p of probes) if (p.boardId) adoptBoardId(stateFile, p.url, p.boardId);
  const state = loadState(stateFile);
  const existing = boardUrls.map((u) => findIdentity(state, u)).find((i) => i !== undefined);
  if (existing) return { alreadyPaired: true, name: existing.name };
  const boardUrl = boardUrls[Math.max(0, probes.findIndex((p) => p.reachable))]!;
  const declared = opts.providers ?? [];
  const providers = opts.attestProviders === false
    ? declared
    : await attestProviders(declared, opts.log ?? console.log, opts.harness);
  const identity = await registerWithBoard({ ...opts, providers }, boardUrl, opts.name ?? defaultWorkerName());
  // #1386: record the harness this pairing was set up with BEFORE the pairing exists, so `start`
  // never mistakes a fresh pairing for one that predates harness modes (legacy inherit).
  // A state file that already has a pairing but no record is a legacy one: it stays inherit.
  const unpaired = Object.keys(loadState(stateFile).boards).length === 0;
  if (unpaired && !readPersistedHarness(stateFile)) writePersistedHarness(stateFile, harnessRecordOf(opts.harness));
  saveIdentity(stateFile, boardUrl, identity, boardUrls.filter((u) => {
    const id = probes.find((p) => p.url === u)?.boardId;
    return !id || !identity.boardId || id === identity.boardId;
  }));
  return { alreadyPaired: false, name: identity.name };
}
