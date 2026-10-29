import { PluginError } from "./plugin-errors.js";

/**
 * One in-process lock per (plugin row, project) over everything that touches the plugin's state
 * dir: pull, push, resolve, test-connection and the scheduler (#1734). Held in memory on purpose —
 * a lock file would outlive a killed board; here a restart clears it, and `finally` releases it
 * when the plugin command times out (runPluginCommand always settles).
 */
const syncLocks = new Map<string, { label: string; startedAt: string }>();

export async function withSyncLock<T>(pluginRowId: string, projectId: string, label: string, fn: () => Promise<T>): Promise<T> {
  const key = `${pluginRowId}:${projectId}`;
  const held = syncLocks.get(key);
  if (held) throw new PluginError(`sync already running (${held.label}, started ${held.startedAt})`, "CONFLICT");
  syncLocks.set(key, { label, startedAt: new Date().toISOString() });
  try {
    return await fn();
  } finally {
    syncLocks.delete(key);
  }
}

export function isSyncLocked(pluginRowId: string, projectId: string): boolean {
  return syncLocks.has(`${pluginRowId}:${projectId}`);
}
