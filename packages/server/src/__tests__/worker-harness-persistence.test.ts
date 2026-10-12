import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkerHarness,
  findWorkerStateFiles,
  readPersistedHarness,
  registerStateFile,
  resolveHarnessConfig,
  resolveInspectedHarness,
  writePersistedHarness,
  type SecretProtector,
} from "../worker/worker-harness.js";
import { listWorkerStateFiles, runWorkerAuth, type AuthDeps } from "../cli/commands/worker-auth-command.js";
import { checkHarness } from "../cli/commands/worker-doctor-harness.js";
import { globalLauncherWarning, harnessUpdateNote } from "../cli/commands/worker-update-notes.js";

const protector: SecretProtector = {
  protect: (s) => ({ protection: "test", data: Buffer.from(s).toString("base64") }),
  unprotect: (_p, d) => Buffer.from(d, "base64").toString("utf8"),
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ak-1373-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const pairedState = (file: string, harness?: object) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ boards: { "http://b": { workerId: "w", workerToken: "t", name: "n" } }, ...(harness ? { harness } : {}) }),
  );
};

function authDeps(printed: string[], extra: Partial<AuthDeps> = {}): AuthDeps {
  return {
    run: () => 0,
    claudeHasAuthLogin: () => true,
    readSecret: async () => "tok-123",
    hasDisplay: () => true,
    print: (l) => printed.push(l),
    protector,
    home,
    ...extra,
  };
}

describe("F1: a pairing that predates harness modes keeps inherit", () => {
  it("no mode recorded + existing pairing => inherit, flagged legacy; fresh state => clean", () => {
    const legacy = join(home, "old", "state.json");
    pairedState(legacy);
    const cfg = resolveHarnessConfig(legacy);
    expect(cfg.mode).toBe("inherit");
    expect(cfg.legacyInherit).toBe(true);
    expect(createWorkerHarness(cfg.options, protector).dirFor("claude")).toBeUndefined();
    expect(resolveHarnessConfig(join(home, "new", "state.json")).mode).toBe("clean");
  });

  it("start records inherit once; --clean switches it", () => {
    const f = join(home, "old", "state.json");
    pairedState(f);
    writePersistedHarness(f, resolveHarnessConfig(f).toPersist);
    expect(readPersistedHarness(f)?.mode).toBe("inherit");
    expect(resolveHarnessConfig(f).legacyInherit).toBe(false);
    const clean = resolveHarnessConfig(f, { clean: true });
    expect(clean.mode).toBe("clean");
    expect(clean.differences.length).toBe(1);
  });

  it("update note appears only for a legacy pairing", () => {
    const f = join(home, "old", "state.json");
    pairedState(f);
    expect(harnessUpdateNote(f)).toMatch(/keeps it in inherit mode/);
    pairedState(f, { mode: "clean" });
    expect(harnessUpdateNote(f)).toBeNull();
  });
});

describe("F4/F5: start persists mode and dirs; doctor and auth read them", () => {
  it("--config-dir survives into doctor and auth --status, and the remedy carries the exact flags", async () => {
    const s = join(home, "d1", "state.json");
    const x = join(home, "claude-worker");
    pairedState(s);
    writePersistedHarness(s, resolveHarnessConfig(s, { configDir: x }).toPersist);
    const doctor = resolveInspectedHarness(s);
    const harness = createWorkerHarness(doctor.options, protector);
    expect(harness.mode).toBe("custom");
    expect(harness.dirFor("claude")).toBe(x);
    const checks = checkHarness(harness, ["claude"]);
    expect(checks.find((c) => c.name === "claude harness dir")?.remedy).toContain(`auth claude --config-dir ${x} --state-file ${s}`);

    const out: string[] = [];
    await runWorkerAuth(undefined, { status: true, stateFile: s }, authDeps(out));
    expect(out.join("\n")).toContain(x);
    expect(out.join("\n")).toContain("harness mode: custom");
  });

  it("a differing flag is reported and the recorded folder is used by doctor/auth", () => {
    const s = join(home, "d1", "state.json");
    pairedState(s, { mode: "custom", claudeConfigDir: join(home, "A") });
    const cfg = resolveInspectedHarness(s, { configDir: join(home, "B") });
    expect(cfg.options.claudeConfigDir).toBe(join(home, "A"));
    expect(cfg.differences.join(" ")).toMatch(/state file records/);
  });

  it("start's differing flags win but are reported", () => {
    const s = join(home, "d1", "state.json");
    pairedState(s, { mode: "custom", claudeConfigDir: join(home, "A") });
    const cfg = resolveHarnessConfig(s, { configDir: join(home, "B") });
    expect(cfg.options.claudeConfigDir).toBe(join(home, "B"));
    expect(cfg.differences).toHaveLength(1);
  });

  it("auth claude logs into the recorded folder, not the state dir's harness", async () => {
    const s = join(home, "d1", "state.json");
    const x = join(home, "claude-worker");
    pairedState(s, { mode: "custom", claudeConfigDir: x });
    let env: NodeJS.ProcessEnv = {};
    await runWorkerAuth("claude", { stateFile: s }, authDeps([], { run: (_c, _a, e) => ((env = e), 0) }));
    // #1408: the login runs in a scratch dir; the credential is moved into the recorded folder on success.
    const scratch = env.CLAUDE_CONFIG_DIR!;
    expect(scratch).not.toBe(x);
    await runWorkerAuth("claude", { stateFile: s }, authDeps([], {
      run: (_c, _a, e) => (writeFileSync(join(e.CLAUDE_CONFIG_DIR!, ".credentials.json"), "NEW"), 0),
    }));
    expect(readFileSync(join(x, ".credentials.json"), "utf8")).toBe("NEW");
  });

  it("#1408: a failed or killed login leaves the folder untouched; a usable login is never replaced", async () => {
    const s = join(home, "d2", "state.json");
    const x = join(home, "claude-keep");
    pairedState(s, { mode: "custom", claudeConfigDir: x });
    mkdirSync(x, { recursive: true });
    const good = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } });
    writeFileSync(join(x, ".credentials.json"), good);
    let ran = false;
    await runWorkerAuth("claude", { stateFile: s }, authDeps([], { run: () => ((ran = true), 0) }));
    expect(ran).toBe(false);
    // forced, but the login dies after writing a stub
    const code = await runWorkerAuth("claude", { stateFile: s, force: true }, authDeps([], {
      run: (_c, _a, e) => (writeFileSync(join(e.CLAUDE_CONFIG_DIR!, ".credentials.json"), "STUB"), 130),
    }));
    expect(code).toBe(130);
    expect(readFileSync(join(x, ".credentials.json"), "utf8")).toBe(good);
  });
});

describe("F2: auth --status without --state-file lists the worker state files", () => {
  it("lists default + registered state files with their modes and says it shows the default home", async () => {
    const def = join(home, ".agentic-kanban", "worker-state.json");
    const d1 = join(home, "akd1", "state.json");
    pairedState(def, { mode: "clean" });
    pairedState(d1, { mode: "custom", claudeConfigDir: join(home, "cw") });
    registerStateFile(d1, home);
    expect(findWorkerStateFiles(def, home)).toEqual([def, d1]);
    const lines = listWorkerStateFiles(home).join("\n");
    expect(lines).toContain(d1);
    expect(lines).toContain("custom");
    const out: string[] = [];
    await runWorkerAuth(undefined, { status: true }, authDeps(out));
    expect(out.join("\n")).toMatch(/DEFAULT home/);
  });
});

describe("F6: codex follows the state file", () => {
  it("clean codex dir sits beside the same state file as claude", () => {
    const s = join(home, "d1", "state.json");
    const h = createWorkerHarness(resolveHarnessConfig(s, { configDir: join(home, "cw") }).options, protector);
    expect(h.dirFor("codex")).toBe(join(home, "d1", "harness", "codex"));
  });
});

describe("F7: auth --token stores where the pairing's worker reads", () => {
  it("--config-dir alone finds the registered state file that records it and says where the token went", async () => {
    const d1 = join(home, "akd1", "state.json");
    const x = join(home, "cw");
    pairedState(d1, { mode: "custom", claudeConfigDir: x });
    registerStateFile(d1, home);
    const out: string[] = [];
    const code = await runWorkerAuth("claude", { token: true, configDir: x }, authDeps(out));
    expect(code).toBe(0);
    const tokenFile = join(home, "akd1", "harness", "claude-token.json");
    expect(JSON.parse(readFileSync(tokenFile, "utf8")).data).toBeTruthy();
    expect(out.join("\n")).toContain(tokenFile);
    // the worker's harness (built from the same state file) reads it
    expect(createWorkerHarness(resolveInspectedHarness(d1).options, protector).readToken("claude")).toBe("tok-123");
  });
});

describe("F3: stale global launcher", () => {
  it("warns with the fix when the global build differs from the running build", () => {
    const w = globalLauncherWarning({ stateFile: join(home, "s.json"), globalVersion: "0.1.9-dev.f3d72ef1b", runningBuild: "2be110b39" });
    expect(w).toMatch(/WARNING/);
    expect(w).toMatch(/npm i -g/);
    expect(globalLauncherWarning({ stateFile: join(home, "s.json"), globalVersion: "0.1.9-dev.2be110b39", runningBuild: "2be110b39" })).toBeNull();
  });
});


