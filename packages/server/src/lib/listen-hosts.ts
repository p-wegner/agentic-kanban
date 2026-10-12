// Multi-address listener binding (#1337): `KANBAN_FLEET_HOST` / `KANBAN_GIT_HTTP_HOST` accept a
// comma-separated list (e.g. `tailscale,192.168.0.198`), and the listener binds every entry.
//
// The default stays tailnet-only / loopback: a LAN address is bound ONLY because an operator
// listed it. Both listeners are plaintext and the `assign` frame carries a board-authored
// setupScript, so a non-tailnet, non-loopback bind is an RCE channel for anyone on that segment —
// hence the loud startup warning below (docs/worker-fleet.md section 6 names the firewall rule).

import { isTailscaleHost, resolveBindHost } from "./tailscale-host.js";

/** 100.64.0.0/10 — the CGNAT range Tailscale assigns node addresses from. (The worker binary's doctor keeps its own copy: it must not pull this module into its graph.) */
export function isTailnetAddress(host: string | null | undefined): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec((host ?? "").trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

export function isLoopbackAddress(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Split a configured host value on commas: trimmed, empties dropped, duplicates removed, order kept. */
export function parseHostList(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const h = part.trim();
    if (h) seen.add(h);
  }
  return [...seen];
}

/** Resolve the `tailscale` keyword in every entry (throws like `resolveBindHost` when it cannot). */
export function resolveBindHosts(raw: string, resolve: (host: string) => string = resolveBindHost): string[] {
  const hosts = parseHostList(raw).map((h) => (isTailscaleHost(h) ? resolve(h) : h));
  return [...new Set(hosts)];
}

/** The bound addresses that are neither loopback nor tailnet — i.e. plaintext reachable on a LAN. */
export function exposedBindHosts(hosts: string[]): string[] {
  return hosts.filter((h) => !isLoopbackAddress(h) && !isTailnetAddress(h));
}

/** Log a loud warning for every address in `hosts` that is not loopback or tailnet. Returns the exposed list. */
export function warnOnNonTailnetBinds(logPrefix: string, hosts: string[]): string[] {
  const exposed = exposedBindHosts(hosts);
  if (exposed.length > 0) {
    console.warn(
      `${logPrefix} WARNING: binding ${exposed.join(", ")} - NOT a tailnet or loopback address. ` +
        "This listener is plaintext and the assign frame carries a board-authored setupScript, so anyone who can " +
        "read or inject traffic on that network can run code on a paired worker. Scope the firewall rule to that " +
        "subnet and the Private profile only (the adapter MUST be on the Private profile). " +
        "See docs/worker-fleet.md section 6.",
    );
  }
  return exposed;
}
