/**
 * `worker doctor-board` firewall check (#1326): a listener bound to a tailnet address on
 * Windows needs an inbound allow rule before a tailnet worker can reach it, and that rule must be
 * scoped to 100.64.0.0/10 (docs/worker-fleet.md section 6). `scripts/fleet-firewall.ps1 -Install`
 * creates rules named `agentic-kanban fleet <port>` / `agentic-kanban git <port>`.
 *
 * WARN, never fail: the check cannot see third-party firewalls, and a loopback-only fleet needs
 * no rule at all. Skipped entirely off Windows and for non-tailnet hosts.
 */
import { execFile } from "node:child_process";
import type { DoctorCheck } from "./worker-doctor.js";

export const TAILNET_CIDR = "100.64.0.0/10";

export interface FirewallRuleInfo {
  name: string;
  enabled: boolean;
  allow: boolean;
  inbound: boolean;
  ports: string[];
  remoteAddresses: string[];
}

export type FirewallRuleLister = () => Promise<FirewallRuleInfo[] | null>;

/** 100.64.0.0/10 = 100.64.0.0 - 100.127.255.255. */
export function isTailnetAddress(host: string | null | undefined): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec((host ?? "").trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

const PS_LIST =
  "$o=@(Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue | ForEach-Object {" +
  "$p=($_|Get-NetFirewallPortFilter).LocalPort;$a=($_|Get-NetFirewallAddressFilter).RemoteAddress;" +
  "[pscustomobject]@{name=$_.DisplayName;enabled=($_.Enabled -eq 'True');allow=($_.Action -eq 'Allow');" +
  "ports=@($p|ForEach-Object{[string]$_});remote=@($a|ForEach-Object{[string]$_})}});" +
  "ConvertTo-Json -InputObject $o -Compress -Depth 4";

/** Real lister: null when PowerShell or the NetSecurity cmdlets are unavailable. */
export const listFirewallRulesViaPowerShell: FirewallRuleLister = () =>
  new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PS_LIST],
      { timeout: 20_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const raw = JSON.parse(stdout || "[]") as Array<{
            name: string; enabled: boolean; allow: boolean; ports: string[]; remote: string[];
          }>;
          resolve(
            raw.map((r) => ({
              name: r.name,
              enabled: r.enabled,
              allow: r.allow,
              inbound: true,
              ports: r.ports ?? [],
              remoteAddresses: r.remote ?? [],
            })),
          );
        } catch {
          resolve(null);
        }
      },
    );
  });

/** Is there an enabled inbound allow rule for `port` whose remote scope is exactly the tailnet range? */
export function findTailnetRule(rules: FirewallRuleInfo[], port: number): { scoped: boolean; found: boolean } {
  const hits = rules.filter(
    (r) => r.enabled && r.allow && r.inbound && r.ports.some((p) => p === String(port) || p === "Any"),
  );
  const scoped = hits.some(
    (r) => r.ports.includes(String(port)) && r.remoteAddresses.length > 0 && r.remoteAddresses.every((a) => a === TAILNET_CIDR || a === "100.64.0.0/255.192.0.0"),
  );
  return { found: hits.length > 0, scoped };
}

export interface ListenerEndpoint {
  label: string;
  host: string | null | undefined;
  port: number | null | undefined;
}

export async function checkTailnetFirewall(
  listeners: ListenerEndpoint[],
  platform: NodeJS.Platform = process.platform,
  list: FirewallRuleLister = listFirewallRulesViaPowerShell,
): Promise<DoctorCheck[]> {
  if (platform !== "win32") return [];
  const targets = listeners.filter((l) => l.port && isTailnetAddress(l.host));
  if (targets.length === 0) return [];
  const rules = await list();
  if (rules === null) {
    return [
      {
        name: "tailnet firewall rules",
        status: "unknown",
        detail: "could not read Windows Firewall rules (PowerShell/NetSecurity unavailable)",
        remedy: "Run `powershell scripts/fleet-firewall.ps1 -Status` to check by hand.",
      },
    ];
  }
  return targets.map((t): DoctorCheck => {
    const name = `firewall ${t.label} port ${t.port}`;
    const { found, scoped } = findTailnetRule(rules, t.port as number);
    if (scoped) return { name, status: "pass", detail: `inbound allow rule scoped to ${TAILNET_CIDR}` };
    if (found) {
      return {
        name,
        status: "warn",
        detail: `an inbound allow rule exists but is not scoped to ${TAILNET_CIDR} - it may expose the port to LAN/wifi`,
        remedy: "Re-run `scripts/fleet-firewall.ps1 -Install` from an elevated shell, and remove the broader rule (docs/worker-fleet.md section 6).",
      };
    }
    return {
      name,
      status: "warn",
      detail: `${t.host}:${t.port} is a tailnet address but no inbound firewall rule allows it - tailnet workers will time out`,
      remedy: "Run `scripts/fleet-firewall.ps1 -Install` from an elevated PowerShell (docs/worker-fleet.md section 6).",
    };
  });
}
