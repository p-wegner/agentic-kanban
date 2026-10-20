// Types for promote-startup-retry.mjs (#1651).
export const STARTUP_RETRY_TIMEOUT_MS: number;
export const STARTUP_RETRY_INTERVAL_MS: number;
export function isStartupNotReady(res: Response | null | undefined): Promise<boolean>;
export function fetchWhileStarting(
  doFetch: () => Promise<Response>,
  opts?: { sleep?: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number; nowMs?: () => number },
): Promise<Response>;
