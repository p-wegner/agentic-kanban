// `KANBAN_FLEET_HOST=tailscale` (#1325): resolve the bind address from `tailscale ip -4` AT BIND
// TIME, so a re-addressed node needs no config edit.
//
// Refuse, never widen: when the address cannot be resolved (tailscaled down, CLI missing, no
// output) this THROWS. It must never fall back to loopback-as-if-it-worked or to every
// interface — the caller's retry loop treats the throw like any other "host not available yet".

import { execFileSync } from "node:child_process";

/** The literal config value that asks for tailnet resolution. */
export const TAILSCALE_HOST_KEYWORD = "tailscale";

export type TailscaleIpExec = () => string;

const defaultExec: TailscaleIpExec = () =>
  execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", timeout: 5000, windowsHide: true });

export function isTailscaleHost(host: string): boolean {
  return host.trim().toLowerCase() === TAILSCALE_HOST_KEYWORD;
}

/** First IPv4 address `tailscale ip -4` prints; throws a named error when there is none. */
export function resolveTailscaleIp4(exec: TailscaleIpExec = defaultExec): string {
  let out: string;
  try {
    out = exec();
  } catch (err) {
    throw new Error(
      `KANBAN_FLEET_HOST=tailscale: \`tailscale ip -4\` failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); ` +
        "refusing to bind any other interface",
    );
  }
  const ip = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^\d{1,3}(\.\d{1,3}){3}$/.test(l));
  if (!ip) {
    throw new Error(
      "KANBAN_FLEET_HOST=tailscale: `tailscale ip -4` printed no IPv4 address; refusing to bind any other interface",
    );
  }
  return ip;
}

/** Pass a literal host through; turn the `tailscale` keyword into the node's current address. */
export function resolveBindHost(host: string, exec?: TailscaleIpExec): string {
  return isTailscaleHost(host) ? resolveTailscaleIp4(exec) : host;
}
