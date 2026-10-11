/**
 * #1379 — `--profile-alias default=anth`: a worker attests its default (or custom) login
 * under a profile name, resolves an assign naming it to the REAL dir, and the board explains
 * the fix when a roster is the only thing excluding the worker.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerLaunchSpec } from "@agentic-kanban/shared/lib/worker-protocol";
import { aliasSourceDir, discoverLocalProfiles, parseProfileAliases } from "../lib/local-profile-discovery.js";
import { applyProfileToSpec, createWorkerProfileAttestor } from "../worker/worker-profiles.js";
import { aliasHint } from "../services/worker-profile-placement.service.js";
import { checkProfileCredentials } from "../cli/commands/worker-doctor.js";
import { loadProfileAliases, saveProfileAliases } from "../worker/worker-profile-aliases.js";

describe("profile alias (#1379)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ak-alias-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: Date.now() + 3_600_000 } }),
    );
  });

  it("parses entries and drops malformed ones", () => {
    expect(parseProfileAliases(["default=anth", "bad", "=x", "y="])).toEqual([{ source: "default", name: "anth" }]);
  });

  it("maps default to ~/.claude, a name to ~/.claude-<name>, a path to itself", () => {
    expect(aliasSourceDir("default", home)).toBe(join(home, ".claude"));
    expect(aliasSourceDir("work", home)).toBe(join(home, ".claude-work"));
    expect(aliasSourceDir(join(home, "custom"), home)).toBe(join(home, "custom"));
  });

  it("without an alias the default login is not discoverable; with one it is, pointing at the real dir", () => {
    expect(discoverLocalProfiles(home)).toEqual([]);
    const found = discoverLocalProfiles(home, parseProfileAliases(["default=anth"]));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ provider: "claude", name: "anth", path: join(home, ".claude"), aliasOf: "default" });
  });

  it("attests the alias with aliasOf, and still reports credential state of the real dir", () => {
    const attestor = createWorkerProfileAttestor({ home, aliases: parseProfileAliases(["default=anth"]), log: () => {} });
    expect(attestor.current()[0]).toMatchObject({ provider: "claude", name: "anth", aliasOf: "default" });
    expect(attestor.current()[0].credentials).toBeUndefined();
    // Expire the real dir's login: the alias must surface it.
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: 1 } }),
    );
    expect(attestor.current()[0].credentials).toBe("expired");
  });

  it("an alias to a missing dir attests nothing", () => {
    const attestor = createWorkerProfileAttestor({ home, aliases: parseProfileAliases(["nope=ghost"]), log: () => {} });
    expect(attestor.current()).toEqual([]);
  });

  it("resolve: an assign naming the alias runs with the default dir as CLAUDE_CONFIG_DIR", () => {
    const spec: WorkerLaunchSpec = { command: "claude", args: [], env: {}, intent: { provider: "claude", profile: "anth" } } as unknown as WorkerLaunchSpec;
    const aliases = parseProfileAliases(["default=anth"]);
    const ok = applyProfileToSpec(spec, { home, aliases });
    expect(ok.ok && ok.spec.env?.CLAUDE_CONFIG_DIR).toBe(join(home, ".claude"));
    const refused = applyProfileToSpec(spec, { home });
    expect(refused.ok).toBe(false);
  });

  it("persists aliases in the worker state without disturbing pairings", () => {
    const stateFile = join(home, "state.json");
    writeFileSync(stateFile, JSON.stringify({ boards: { b: { workerId: "w", workerToken: "t", name: "n" } } }));
    saveProfileAliases(stateFile, ["default=anth"]);
    expect(loadProfileAliases(stateFile)).toEqual(["default=anth"]);
    saveProfileAliases(stateFile, []);
    expect(loadProfileAliases(stateFile)).toEqual([]);
  });

  it("doctor shows the alias", () => {
    const checks = checkProfileCredentials(home, undefined, [], "linux", ["default=anth"]);
    expect(checks.find((c) => c.name === "profile alias anth")?.status).toBe("pass");
  });

  it("explain hint names the permitted profile and the alias flag", () => {
    expect(aliasHint(["claude:anth", "claude:the-org"])).toContain("--profile-alias default=anth");
    expect(aliasHint(["codex:x"])).toBe("");
  });
});
