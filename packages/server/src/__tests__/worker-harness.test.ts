import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyHarnessToSpec,
  createWorkerHarness,
  settingsHaveHooks,
  type SecretProtector,
} from "../worker/worker-harness.js";
import { createWorkerAgentRunner } from "../worker/worker-agent-runner.js";
import { PROVIDER_AUTH_FILES, attestProviderAuth } from "../cli/commands/worker-doctor.js";
import { checkHarness } from "../cli/commands/worker-doctor-harness.js";
import { planAuth, renderAuthStatus, runWorkerAuth, type AuthDeps } from "../cli/commands/worker-auth-command.js";
import type { WorkerLaunchSpec, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";

const SECRET = "sk-ant-oat01-TOP-SECRET-VALUE";

/** Reversible and NOT plaintext, so a test can assert the secret is not on disk verbatim. */
const fakeProtector: SecretProtector = {
  protect: (s) => ({ protection: "fake", data: Buffer.from([...s].reverse().join(""), "utf8").toString("base64") }),
  unprotect: (_p, d) => [...Buffer.from(d, "base64").toString("utf8")].reverse().join(""),
};

function stateFileIn(): string {
  return join(mkdtempSync(join(tmpdir(), "ak-harness-")), "worker-state.json");
}

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined),
) as Record<string, string>;

/** A fake provider: prints its env + argv as JSON, then exits. */
const DUMP = "console.log('DUMP'+JSON.stringify({cfg:process.env.CLAUDE_CONFIG_DIR,codex:process.env.CODEX_HOME,tok:process.env.CLAUDE_CODE_OAUTH_TOKEN,argv:process.argv.slice(1)}))";

function fakeSpec(provider: string, env: Record<string, string> = cleanEnv): WorkerLaunchSpec {
  return {
    command: process.execPath,
    // `--` so node hands the appended flag to the script instead of parsing it itself.
    args: ["-e", DUMP, "--"],
    env,
    cwd: tmpdir(),
    stdinPrompt: "",
    intent: { provider, program: "node" },
  };
}

async function runSession(spec: WorkerLaunchSpec, harness?: ReturnType<typeof createWorkerHarness>) {
  const messages: WorkerToBoardMessage[] = [];
  const runner = createWorkerAgentRunner((m) => messages.push(m), {
    workRoot: mkdtempSync(join(tmpdir(), "ak-worker-root-")),
    ...(harness ? { harness } : {}),
  });
  runner.assign("s1", spec);
  const events = () => messages.flatMap((m) => (m.type === "event" && m.event.sessionId === "s1" ? [m.event] : []));
  await vi.waitFor(
    () => {
      const failed = messages.find((m) => m.type === "assign_failed");
      if (failed) throw new Error(`assign failed: ${JSON.stringify(failed)}`);
      expect(events().some((e) => e.type === "exit")).toBe(true);
    },
    { timeout: 15000 },
  );
  const out = events().filter((e) => e.type === "stdout").map((e) => e.data).join("");
  const line = out.split(/\r?\n/).find((l) => l.startsWith("DUMP"));
  expect(line, `no DUMP line in: ${out}`).toBeTruthy();
  return JSON.parse(line!.slice(4)) as { cfg?: string; codex?: string; tok?: string; argv: string[] };
}

describe("worker harness (#1367)", () => {
  it("clean mode: the session runs with the worker's own CLAUDE_CONFIG_DIR and --strict-mcp-config", async () => {
    const harness = createWorkerHarness({ stateFile: stateFileIn() }, fakeProtector);
    const dump = await runSession(
      fakeSpec("claude", { ...cleanEnv, CLAUDE_CONFIG_DIR: "/home/owner/.claude" }),
      harness,
    );
    expect(harness.mode).toBe("clean");
    // The worker dir REPLACES the owner's, even when the spec/process env names one.
    expect(dump.cfg).toBe(join(harness.root, "claude"));
    expect(dump.argv).toContain("--strict-mcp-config");
    const settings = join(harness.root, "claude", "settings.json");
    expect(existsSync(settings)).toBe(true);
    expect(settingsHaveHooks(settings)).toBe(false);
  });

  it("clean mode also applies to the board's real claude intent id, 'claude-code'", () => {
    // Round 1 on a fresh WSL worker: the board sends provider "claude-code", the harness keyed
    // on "claude" only, so the session ran in ~/.claude and failed 'Not logged in'.
    const harness = createWorkerHarness({ stateFile: stateFileIn() }, fakeProtector);
    const out = applyHarnessToSpec(fakeSpec("claude-code", { ...cleanEnv, CLAUDE_CONFIG_DIR: "/home/owner/.claude" }), harness);
    expect(out.env.CLAUDE_CONFIG_DIR).toBe(join(harness.root, "claude"));
    expect(out.args).toContain("--strict-mcp-config");
  });

  it("clean mode: codex gets CODEX_HOME in the worker's dir and no claude-only flag", async () => {
    const harness = createWorkerHarness({ stateFile: stateFileIn() }, fakeProtector);
    const dump = await runSession(fakeSpec("codex"), harness);
    expect(dump.codex).toBe(join(harness.root, "codex"));
    expect(dump.argv).not.toContain("--strict-mcp-config");
  });

  it("--inherit-user-config restores today's behaviour: env and args untouched", async () => {
    const harness = createWorkerHarness({ stateFile: stateFileIn(), inheritUserConfig: true }, fakeProtector);
    harness.storeToken("claude", SECRET);
    const dump = await runSession(fakeSpec("claude", { ...cleanEnv, CLAUDE_CONFIG_DIR: "/home/owner/.claude" }), harness);
    expect(harness.mode).toBe("inherit");
    expect(dump.cfg).toBe("/home/owner/.claude");
    expect(dump.argv).not.toContain("--strict-mcp-config");
    expect(dump.tok).toBeUndefined();
  });

  it("a runner with no harness is inherit mode", async () => {
    const dump = await runSession(fakeSpec("claude", { ...cleanEnv, CLAUDE_CONFIG_DIR: "/home/owner/.claude" }));
    expect(dump.cfg).toBe("/home/owner/.claude");
    expect(dump.argv).not.toContain("--strict-mcp-config");
  });

  it("custom mode uses the operator's folder and does not write into it", async () => {
    const custom = mkdtempSync(join(tmpdir(), "ak-claude-worker-"));
    const harness = createWorkerHarness({ stateFile: stateFileIn(), claudeConfigDir: custom }, fakeProtector);
    const dump = await runSession(fakeSpec("claude"), harness);
    expect(harness.mode).toBe("custom");
    expect(dump.cfg).toBe(custom);
    expect(existsSync(join(custom, "settings.json"))).toBe(false);
  });

  it("a profile-pinned assignment keeps the profile's own dir and gets no stored token", () => {
    const harness = createWorkerHarness({ stateFile: stateFileIn() }, fakeProtector);
    harness.storeToken("claude", SECRET);
    const spec = fakeSpec("claude", { CLAUDE_CONFIG_DIR: "/home/owner/.claude-anth" });
    spec.intent!.profile = "anth";
    const out = applyHarnessToSpec(spec, harness);
    expect(out.env.CLAUDE_CONFIG_DIR).toBe("/home/owner/.claude-anth");
    expect(out.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(out.args).toContain("--strict-mcp-config");
  });

  describe("auth claude --token", () => {
    it("stores the token sealed on disk and injects it into claude sessions only", async () => {
      const harness = createWorkerHarness({ stateFile: stateFileIn() }, fakeProtector);
      const printed: string[] = [];
      const deps: AuthDeps = {
        run: (command, args) => (command === "claude" && args[0] === "setup-token" ? 0 : 1),
        claudeHasAuthLogin: () => false,
        readSecret: async () => SECRET,
        hasDisplay: () => true,
        print: (l) => printed.push(l),
        protector: fakeProtector,
      };
      // runWorkerAuth builds its own harness from the state file; point it at the same one.
      const stateFile = join(harness.root, "..", "worker-state.json");
      const code = await runWorkerAuth("claude", { token: true, stateFile }, deps);
      expect(code).toBe(0);
      expect(printed.join("\n")).not.toContain(SECRET);

      const sealed = readFileSync(join(harness.root, "claude-token.json"), "utf8");
      expect(sealed).not.toContain(SECRET);

      const withToken = createWorkerHarness({ stateFile }, fakeProtector);
      expect((await runSession(fakeSpec("claude"), withToken)).tok).toBe(SECRET);
      expect((await runSession(fakeSpec("codex"), withToken)).tok).toBeUndefined();
    });

    it("stores nothing when setup-token fails", async () => {
      const stateFile = stateFileIn();
      const deps: AuthDeps = {
        run: () => 1,
        claudeHasAuthLogin: () => false,
        readSecret: async () => SECRET,
        hasDisplay: () => true,
        print: () => {},
        protector: fakeProtector,
      };
      expect(await runWorkerAuth("claude", { token: true, stateFile }, deps)).toBe(1);
      expect(createWorkerHarness({ stateFile }, fakeProtector).tokenStatus("claude").stored).toBe(false);
    });

    it("--status names the mode and expiry but never the secret", () => {
      const harness = createWorkerHarness({ stateFile: stateFileIn() }, fakeProtector);
      const now = Date.now();
      harness.storeToken("claude", SECRET, now);
      const text = renderAuthStatus(harness, now).join("\n");
      expect(text).toContain("token (stored by the worker");
      expect(text).toContain(new Date(now + 365 * 86_400_000).toISOString().slice(0, 4));
      expect(text).not.toContain(SECRET);
      expect(renderAuthStatus(harness, now + 400 * 86_400_000).join("\n")).toContain("EXPIRED");
    });
  });

  describe("attestation", () => {
    it("advertises a provider whose credential is a worker-stored token (doctor PASS)", async () => {
      PROVIDER_AUTH_FILES.node = { dir: ".node-auth", files: ["auth.json"], loginCommand: "node --login" };
      try {
        const home = mkdtempSync(join(tmpdir(), "ak-home-"));
        const harness = createWorkerHarness({ stateFile: stateFileIn() }, fakeProtector);
        const before = await attestProviderAuth("node", home, {}, harness);
        expect(before.attested).toBe(false); // env-only / nothing stored is still `unknown`
        harness.storeToken("node", SECRET);
        const after = await attestProviderAuth("node", home, {}, harness);
        expect(after.attested).toBe(true);
        expect(after.checks.find((c) => c.name === "node logged in")?.detail).toBe("token (stored by the worker)");
        expect(JSON.stringify(after.checks)).not.toContain(SECRET);
      } finally {
        delete PROVIDER_AUTH_FILES.node;
      }
    });

    it("a clean dir's own settings.json does not count as a login", async () => {
      PROVIDER_AUTH_FILES.node = { dir: ".node-auth", files: ["auth.json", "settings.json"], loginCommand: "node --login" };
      try {
        const harness = createWorkerHarness({ stateFile: stateFileIn(), claudeConfigDir: undefined }, fakeProtector);
        const dir = join(harness.root, "node");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "settings.json"), "{}");
        // `node` is not a harness provider, so it falls back to the home dir: nothing there.
        const res = await attestProviderAuth("node", mkdtempSync(join(tmpdir(), "ak-home-")), {}, harness);
        expect(res.attested).toBe(false);
      } finally {
        delete PROVIDER_AUTH_FILES.node;
      }
    });
  });

  describe("doctor harness checks", () => {
    it("reports the mode, a missing dir, and hooks in the harness settings.json", () => {
      const harness = createWorkerHarness({ stateFile: stateFileIn() }, fakeProtector);
      const missing = checkHarness(harness, ["claude"]);
      expect(missing[0]).toMatchObject({ name: "harness mode", status: "pass" });
      expect(missing[0].detail).toContain("clean");
      expect(missing.find((c) => c.name === "claude harness dir")?.status).toBe("warn");

      harness.ensure("claude");
      const settings = join(harness.root, "claude", "settings.json");
      expect(checkHarness(harness, ["claude"]).some((c) => c.name === "claude harness hooks")).toBe(false);

      writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } }));
      const hooked = checkHarness(harness, ["claude"]);
      expect(hooked.find((c) => c.name === "claude harness hooks")?.status).toBe("fail");
    });

    it("flags inherit mode as dirty and shows a stored token as the credential", () => {
      const inherit = createWorkerHarness({ stateFile: stateFileIn(), inheritUserConfig: true }, fakeProtector);
      const checks = checkHarness(inherit, ["claude"]);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ name: "harness mode", status: "warn" });

      const harness = createWorkerHarness({ stateFile: stateFileIn() }, fakeProtector);
      harness.ensure("claude");
      harness.storeToken("claude", SECRET);
      const cred = checkHarness(harness, ["claude"]).find((c) => c.name === "claude credential");
      expect(cred?.status).toBe("pass");
      expect(cred?.detail).toContain("token (stored by the worker)");
    });
  });

  describe("auth plan", () => {
    it("codex uses --device-auth when there is no display", () => {
      expect(planAuth("codex", "/d", { claudeHasAuthLogin: false, hasDisplay: false }).args).toEqual(["login", "--device-auth"]);
      expect(planAuth("codex", "/d", { claudeHasAuthLogin: false, hasDisplay: true }).args).toEqual(["login"]);
    });
    it("claude falls back to launching claude for /login when there is no auth subcommand", () => {
      const plan = planAuth("claude", "/d", { claudeHasAuthLogin: false, hasDisplay: true });
      expect(plan.args).toEqual([]);
      expect(plan.note).toContain("/login");
      expect(planAuth("claude", "/d", { claudeHasAuthLogin: true, hasDisplay: true }).args).toEqual(["auth", "login"]);
    });
  });
});
