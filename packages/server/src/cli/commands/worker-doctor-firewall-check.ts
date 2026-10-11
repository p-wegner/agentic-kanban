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

export interface FirewallListTimeout {
  timedOut: true;
  elapsedMs: number;
}

/** `null` = PowerShell/NetSecurity unavailable; `FirewallListTimeout` = it ran but was too slow. */
export type FirewallRuleLister = (
  ports?: number[],
) => Promise<FirewallRuleInfo[] | FirewallListTimeout | FirewallListPartial | null>;

/** Normalise a firewall remote address to `a.b.c.d/prefix` (CIDR or dotted-mask form); other values pass through. */
export function normalizeRemoteAddress(addr: string): string {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,3}(?:\.\d{1,3}){3}|\d{1,2})$/.exec(addr.trim());
  if (!m) return addr.trim();
  const mask = m[2] as string;
  if (!mask.includes(".")) return `${m[1]}/${Number(mask)}`;
  let bits = 0;
  let seenZero = false;
  for (const octet of mask.split(".").map(Number)) {
    for (let i = 7; i >= 0; i--) {
      if ((octet >> i) & 1) {
        if (seenZero) return addr.trim(); // non-contiguous mask
        bits++;
      } else seenZero = true;
    }
  }
  return `${m[1]}/${bits}`;
}

/** 100.64.0.0/10 = 100.64.0.0 - 100.127.255.255. */
export function isTailnetAddress(host: string | null | undefined): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec((host ?? "").trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Query from the port side (#1357): one bulk `Get-NetFirewallPortFilter -Protocol TCP`, narrowed to
 * the ports we care about, then only those rules (per-rule piping of every inbound rule took ~65 s
 * on a 372-rule box).
 */
export function buildPsList(ports: number[]): string {
  const list = ports.map((p) => `'${Math.trunc(p)}'`).join(",");
  // #1361: unelevated, `Get-NetFirewallPortFilter -Protocol TCP` returns 0 objects and the
  // unfiltered bulk call raises access-denied on part of the store, so neither can prove "no rule".
  // Rules are therefore the union of (a) the script's own `agentic-kanban*` rules, resolved per rule
  // (works unelevated, few rules) and (b) a bulk port-filter scan. Errors from either are captured and
  // returned as `partial` instead of being swallowed.
  return (
    `$w=@(${list});$e1=@();$e2=@();` +
    "$pf=@(Get-NetFirewallPortFilter -ErrorAction SilentlyContinue -ErrorVariable e1 | Where-Object {" +
    "@($_.LocalPort | Where-Object { $w -contains [string]$_ }).Count -gt 0 });" +
    "$r1=@($pf | Get-NetFirewallRule -ErrorAction SilentlyContinue -ErrorVariable +e1);" +
    "$r2=@(Get-NetFirewallRule -DisplayName 'agentic-kanban*' -ErrorAction SilentlyContinue -ErrorVariable e2);" +
    "$all=@(@($r1)+@($r2) | Where-Object { $_.Direction -eq 'Inbound' } | Sort-Object -Property Name -Unique);" +
    "$o=@($all | ForEach-Object {" +
    "$p=($_|Get-NetFirewallPortFilter).LocalPort;$a=($_|Get-NetFirewallAddressFilter).RemoteAddress;" +
    "[pscustomobject]@{name=$_.DisplayName;enabled=($_.Enabled -eq 'True');allow=($_.Action -eq 'Allow');" +
    "ports=@($p|ForEach-Object{[string]$_});remote=@($a|ForEach-Object{[string]$_})}});" +
    "$errs=@(@($e1)+@($e2) | ForEach-Object { [string]$_.Exception.Message } | Select-Object -Unique);" +
    "$errs=@($errs | Where-Object { $_ -notmatch 'No MSFT_NetFirewall' });" +
    "[pscustomobject]@{rules=$o;errors=$errs} | ConvertTo-Json -Compress -Depth 5"
  );
}

/** The query ran but part of the store was unreadable (e.g. access denied when not elevated). */
export interface FirewallListPartial {
  partial: true;
  rules: FirewallRuleInfo[];
  reason: string;
}

const PS_TIMEOUT_MS = 20_000;

/** Real lister: null when PowerShell or the NetSecurity cmdlets are unavailable; a timeout is reported as one. */
export const listFirewallRulesViaPowerShell: FirewallRuleLister = (ports = []) =>
  new Promise((resolve) => {
    const started = Date.now();
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", buildPsList(ports)],
      { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          if (e.killed || e.signal) return resolve({ timedOut: true, elapsedMs: Date.now() - started });
          return resolve(null);
        }
        try {
          const parsed = JSON.parse(stdout || "{}") as {
            rules?: Array<{ name: string; enabled: boolean; allow: boolean; ports: string[]; remote: string[] }> | null;
            errors?: string[] | string | null;
          };
          const rules: FirewallRuleInfo[] = [parsed.rules ?? []].flat().map((r) => ({
            name: r.name,
            enabled: r.enabled,
            allow: r.allow,
            inbound: true,
            ports: r.ports ?? [],
            remoteAddresses: r.remote ?? [],
          }));
          const errors = [parsed.errors ?? []].flat().filter(Boolean);
          resolve(errors.length > 0 ? { partial: true, rules, reason: errors[0] as string } : rules);
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
    (r) => r.ports.includes(String(port)) && r.remoteAddresses.length > 0 && r.remoteAddresses.every((a) => normalizeRemoteAddress(a) === TAILNET_CIDR),
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
  const listed = await list(targets.map((t) => t.port as number));
  const isPartial = listed !== null && !Array.isArray(listed) && "partial" in listed;
  const partialReason = isPartial ? (listed as FirewallListPartial).reason : null;
  const rules = isPartial ? (listed as FirewallListPartial).rules : (listed as FirewallRuleInfo[] | FirewallListTimeout | null);
  if (rules !== null && !Array.isArray(rules)) {
    return [
      {
        name: "tailnet firewall rules",
        status: "unknown",
        detail: `reading Windows Firewall rules timed out after ${(rules.elapsedMs / 1000).toFixed(1)}s`,
        remedy: "Run `powershell scripts/fleet-firewall.ps1 -Status` to check by hand.",
      },
    ];
  }
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
    if (partialReason !== null) {
      // A denied/partial read cannot prove absence: never report it as "no rule" (#1361).
      return {
        name,
        status: "unknown",
        detail: `could not read all Windows Firewall rules (${partialReason}) - no scoped rule seen for port ${t.port}, but absence is unproven`,
        remedy: "Run `powershell scripts/fleet-firewall.ps1 -Status` (elevated) to check by hand.",
      };
    }
    if (found) {
      return {
        name,
        status: "warn",
        detail: `an inbound allow rule exists but is not scoped to ${TAILNET_CIDR} - it may expose the port to LAN/wifi`,
        remedy: "Re-run `scripts/fleet-firewall.ps1 -Install` from an elevated shell, and remove the broader rule (`agentic-kanban worker setup --guide`, section 6).",
      };
    }
    return {
      name,
      status: "warn",
      detail: `${t.host}:${t.port} is a tailnet address but no inbound firewall rule allows it - tailnet workers will time out`,
      remedy: "Run `scripts/fleet-firewall.ps1 -Install` from an elevated PowerShell (`agentic-kanban worker setup --guide`, section 6).",
    };
  });
}
