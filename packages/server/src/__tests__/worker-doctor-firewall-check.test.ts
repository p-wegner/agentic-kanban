import { describe, expect, it } from "vitest";
import {
  checkTailnetFirewall,
  isTailnetAddress,
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

  it("reports unknown when rules cannot be read", async () => {
    const out = await checkTailnetFirewall(listeners, "win32", async () => null);
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("unknown");
  });
});
