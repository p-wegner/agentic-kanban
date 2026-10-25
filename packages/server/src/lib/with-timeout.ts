/** Thrown by `withTimeout` when the deadline passes before the promise settles (#1717). */
export class TimeoutError extends Error {
  constructor(readonly label: string, readonly ms: number) {
    super(`${label} did not settle within ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Settle within `ms` no matter what `promise` does. The underlying work is not cancelled (a promise
 * cannot be) — this only stops a caller, e.g. an HTTP handler, from waiting on it forever.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
