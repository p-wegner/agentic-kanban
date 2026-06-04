const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [50, 100] as const;

function isBusyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? "";
  return (
    code === "SQLITE_BUSY" ||
    code === "EBUSY" ||
    message.includes("SQLITE_BUSY") ||
    message.includes("database is locked")
  );
}

/**
 * Wraps a DB operation with bounded SQLITE_BUSY retry and structured logging.
 *
 * Logs a [db-busy] line on each contention hit, retries up to MAX_ATTEMPTS
 * total (i.e. up to MAX_ATTEMPTS-1 retries), then re-throws the original error.
 * Happy-path overhead is a single try/catch — no observable behavior change.
 *
 * @param operation  Async callback containing the DB call(s).
 * @param context    Short label for the log line (e.g. "merge workspace xyz").
 */
export async function withDbRetry<T>(
  operation: () => Promise<T>,
  context = "db operation"
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (!isBusyError(err) || attempt === MAX_ATTEMPTS) {
        if (isBusyError(err)) {
          console.error(
            `[db-busy] ${context} — giving up after ${MAX_ATTEMPTS} attempts`
          );
        }
        throw err;
      }
      const delay = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
      console.error(
        `[db-busy] ${context} — retrying (attempt ${attempt}/${MAX_ATTEMPTS}) after ${delay}ms`
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  // unreachable — TypeScript needs an explicit throw
  throw new Error("withDbRetry: exceeded max attempts");
}
