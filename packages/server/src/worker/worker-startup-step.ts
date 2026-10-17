/**
 * #1551: a best-effort step before the first connect (leftover cleanup, toolchain probes, doctor) must
 * not be able to hold the daemon off the board. A restarted daemon once sat 6+ minutes after
 * `logging to worker.log` with no `connected` line and no error, so the board showed "installing"
 * forever. Each step now logs when it starts, and the daemon moves on if it overruns its deadline
 * (the step keeps running in the background; its late result is ignored).
 */
export const STARTUP_STEP_DEADLINE_MS = 60_000;

export async function runStartupStep(
  name: string,
  step: () => Promise<unknown>,
  log: (line: string) => void,
  deadlineMs: number = STARTUP_STEP_DEADLINE_MS,
): Promise<void> {
  log(`[worker] startup: ${name}`);
  let timer: NodeJS.Timeout | undefined;
  const overran = new Promise<"overran">((resolve) => {
    timer = setTimeout(() => resolve("overran"), deadlineMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([step().then(() => "done" as const), overran]);
    if (outcome === "overran") log(`[worker] startup: ${name} still running after ${Math.round(deadlineMs / 1000)}s; continuing without waiting for it`);
  } catch (err) {
    log(`[worker] startup: ${name} failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
