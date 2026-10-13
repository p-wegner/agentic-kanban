// #1450 — the connect runbook's first live run: old installs, a revoked pairing, corrupt clones, profiles.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConnectRunbook, buildStartFlags } from "../lib/worker-connect-runbook.js";
import { parseConnectOptions } from "../routes/worker-connect.js";
import { moveAsideRevokedPairing, probeSavedPairing } from "../worker/worker-revoked-pairing.js";
import { loadState, saveIdentity } from "../worker/worker-state.js";
import { checkAttestedProfiles } from "../cli/commands/worker-doctor-harness.js";
import type { LocalProfile } from "../lib/local-profile-discovery.js";

const base = { fleetUrl: "http://100.1.2.3:3003", pairingToken: "tok-1", code: "c0de" };
const ids = (r: ReturnType<typeof buildConnectRunbook>) => r.steps.map((s) => s.id);

describe("runbook (#1450)", () => {
  it("renders --providers/--profiles into the start command and the service step", () => {
    const options = { os: "windows" as const, providers: ["claude"], profiles: ["anth"] };
    expect(buildStartFlags(["http://b"], options).join(" ")).toContain("--providers claude --profiles anth");
    const r = buildConnectRunbook({ ...base, options });
    const service = r.steps.find((s) => s.id === "service")!;
    expect(service.commands.join("\n")).toContain("--providers claude --profiles anth");
    expect(r.markdown).toContain("--providers claude --profiles anth");
    expect(r.steps.find((s) => s.id === "doctor")!.commands[0]).toContain("--profiles anth");
  });

  it("omits both flags when the operator picks nothing, and warns in the doctor step", () => {
    const r = buildConnectRunbook({ ...base, options: { os: "unix" } });
    expect(r.markdown).not.toContain("--profiles anth");
    expect(buildStartFlags(["http://b"], { os: "unix" }).join(" ")).not.toContain("--profiles");
    expect(r.steps.find((s) => s.id === "doctor")!.expect).toContain("every local login");
  });

  it.each(["windows", "unix", "wsl"] as const)("%s: stops old installs first, checks clones and login before the service, verifies the daemon after", (os) => {
    const r = buildConnectRunbook({ ...base, options: { os, profiles: ["anth"] } });
    const order = ids(r);
    expect(order.indexOf("existing-install")).toBeGreaterThan(order.indexOf("preconditions"));
    expect(order.indexOf("existing-install")).toBeLessThan(order.indexOf("install-build"));
    expect(order.indexOf("repo-check")).toBeLessThan(order.indexOf("service"));
    expect(order.indexOf("login")).toBeLessThan(order.indexOf("service"));
    expect(order.indexOf("verify-daemon")).toBe(order.indexOf("service") + 1);
    expect(r.steps.find((s) => s.id === "repo-check")!.commands).toEqual(["agentic-kanban-worker repo-check --quarantine"]);
    const verify = r.steps.find((s) => s.id === "verify-daemon")!;
    expect(verify.detail).toContain("--profiles anth");
    const existing = r.steps.find((s) => s.id === "existing-install")!;
    expect(existing.detail).toContain("ask");
    expect(existing.commands.join("\n")).toMatch(os === "windows" ? /Get-ScheduledTask[\s\S]*Win32_Process/ : /systemctl[\s\S]*pgrep/);
  });

  it("names the human steps up front and uses the worker's own auth command", () => {
    const r = buildConnectRunbook({ ...base, options: { os: "unix", providers: ["claude"] } });
    const upfront = r.markdown.indexOf("## What you will need from the operator");
    expect(upfront).toBeGreaterThan(0);
    expect(upfront).toBeLessThan(r.markdown.indexOf("## Steps"));
    expect(r.steps.find((s) => s.id === "login")!.humanCommand).toContain("agentic-kanban-worker auth claude");
    expect(r.steps.find((s) => s.id === "login")!.check).toBe("agentic-kanban-worker doctor --providers claude");
  });

  it("parses and allowlists providers/profiles from the mint body", () => {
    const o = parseConnectOptions({ os: "windows", providers: "claude", profiles: "anth, claude:anth" });
    expect(o.providers).toEqual(["claude"]);
    expect(o.profiles).toEqual(["anth", "claude:anth"]);
    expect(() => parseConnectOptions({ profiles: "a;rm -rf /" })).toThrow();
    expect(() => parseConnectOptions({ providers: "Claude Code" })).toThrow();
  });
});

describe("doctor attested profiles (#1450)", () => {
  const p = (name: string): LocalProfile => ({ provider: "claude", name, kind: "claude-config-dir", path: `/x/${name}` });
  const found = [p("anth"), p("zai"), p("team1")];

  it("warns and lists every login when --profiles is absent", () => {
    const c = checkAttestedProfiles(found, undefined);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("claude:zai");
    expect(c.remedy).toContain("--profiles");
  });

  it("passes with exactly the chosen set, warns on a name with no login", () => {
    const ok = checkAttestedProfiles(found, ["anth"]);
    expect(ok.status).toBe("pass");
    expect(ok.detail).toContain("claude:anth");
    expect(ok.detail).not.toContain("zai");
    expect(checkAttestedProfiles(found, ["anth", "ghost"]).status).toBe("warn");
  });
});

describe("revoked pairing (#1450)", () => {
  let dir: string;
  let stateFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ak-worker-revoked-"));
    stateFile = join(dir, "worker-state.json");
    saveIdentity(stateFile, "http://board:3003", { workerId: "w-old", workerToken: "t-old", name: "box" });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const answering = (status: number) => vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;

  it("moves a state the board rejects (401) aside, forgets the identity, and says so", async () => {
    const log = vi.fn();
    const aside = await moveAsideRevokedPairing({ stateFile, boardUrls: ["http://board:3003"], log, fetchImpl: answering(401), nowMs: 42 });
    expect(aside).toBe(`${stateFile}.revoked-42`);
    expect(JSON.parse(readFileSync(aside!, "utf8")).boards["http://board:3003"].workerId).toBe("w-old");
    expect(Object.keys(loadState(stateFile).boards)).toHaveLength(0);
    expect(log.mock.calls[0]![0]).toContain("w-old was revoked");
  });

  it("leaves a valid pairing alone", async () => {
    expect(await moveAsideRevokedPairing({ stateFile, boardUrls: ["http://board:3003"], log: vi.fn(), fetchImpl: answering(200) })).toBeNull();
    expect(Object.keys(loadState(stateFile).boards)).toHaveLength(1);
    expect(existsSync(`${stateFile}.revoked-0`)).toBe(false);
  });

  it("does nothing when the board cannot be reached or nothing is paired", async () => {
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect((await probeSavedPairing(stateFile, ["http://board:3003"], down)).verdict).toBe("unreachable");
    expect(await moveAsideRevokedPairing({ stateFile, boardUrls: ["http://board:3003"], log: vi.fn(), fetchImpl: down })).toBeNull();
    expect(existsSync(stateFile)).toBe(true);
    expect((await probeSavedPairing(join(dir, "none.json"), ["http://board:3003"], down)).verdict).toBe("none");
  });
});
