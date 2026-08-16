// One way to turn an unknown thrown value into a string (#527).
//
// `err instanceof Error ? err.message : String(err)` was written out ~497 times
// across server, shared, mcp-server and client, plus three privately-named copies
// with identical bodies (`warningMessage`, `errorText`, `describeError`). Beyond the
// line count, having one implementation means the places that need MORE than the
// naive idiom — a `cause` chain, a libsql UNIQUE-constraint sniff — have somewhere
// to live instead of being re-derived at the one or two call sites that noticed.
//
// Pure: no node imports, safe from the client and from the shared barrel.

/** The message of a thrown value, however it was thrown. Never throws itself. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  // `String(x)` on a null-prototype object or a Symbol can throw; the whole point
  // of this helper is that error formatting never becomes the error.
  try {
    return String(err);
  } catch {
    return "[unstringifiable error]";
  }
}

/**
 * The message plus every `cause` in the chain, outermost first.
 *
 * The inline idiom never looked at `.cause`, so wrapped errors lost the only part
 * that said what actually went wrong — a driver error wrapped by a service reads as
 * the service's generic text. Cycle-safe and depth-capped.
 */
export function errorMessages(err: unknown, maxDepth = 8): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current != null && out.length < maxDepth && !seen.has(current)) {
    seen.add(current);
    const message = errorMessage(current);
    if (message && out[out.length - 1] !== message) out.push(message);
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return out;
}

/** The full chain as one line, e.g. `outer: inner: root`. */
export function errorChain(err: unknown, separator = ": "): string {
  return errorMessages(err).join(separator);
}
