// #875 — `worker doctor` inferred the provider login from ~/.claude, ignoring
// CLAUDE_CONFIG_DIR (and ~/.codex, ignoring CODEX_HOME).
//
// That is exactly backwards for a fleet worker: the Windows service pins
// CLAUDE_CONFIG_DIR per install, and the auth-rotation rings swap logins by pointing
// CLAUDE_CONFIG_DIR / CODEX_HOME at per-subscription directories — so the doctor
// inspected a directory the dispatched agent never authenticates from. The env var
// REPLACES the default directory wholesale (credentials sit directly in it; the table's
// `dir: ".claude"` fragment stops applying), each provider has its own rule, and the
// check output always names the consulted path and what selected it.
//
// Hermeticity: every case either passes an explicit `env` object or stubs the vars with
// vi.stubEnv — the live environment on a profile machine carries a REAL
// CLAUDE_CONFIG_DIR, which is the exact condition these tests must control (the pattern
// worker-doctor-lazy-transport-and-trust.test.ts established for the trust check).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDER_AUTH_DIR_RESOLVERS,
  resolveClaudeAuthDir,
  resolveCodexAuthDir,
  resolveProviderAuthDir,
} from "../cli/commands/worker-doctor-provider-auth.js";
import { PROVIDER_AUTH_FILES, checkProvider } from "../cli/commands/worker-doctor.js";

describe("provider auth-dir resolution (#875) — the env var replaces the default wholesale", () => {
  it("claude: CLAUDE_CONFIG_DIR wins, is used AS the dir (no .claude appended), and is named as the source", () => {
    const resolved = resolveClaudeAuthDir("/home/u", { CLAUDE_CONFIG_DIR: "/profiles/claude-team" });
    expect(resolved.dir).toBe("/profiles/claude-team");
    expect(resolved.dir).not.toContain(".claude");
    expect(resolved.source).toBe("CLAUDE_CONFIG_DIR");
  });

  it("claude: falls back to ~/.claude when the var is absent or blank", () => {
    expect(resolveClaudeAuthDir("/home/u", {})).toEqual({
      dir: join("/home/u", ".claude"),
      source: "the default ~/.claude",
    });
    // Blank/whitespace is not a configuration — same reading resolveListenHost applies.
    expect(resolveClaudeAuthDir("/home/u", { CLAUDE_CONFIG_DIR: "   " }).dir).toBe(join("/home/u", ".claude"));
  });

  it("codex: CODEX_HOME follows the same rule", () => {
    expect(resolveCodexAuthDir("/home/u", { CODEX_HOME: "/licenses/codex-2" })).toEqual({
      dir: "/licenses/codex-2",
      source: "CODEX_HOME",
    });
    expect(resolveCodexAuthDir("/home/u", {})).toEqual({
      dir: join("/home/u", ".codex"),
      source: "the default ~/.codex",
    });
  });

  it("each provider has its OWN rule — claude never reads CODEX_HOME and vice versa", () => {
    const env = { CLAUDE_CONFIG_DIR: "/claude-here", CODEX_HOME: "/codex-here" };
    expect(resolveProviderAuthDir("claude", ".claude", "/home/u", env).dir).toBe("/claude-here");
    expect(resolveProviderAuthDir("codex", ".codex", "/home/u", env).dir).toBe("/codex-here");
  });

  it("a provider without a rule keeps the home-relative table default", () => {
    const resolved = resolveProviderAuthDir("copilot", ".copilot", "/home/u", {
      CLAUDE_CONFIG_DIR: "/claude-here",
    });
    expect(resolved.dir).toBe(join("/home/u", ".copilot"));
    expect(resolved.source).toContain(".copilot");
  });
});

describe("checkProvider consults the env-resolved dir and NAMES it (#875)", () => {
  let home: string;
  let relocated: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ak-doctor-auth-home-"));
    relocated = mkdtempSync(join(tmpdir(), "ak-doctor-auth-cfg-"));
    // Pin BOTH vars: the runner's live env may carry real values (profile sessions do),
    // and an unstubbed leak is exactly the bug class this ticket fixes.
    vi.stubEnv("CLAUDE_CONFIG_DIR", relocated);
    vi.stubEnv("CODEX_HOME", join(relocated, "codex"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(relocated, { recursive: true, force: true });
  });

  // `node` stands in for a provider CLI that exists on any test runner (the established
  // trick in worker-doctor.test.ts); a temporary resolver routes it through the env var
  // machinery so no real provider CLI is needed.
  function withFakeProvider<T>(run: () => Promise<T>): Promise<T> {
    PROVIDER_AUTH_FILES.node = { dir: ".node-auth", files: ["auth.json"], loginCommand: "node --login" };
    PROVIDER_AUTH_DIR_RESOLVERS.node = (h, env = process.env) => {
      const dir = env.NODE_AUTH_DIR?.trim();
      return dir ? { dir, source: "NODE_AUTH_DIR" } : { dir: join(h, ".node-auth"), source: "the default ~/.node-auth" };
    };
    return run().finally(() => {
      delete PROVIDER_AUTH_FILES.node;
      delete PROVIDER_AUTH_DIR_RESOLVERS.node;
    });
  }

  it("finds the login in the env-named dir, and the PASS names both path and source", () =>
    withFakeProvider(async () => {
      const authDir = join(relocated, "node-auth");
      mkdirSync(authDir, { recursive: true });
      writeFileSync(join(authDir, "auth.json"), "{}");
      vi.stubEnv("NODE_AUTH_DIR", authDir);
      // The home dir holds NOTHING — a pass can only come from the env-resolved dir.
      const checks = await checkProvider("node", home);
      const login = checks.find((c) => c.name === "node logged in");
      expect(login?.status).toBe("pass");
      expect(login?.detail).toContain(authDir);
      expect(login?.detail).toContain("NODE_AUTH_DIR");
    }));

  it("an UNKNOWN names the env-resolved dir it consulted, not the home default it skipped", () =>
    withFakeProvider(async () => {
      const emptyDir = join(relocated, "empty-auth");
      mkdirSync(emptyDir, { recursive: true });
      vi.stubEnv("NODE_AUTH_DIR", emptyDir);
      // Seed the HOME default with a login the env var must eclipse: finding this file
      // would be the exact #875 bug (wrong dir consulted, false PASS).
      mkdirSync(join(home, ".node-auth"), { recursive: true });
      writeFileSync(join(home, ".node-auth", "auth.json"), "{}");
      const checks = await checkProvider("node", home);
      const login = checks.find((c) => c.name === "node logged in");
      expect(login?.status).toBe("unknown");
      expect(login?.detail).toContain(emptyDir);
      expect(login?.detail).toContain("NODE_AUTH_DIR");
      expect(login?.detail).not.toContain(join(home, ".node-auth"));
    }));

  it("with the var unset the default is consulted AND named", () =>
    withFakeProvider(async () => {
      vi.stubEnv("NODE_AUTH_DIR", "");
      mkdirSync(join(home, ".node-auth"), { recursive: true });
      writeFileSync(join(home, ".node-auth", "auth.json"), "{}");
      const checks = await checkProvider("node", home);
      const login = checks.find((c) => c.name === "node logged in");
      expect(login?.status).toBe("pass");
      expect(login?.detail).toContain(join(home, ".node-auth"));
      expect(login?.detail).toContain("default");
    }));

  it("checkProvider takes an explicit env object, so a test never depends on the live one", () =>
    withFakeProvider(async () => {
      const authDir = join(relocated, "explicit-env");
      mkdirSync(authDir, { recursive: true });
      writeFileSync(join(authDir, "auth.json"), "{}");
      const checks = await checkProvider("node", home, { NODE_AUTH_DIR: authDir });
      expect(checks.find((c) => c.name === "node logged in")?.status).toBe("pass");
    }));
});

describe("the parity contract survives #875", () => {
  it("keeps the ring-pinned file lists untouched — only the DIRECTORY resolution moved", () => {
    // worker-doctor.test.ts pins these against the ring sources; this restates the shape
    // so a refactor of the table cannot silently drop the fields the resolvers rely on.
    expect(PROVIDER_AUTH_FILES.claude).toMatchObject({ dir: ".claude", files: [".credentials.json", "settings.json"] });
    expect(PROVIDER_AUTH_FILES.codex).toMatchObject({ dir: ".codex", files: ["auth.json"] });
  });
});
