function normalizePath(value) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isCheckoutBoundary(char) {
  return char === undefined || /[\s"'/:=]/.test(char);
}

export function commandLineBelongsToCheckout(commandLine, checkoutRoot, processCwd) {
  if (!commandLine || !checkoutRoot) return false;

  // The process's own command line only proves the checkout when the script path in it is
  // ABSOLUTE. A process launched with a RELATIVE script path (e.g. someone typing
  // `node packages/server/dist/cli/index.js dev` from inside the checkout during manual
  // recovery, rather than promote.mjs's own spawn, which always uses an absolute path) carries
  // none of the checkout root in its command line at all — the substring match below can never
  // find it, and a genuinely-safe process gets refused (#1159). The process's ACTUAL working
  // directory is the ground truth for "which checkout did this relative path resolve against",
  // so when the caller can supply it, a cwd match is accepted on its own.
  if (processCwd && normalizePath(processCwd) === normalizePath(checkoutRoot)) return true;

  const normalizedCommand = normalizePath(commandLine);
  const normalizedRoot = normalizePath(checkoutRoot);
  let index = normalizedCommand.indexOf(normalizedRoot);

  while (index !== -1) {
    const before = normalizedCommand[index - 1];
    const after = normalizedCommand[index + normalizedRoot.length];
    const startsAtBoundary = isCheckoutBoundary(before);
    const endsAtBoundary = isCheckoutBoundary(after);
    if (startsAtBoundary && endsAtBoundary) return true;
    index = normalizedCommand.indexOf(normalizedRoot, index + normalizedRoot.length);
  }

  return false;
}

/**
 * Is this split netstat row a TCP row in the LISTENING state? (#1035)
 *
 * Windows LOCALIZES the state column — German prints `ABHÖREN`, not `LISTENING` —
 * so matching the English literal returns nothing at all on a non-English box, and
 * every port lookup here then answers "nobody is listening". The locale-independent
 * signal is the FOREIGN address: a listening socket carries the wildcard
 * (`0.0.0.0:0`, `[::]:0`, `*:*`), while every established/waiting row carries a real
 * peer endpoint. The English literal is still accepted so the intent stays readable.
 *
 * @param {string[]} parts A netstat line already trimmed and split on whitespace.
 */
export function isNetstatListeningRow(parts) {
  if (parts[0]?.toLowerCase() !== "tcp") return false;
  if (/^listen/i.test(parts[3] ?? "")) return true;
  const foreign = parts[2] ?? "";
  return foreign === "0.0.0.0:0" || foreign === "[::]:0" || foreign === "*:*";
}

/**
 * Parse Windows netstat -ano output and return PIDs that are LISTENING on `port`.
 * Excludes processes with established connections TO the port (e.g. Vite proxying
 * to the backend server), which is the root cause of the bug where freePort(3001)
 * killed the Vite client process.
 */
export function parseNetstatListeners(netstatOutput, port) {
  return [...new Set(
    netstatOutput.split("\n")
      .map(l => l.trim().split(/\s+/))
      .filter(parts =>
        isNetstatListeningRow(parts) &&
        (parts[1]?.endsWith(`:${port}`) ?? false)
      )
      .map(parts => parts[4])
      .filter(p => p && /^\d+$/.test(p) && p !== "0")
  )];
}

export function planPortOwnerKill({ pid, port, checkoutRoot, getCommandLine, getCwd, audit }) {
  const commandLine = getCommandLine(pid);
  if (!commandLine) {
    const event = { action: "dev-port-kill-blocked", port, pid, reason: "unknown-command-line" };
    audit?.(event);
    return { allowed: false, reason: "unknown-command-line", commandLine };
  }

  // Best-effort only: a getCwd that throws or returns nothing just falls back to the
  // command-line-only check, which is today's behaviour.
  let processCwd;
  try {
    processCwd = getCwd?.(pid) || undefined;
  } catch {
    processCwd = undefined;
  }

  if (!commandLineBelongsToCheckout(commandLine, checkoutRoot, processCwd)) {
    const event = { action: "dev-port-kill-blocked", port, pid, reason: "outside-checkout", checkoutRoot, commandLine };
    audit?.(event);
    return { allowed: false, reason: "outside-checkout", commandLine };
  }

  audit?.({ action: "dev-port-kill-allowed", port, pid, checkoutRoot, commandLine });
  return { allowed: true, reason: "inside-checkout", commandLine };
}
