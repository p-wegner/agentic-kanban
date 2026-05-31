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
