function normalizePath(value) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isCheckoutBoundary(char) {
  return char === undefined || /[\s"'/:=]/.test(char);
}

export function commandLineBelongsToCheckout(commandLine, checkoutRoot) {
  if (!commandLine || !checkoutRoot) return false;
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
        parts[0]?.toLowerCase() === "tcp" &&
        parts[3] === "LISTENING" &&
        (parts[1]?.endsWith(`:${port}`) ?? false)
      )
      .map(parts => parts[4])
      .filter(p => p && /^\d+$/.test(p) && p !== "0")
  )];
}

export function planPortOwnerKill({ pid, port, checkoutRoot, getCommandLine, audit }) {
  const commandLine = getCommandLine(pid);
  if (!commandLine) {
    const event = { action: "dev-port-kill-blocked", port, pid, reason: "unknown-command-line" };
    audit?.(event);
    return { allowed: false, reason: "unknown-command-line", commandLine };
  }

  if (!commandLineBelongsToCheckout(commandLine, checkoutRoot)) {
    const event = { action: "dev-port-kill-blocked", port, pid, reason: "outside-checkout", checkoutRoot, commandLine };
    audit?.(event);
    return { allowed: false, reason: "outside-checkout", commandLine };
  }

  audit?.({ action: "dev-port-kill-allowed", port, pid, checkoutRoot, commandLine });
  return { allowed: true, reason: "inside-checkout", commandLine };
}
