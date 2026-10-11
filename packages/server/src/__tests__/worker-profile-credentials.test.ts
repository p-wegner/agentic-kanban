/**
 * #1331: a worker that KNOWS a profile's credentials are expired or missing attests that
 * state, and placement does not pick the worker for a profile it cannot run.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkerProfileAttestations } from "@agentic-kanban/shared/lib/worker-protocol";
import { parseRoster } from "@agentic-kanban/shared/lib/profile-roster";
import { createWorkerProfileAttestor } from "../worker/worker-profiles.js";
import { selectAttestedProfile } from "../lib/worker-profile-attestation.js";
import { checkProfileCredentials } from "../cli/commands/worker-doctor.js";

const NOW = Date.now();

function homeWith(files: Record<string, unknown | null>): string {
  const home = mkdtempSync(join(tmpdir(), "ak-1331-"));
  for (const [dir, creds] of Object.entries(files)) {
    mkdirSync(join(home, dir), { recursive: true });
    // `null` = a config dir holding only settings (so it is discovered) and no credentials file
    if (creds === null) writeFileSync(join(home, dir, "settings.json"), "{}");
    else writeFileSync(join(home, dir, ".credentials.json"), JSON.stringify(creds));
  }
  return home;
}

const live = { claudeAiOauth: { accessToken: "t", expiresAt: NOW + 3_600_000 } };
const refreshable = { claudeAiOauth: { accessToken: "t", refreshToken: "r", expiresAt: NOW - 3_600_000 } };
const expired = { claudeAiOauth: { accessToken: "t", expiresAt: NOW - 3_600_000 } };

describe("credential state attestation (#1331)", () => {
  const home = homeWith({ ".claude-live": live, ".claude-renew": refreshable, ".claude-old": expired, ".claude-gone": null });

  it("attests an expired credential file as not runnable and a live one as plain", () => {
    const attestor = createWorkerProfileAttestor({ home, log: () => {} });
    const byName = new Map(attestor.current(NOW).map((a) => [a.name, a]));
    expect(byName.get("old")?.credentials).toBe("expired");
    expect(byName.get("live")?.credentials).toBeUndefined();
    // #1399: expired access token + refresh token is renewed by claude itself
    expect(byName.get("renew")?.credentials).toBeUndefined();
    const gone = byName.get("gone");
    if (gone) expect(gone.credentials).toBe("missing");
  });

  it("does not mark an apiKeyHelper config dir as missing credentials", () => {
    const h = mkdtempSync(join(tmpdir(), "ak-1331-gw-"));
    mkdirSync(join(h, ".claude-gw"), { recursive: true });
    writeFileSync(join(h, ".claude-gw", "settings.json"), JSON.stringify({ apiKeyHelper: "node key.js" }));
    const attestor = createWorkerProfileAttestor({ home: h, log: () => {} });
    const gw = attestor.current(NOW).find((a) => a.name === "gw");
    if (gw) expect(gw.credentials).toBeUndefined();
  });

  it("survives the wire parse and drops unknown values", () => {
    const parsed = parseWorkerProfileAttestations([
      { provider: "claude", name: "a", credentials: "expired" },
      { provider: "claude", name: "b", credentials: "bogus" },
    ]);
    expect(parsed?.[0]?.credentials).toBe("expired");
    expect(parsed?.[1]?.credentials).toBeUndefined();
  });

  it("placement skips an expired profile and uses a runnable one", () => {
    const roster = parseRoster(JSON.stringify([
      { provider: "claude", name: "old" },
      { provider: "claude", name: "live" },
    ]));
    const attestations = [
      { provider: "claude", name: "old", role: "pool", credentials: "expired" as const },
      { provider: "claude", name: "live", role: "pool" },
    ];
    const both = selectAttestedProfile({ roster, attestations, prefMap: new Map(), nowMs: NOW });
    expect(both.selection?.name).toBe("live");

    const onlyExpired = selectAttestedProfile({
      roster,
      attestations: attestations.slice(0, 1),
      prefMap: new Map(),
      nowMs: NOW,
    });
    expect(onlyExpired.selection).toBeNull();
  });

  it("worker doctor WARNs once per unrunnable profile the worker uses", () => {
    const checks = checkProfileCredentials(home, NOW, ["old", "live"], "linux");
    const old = checks.find((c) => c.name === "profile old");
    expect(old?.status).toBe("warn");
    expect(old?.remedy).toContain('CLAUDE_CONFIG_DIR="');
    expect(checks.some((c) => c.name === "profile live")).toBe(false);
  });

  it("prints the PowerShell remedy on Windows (#1359)", () => {
    const old = checkProfileCredentials(home, NOW, ["old"], "win32").find((c) => c.name === "profile old");
    expect(old?.remedy).toContain("$env:CLAUDE_CONFIG_DIR='");
    expect(old?.remedy).toContain("; claude /login");
  });

  it("does not WARN for profiles the worker never uses; lists them once at INFO (#1359)", () => {
    const checks = checkProfileCredentials(home, NOW, []);
    expect(checks.some((c) => c.status === "warn")).toBe(false);
    const other = checks.filter((c) => c.name === "other profiles");
    expect(other).toHaveLength(1);
    expect(other[0]?.detail).toContain("old (expired)");
  });
});
