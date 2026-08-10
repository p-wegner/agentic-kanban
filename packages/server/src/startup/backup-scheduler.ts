/**
 * Periodic database backup scheduler.
 *
 * Runs one backup ~60s after boot (capturing the just-recovered state), then on
 * a configurable interval. Interval comes from the `backup_interval_min`
 * preference (default 30; 0 disables periodic backups).
 */
import { createBackup } from "../db/backup.js";

let activeBackupTimeout: ReturnType<typeof setTimeout> | null = null;
let activeBackupInterval: ReturnType<typeof setInterval> | null = null;

export function stopBackupScheduler(): void {
  if (activeBackupTimeout !== null) {
    clearTimeout(activeBackupTimeout);
    activeBackupTimeout = null;
  }
  if (activeBackupInterval !== null) {
    clearInterval(activeBackupInterval);
    activeBackupInterval = null;
  }
}

/**
 * Start the periodic backup scheduler.
 * @param intervalMin minutes between backups; <= 0 disables periodic backups
 *   (a single post-boot backup is still taken).
 * @returns the interval handle (or null if periodic backups are disabled).
 */
export function startBackupScheduler(intervalMin = 30): NodeJS.Timeout | null {
  stopBackupScheduler();

  const run = (options?: { skipIfNewerThanMs?: number }) =>
    createBackup("periodic", options).catch((e) =>
      console.warn(
        "[backup] periodic backup failed:",
        e instanceof Error ? e.message : e,
      ),
    );

  // One shortly after boot — but skipped if a backup from the previous boot is
  // still fresher than the configured interval (#322). The point of this one is
  // "capture the just-recovered state", which a backup taken minutes ago already
  // does; under `tsx watch` the process boots on every source edit, and taking a
  // full-size `VACUUM INTO` of the live DB each time turned a restart storm into
  // a backup storm that starved the API's write path.
  const bootSkipMs = intervalMin > 0 ? intervalMin * 60_000 : 30 * 60_000;
  activeBackupTimeout = setTimeout(() => void run({ skipIfNewerThanMs: bootSkipMs }), 60_000);
  activeBackupTimeout.unref?.();

  if (intervalMin <= 0) {
    console.log("[backup] periodic interval disabled (backup_interval_min=0)");
    return null;
  }
  console.log(`[backup] periodic backups every ${intervalMin} min`);
  const handle = setInterval(() => void run(), intervalMin * 60_000);
  activeBackupInterval = handle;
  handle.unref();
  return handle;
}
