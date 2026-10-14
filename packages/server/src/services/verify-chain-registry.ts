/**
 * The verify chains holding a slot RIGHT NOW, with whatever progress their runner reported (#1462).
 *
 * Split from `verify-chain-semaphore.ts` (which owns admission) so the semaphore stays under the
 * god-module cohesion ceiling; it registers a chain here once admitted and unregisters on exit.
 * `status --watch` reads {@link listRunningVerifyChains} through `GET /api/workers/host`.
 */

export interface RunningVerifyChain {
  id: symbol;
  label: string;
  startedAtMs: number;
  /** `setup` / `arch` / `typecheck` / `tests` / ..., null until the runner says. */
  stage: string | null;
  filesDone?: number;
  filesTotal?: number;
}

export type VerifyChainProgressPatch = { stage?: string; filesDone?: number; filesTotal?: number };

const runningChains = new Set<RunningVerifyChain>();

/** Mark a chain as running; call the returned function when it exits. */
export function registerRunningVerifyChain(label: string): () => void {
  const entry: RunningVerifyChain = { id: Symbol(label), label, startedAtMs: Date.now(), stage: null };
  runningChains.add(entry);
  return () => { runningChains.delete(entry); };
}

/** The label the pre-merge gate gives a workspace's chain, shared so progress can find it again. */
export function workspaceVerifyChainLabel(workspaceId: string): string {
  return `verify chain for workspace ${workspaceId}`;
}

/** Chains holding a slot right now, oldest first. */
export function listRunningVerifyChains(): Array<Omit<RunningVerifyChain, "id">> {
  return [...runningChains].map(({ id: _id, ...rest }) => ({ ...rest }));
}

/** Record progress on the running chain with this label; a no-op when none is running. */
export function reportVerifyChainProgress(label: string, patch: VerifyChainProgressPatch): void {
  for (const chain of runningChains) {
    if (chain.label === label) Object.assign(chain, patch);
  }
}

/** Test seam: forget every running chain. */
export function clearRunningVerifyChainsForTests(): void {
  runningChains.clear();
}
