// Verify chains whose script runs on a fleet WORKER (#1497): they hold no host verify-chain slot
// (the worker's own verify slots bound them, #1496) but still appear in the chain list "on <worker>".
import { registerRunningVerifyChain } from "./verify-chain-registry.js";
import type { VerifyChainPriority } from "./verify-chain-semaphore.js";

const offHostChains = new Set<{ label: string; priority: VerifyChainPriority; startedAtMs: number; worker: string }>();

export function listOffHostChains(): ReadonlyArray<{ label: string; priority: VerifyChainPriority; startedAtMs: number; worker: string }> {
  return [...offHostChains];
}

export function clearOffHostChainsForTests(): void {
  offHostChains.clear();
}

/** Same return shape as `runUnderVerifyChainSemaphoreTimed` (no queue, no machine lock). */
export async function runOffHostVerifyChainTimed<T>(
  chain: () => Promise<T>,
  label: string,
  workerName: string,
  opts?: { priority?: VerifyChainPriority },
): Promise<{ result: T; queueWaitMs: number; lockNote: string | null }> {
  const running = { label, priority: opts?.priority ?? "gate", startedAtMs: Date.now(), worker: workerName };
  offHostChains.add(running);
  const unregister = registerRunningVerifyChain(label);
  try {
    return { result: await chain(), queueWaitMs: 0, lockNote: null };
  } finally {
    offHostChains.delete(running);
    unregister();
  }
}
