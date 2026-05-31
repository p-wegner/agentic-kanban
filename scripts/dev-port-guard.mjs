function normalizePath(value) {
  return value.replace(/\\/g, "/").toLowerCase();
}

export function commandLineBelongsToCheckout(commandLine, checkoutRoot) {
  if (!commandLine || !checkoutRoot) return false;
  return normalizePath(commandLine).includes(normalizePath(checkoutRoot));
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
