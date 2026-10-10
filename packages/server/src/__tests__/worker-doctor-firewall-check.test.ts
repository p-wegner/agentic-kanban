import { describe, expect, it } from "vitest";
import {
  buildPsList,
  checkTailnetFirewall,
  isTailnetAddress,
  normalizeRemoteAddress,
  type FirewallRuleInfo,
} from "../cli/commands/worker-doctor-firewall-check.js";

const rule = (over: Partial<FirewallRuleInfo>): FirewallRuleInfo => ({
  name: "r",
  enabled: true,
  allow: true,
  inbound: true,
  ports: ["3003"],
  remoteAddresses: ["100.64.0.0/10"],
  ...over,
});

const listeners = [
  { label: "fleet", host: "100.101.102.103", port: 3003 },
  { label: "git", host: "100.101.102.103", port: 3002 },
];

describe("isTailnetAddress", () => {
  it("matches 100.64.0.0/10 only", () => {
    expect(isTailnetAddress("100.64.0.1")).toBe(true);
    expect(isTailnetAddress("100.127.255.255")).toBe(true);
    expect(isTailnetAddress("100.63.0.1")).toBe(false);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
    expect(isTailnetAddress("127.0.0.1")).toBe(false);
    expect(isTailnetAddress(null)).toBe(false);
  });
});

describe("normalizeRemoteAddress", () => {
  it("normalises CIDR and dotted-mask forms to the same value", () => {
    expect(normalizeRemoteAddress("100.64.0.0/255.192.0.0")).toBe("100.64.0.0/10");
    expect(normalizeRemoteAddress("100.64.0.0/10")).toBe("100.64.0.0/10");
    expect(normalizeRemoteAddress("10.0.0.0/255.0.0.0")).toBe("10.0.0.0/8");
    expect(normalizeRemoteAddress("Any")).toBe("Any");
    expect(normalizeRemoteAddress("100.64.0.0/255.0.255.0")).toBe("100.64.0.0/255.0.255.0");
  });
});

describe("buildPsList", () => {
  it("queries from the port side, adds the script's own rules, and captures errors", () => {
    const ps = buildPsList([3003, 3002]);
    expect(ps).toContain("'3003','3002'");
    expect(ps).toContain("Get-NetFirewallRule -DisplayName 'agentic-kanban*'");
    expect(ps).toContain("-ErrorVariable");
    expect(ps).not.toContain("Get-NetFirewallPortFilter -Protocol TCP");
    expect(ps).not.toContain("Get-NetFirewallRule -Direction Inbound");
  });
});

describe("checkTailnetFirewall partial results (#1361)", () => {
  it("reports UNKN with the reason, never 'no rule', when the read was denied", async () => {
    const out = await checkTailnetFirewall(listeners, "win32", async () => ({
      partial: true,
      rules: [],
      reason: "Zugriff verweigert",
    }));
    expect(out.map((c) => c.status)).toEqual(["unknown", "unknown"]);
    expect(out[0]?.detail).toContain("Zugriff verweigert");
    expect(out[0]?.detail).not.toContain("no inbound firewall rule");
  });

  it("still passes a port whose scoped rule was seen despite a partial read", async () => {
    const out = await checkTailnetFirewall(listeners, "win32", async () => ({
      partial: true,
      rules: [rule({ ports: ["3003"] })],
      reason: "Zugriff verweigert",
    }));
    expect(out.map((c) => c.status)).toEqual(["pass", "unknown"]);
  });
});

describe("checkTailnetFirewall", () => {
  it("is skipped off Windows", async () => {
    let called = false;
    const out = await checkTailnetFirewall(listeners, "linux", async () => ((called = true), []));
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("is skipped when no listener is tailnet-bound", async () => {
    const out = await checkTailnetFirewall([{ label: "fleet", host: "127.0.0.1", port: 3003 }], "win32", async () => []);
    expect(out).toEqual([]);
  });

  it("warns when no rule exists", async () => {
    const out = await checkTailnetFirewall(listeners, "win32", async () => []);
    expect(out.map((c) => c.status)).toEqual(["warn", "warn"]);
    expect(out[0]?.remedy).toContain("fleet-firewall.ps1 -Install");
  });

  it("passes with tailnet-scoped rules and warns on a profile-wide one", async () => {
    const out = await checkTailnetFirewall(listeners, "win32", async () => [
      rule({ ports: ["3003"] }),
      rule({ ports: ["3002"], remoteAddresses: ["Any"] }),
    ]);
    expect(out[0]?.status).toBe("pass");
    expect(out[1]?.status).toBe("warn");
    expect(out[1]?.detail).toContain("not scoped");
  });

  it("ignores disabled and block rules", async () => {
    const out = await checkTailnetFirewall(listeners.slice(0, 1), "win32", async () => [
      rule({ enabled: false }),
      rule({ allow: false }),
    ]);
    expect(out[0]?.status).toBe("warn");
  });

  it("accepts the dotted-mask form Windows returns for the /10 range", async () => {
    const out = await checkTailnetFirewall(listeners.slice(0, 1), "win32", async () => [
      rule({ remoteAddresses: ["100.64.0.0/255.192.0.0"] }),
    ]);
    expect(out[0]?.status).toBe("pass");
  });

  it("reports a timeout as a timeout with the elapsed time, not as unavailable", async () => {
    const out = await checkTailnetFirewall(listeners, "win32", async () => ({ timedOut: true, elapsedMs: 20_400 }));
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("unknown");
    expect(out[0]?.detail).toContain("timed out after 20.4s");
    expect(out[0]?.detail).not.toContain("unavailable");
  });

  it("passes the listener ports to the lister", async () => {
    let seen: number[] | undefined;
    await checkTailnetFirewall(listeners, "win32", async (p) => ((seen = p), []));
    expect(seen).toEqual([3003, 3002]);
  });

  it("reports unknown when rules cannot be read", async () => {
    const out = await checkTailnetFirewall(listeners, "win32", async () => null);
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("unknown");
  });
});
