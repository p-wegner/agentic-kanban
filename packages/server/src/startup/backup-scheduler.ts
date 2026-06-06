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

  const run = () =>
    createBackup("periodic").catch((e) =>
      console.warn(
        "[backup] periodic backup failed:",
        e instanceof Error ? e.message : e,
      ),
    );

  // One shortly after boot.
  activeBackupTimeout = setTimeout(run, 60_000);
  activeBackupTimeout.unref?.();

  if (intervalMin <= 0) {
    console.log("[backup] periodic interval disabled (backup_interval_min=0)");
    return null;
  }
  console.log(`[backup] periodic backups every ${intervalMin} min`);
  const handle = setInterval(run, intervalMin * 60_000);
  activeBackupInterval = handle;
  handle.unref();
  return handle;
}
