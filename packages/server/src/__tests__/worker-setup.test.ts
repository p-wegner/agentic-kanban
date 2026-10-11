import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  gitInstallPlan,
  gitIsNewEnough,
  parseGitVersion,
  providerInstallPlan,
} from "../cli/commands/worker-setup-installers.js";
import { runWorkerSetup, type SetupDeps, type SetupOptions } from "../cli/commands/worker-setup.js";
import type { InstallPlan } from "../cli/commands/worker-setup-installers.js";

describe("installer plans (#1368)", () => {
  it("parses and compares git versions against 2.31", () => {
    expect(parseGitVersion("git version 2.43.0.windows.1")).toEqual([2, 43]);
    expect(gitIsNewEnough("git version 2.31.0")).toBe(true);
    expect(gitIsNewEnough("git version 2.30.9")).toBe(false);
    expect(gitIsNewEnough("git version 3.0.1")).toBe(true);
    expect(gitIsNewEnough("nonsense")).toBe(false);
  });

  it("picks the OS-native git installer", () => {
    expect(gitInstallPlan("win32", () => false, false)?.display).toBe("winget install --id Git.Git -e --source winget");
    expect(gitInstallPlan("darwin", () => false, false)?.display).toBe("brew install git");
    expect(gitInstallPlan("linux", (c) => c === "apt-get", false)?.display).toBe("sudo apt-get install -y git");
    expect(gitInstallPlan("linux", (c) => c === "dnf", true)?.display).toBe("dnf install -y git");
    expect(gitInstallPlan("linux", () => false, false)).toBeNull();
  });

  it("uses the native claude installer per OS and npm for codex", () => {
    expect(providerInstallPlan("claude", "win32")?.command).toBe("powershell");
    expect(providerInstallPlan("claude", "linux")?.display).toContain("claude.ai/install.sh");
    expect(providerInstallPlan("claude", "darwin")?.display).toContain("claude.ai/install.sh");
    expect(providerInstallPlan("codex", "linux")?.display).toBe("npm i -g @openai/codex");
    expect(providerInstallPlan("codex", "linux", { userPrefix: "/h/.local" })?.display).toBe(
      "npm i -g --prefix /h/.local @openai/codex",
    );
    expect(providerInstallPlan("codex", "win32")?.shell).toBe(true);
    expect(providerInstallPlan("copilot", "linux")).toBeNull();
  });
});

describe("worker setup (#1368)", () => {
  let dir: string;
  let stateFile: string;
  let installed: Set<string>;
  let ran: InstallPlan[];
  let out: string[];
  let answers: boolean[];
  let authCalls: Array<{ provider: string; configDir?: string }>;
  let pairCalls: number;
  let doctorFails: number;

  function makeDeps(over: Partial<SetupDeps> = {}): SetupDeps {
    return {
      os: "linux",
      isRoot: false,
      home: dir,
      probe: async (cmd) =>
        installed.has(cmd)
          ? { found: true, output: cmd === "git" ? "git version 2.43.0" : `${cmd} 1.0.0` }
          : { found: false, output: "" },
      run: (plan) => {
        ran.push(plan);
        // The fake installer "installs" whatever the plan is for.
        if (plan.command === "winget" || plan.display.includes("git")) installed.add("git");
        if (plan.display.includes("claude.ai")) installed.add("claude");
        if (plan.display.includes("@openai/codex")) installed.add("codex");
        return 0;
      },
      confirm: async () => answers.shift() ?? false,
      print: (l) => out.push(l),
      npmPrefix: () => ({ prefix: "/usr", writable: true }),
      pair: async (o) => {
        pairCalls++;
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          o.stateFile!,
          JSON.stringify({ boards: { [o.boardUrl]: { workerId: "w1", workerToken: "t", name: "box" } } }),
        );
        return { alreadyPaired: false, name: "box" };
      },
      auth: async (provider, opts) => {
        authCalls.push({ provider, configDir: opts.configDir });
        // Leave a credential where the harness looks for it (<state dir>/harness/<provider>).
        const harnessDir = join(dir, "harness", provider);
        mkdirSync(harnessDir, { recursive: true });
        if (provider === "codex") writeFileSync(join(harnessDir, "auth.json"), "{}");
        else {
          const claudeDir = opts.configDir ?? harnessDir;
          mkdirSync(claudeDir, { recursive: true });
          writeFileSync(
            join(claudeDir, ".credentials.json"),
            JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
          );
        }
        return 0;
      },
      doctor: async () => ({
        side: "worker",
        boardUrl: "http://b",
        ok: doctorFails === 0,
        checks: doctorFails
          ? [{ name: "x", status: "fail", detail: "broken", remedy: "fix it" }]
          : [{ name: "w", status: "warn", detail: "meh", remedy: "tweak" }],
      }),
      ...over,
    };
  }

  const base = (): SetupOptions => ({ board: "http://b", token: "TOK", stateFile });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ak-setup-"));
    stateFile = join(dir, "worker-state.json");
    installed = new Set(["node", "apt-get"]);
    ran = [];
    out = [];
    answers = [];
    authCalls = [];
    pairCalls = 0;
    doctorFails = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("pairs before the slow install/login steps, and says so when a login is Ctrl+C'd (#1388)", async () => {
    const order: string[] = [];
    const deps = makeDeps();
    const pair = deps.pair;
    const code = await runWorkerSetup({ ...base(), yes: true }, {
      ...deps,
      pair: async (o) => { order.push("pair"); expect(o.attestProviders).toBe(false); return pair(o); },
      run: (p) => { order.push("install"); return deps.run(p); },
      auth: async () => { order.push("auth"); return 130; },
    });
    expect(order[0]).toBe("pair");
    expect(order).toContain("auth");
    expect(out.join("\n")).toContain("login skipped - run agentic-kanban-worker auth claude");
    expect(out.join("\n")).not.toContain("[auth claude] FAILED");
    expect(code).toBe(0);
  });

  it("takes a node-only machine to a paired worker, then re-runs as all ok", async () => {
    const opts = { ...base(), yes: true };
    expect(await runWorkerSetup(opts, makeDeps())).toBe(0);
    expect(ran.map((p) => p.display).join("\n")).toContain("apt-get");
    expect(installed.has("claude") && installed.has("codex") && installed.has("git")).toBe(true);
    expect(pairCalls).toBe(1);
    expect(out.join("\n")).toContain("[cli claude] done");
    expect(out.join("\n")).toContain("[doctor] ok - 0 FAIL, 1 WARN");

    // Second run must install, log in and pair nothing.
    out = [];
    ran = [];
    expect(await runWorkerSetup(opts, makeDeps())).toBe(0);
    expect(ran).toEqual([]);
    expect(pairCalls).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("[git] ok (already present)");
    expect(text).toContain("[cli claude] ok (already present)");
    expect(text).toContain("[cli codex] ok (already present)");
    expect(text).toContain("[pair] ok (already present)");
    expect(text).not.toContain("FAILED");
  });

  it("never runs an installer with --no-install, and prints the commands", async () => {
    expect(await runWorkerSetup({ ...base(), token: undefined, install: false, yes: true, steps: "git,cli" }, makeDeps())).toBe(0);
    expect(ran).toEqual([]);
    const text = out.join("\n");
    expect(text).toContain("install command: sudo apt-get install -y git");
    expect(text).toContain("install command: npm i -g @openai/codex");
    expect(text).toContain("skipped");
  });

  it("asks y/N before installing and honours a no", async () => {
    answers = [false, true, false]; // git: no, claude: yes, codex: no
    await runWorkerSetup({ ...base(), token: undefined, steps: "git,cli" }, makeDeps());
    expect(ran.map((p) => p.display)).toEqual(["curl -fsSL https://claude.ai/install.sh | bash"]);
    expect(out.join("\n")).toContain("[git] skipped");
  });

  it("uses the Windows code path: winget for git, powershell installer for claude, npm via shell", async () => {
    await runWorkerSetup({ ...base(), token: undefined, yes: true, steps: "git,cli" }, makeDeps({ os: "win32" }));
    expect(ran.map((p) => p.command)).toEqual(["winget", "powershell", "npm"]);
    expect(ran[2]!.shell).toBe(true);
  });

  it("offers a user prefix instead of sudo for a root-owned npm prefix on Linux", async () => {
    installed.add("git");
    installed.add("claude");
    await runWorkerSetup(
      { ...base(), token: undefined, yes: true, steps: "cli" },
      makeDeps({ npmPrefix: () => ({ prefix: "/usr", writable: false }) }),
    );
    expect(ran).toHaveLength(1);
    expect(ran[0]!.args).toContain("--prefix");
    expect(ran[0]!.display).not.toContain("sudo");
    expect(out.join("\n")).toContain("not writable by this user");
  });

  it("refuses an old git and reports the install command", async () => {
    installed.add("git");
    const deps = makeDeps({ probe: async (c) => (c === "git" ? { found: true, output: "git version 2.20.1" } : { found: false, output: "" }) });
    await runWorkerSetup({ ...base(), token: undefined, install: false, steps: "git" }, deps);
    expect(out.join("\n")).toContain("older than 2.31");
  });

  it("--steps auth --config-dir X touches nothing else", async () => {
    installed.add("claude");
    const custom = join(dir, "custom-claude");
    expect(await runWorkerSetup({ ...base(), token: undefined, configDir: custom, yes: true }, makeDeps())).toBe(0);
    expect(ran).toEqual([]);
    expect(pairCalls).toBe(0);
    expect(authCalls).toEqual([{ provider: "claude", configDir: custom }]);
    expect(out.join("\n")).not.toContain("[git]");
    expect(out.join("\n")).not.toContain("[doctor]");
  });

  it("--token with --config-dir pairs and doctors, and the start hint carries the flags (#1398)", async () => {
    installed.add("claude");
    const custom = join(dir, "custom-claude");
    const opts = { ...base(), configDir: custom, yes: true, name: "desk top" };
    expect(await runWorkerSetup(opts, makeDeps())).toBe(0);
    expect(pairCalls).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("[doctor]");
    expect(text).toContain(`agentic-kanban-worker start --board http://b --config-dir ${custom} --state-file ${stateFile} --name "desk top" --auto-update`);
  });

  it("--token with --steps that exclude pair is refused (#1398)", async () => {
    expect(await runWorkerSetup({ ...base(), steps: "git" }, makeDeps())).toBe(2);
    expect(pairCalls).toBe(0);
    expect(out.join("\n")).toContain("--token");
  });

  it("an explicit --steps selection runs only those steps", async () => {
    installed.add("git");
    await runWorkerSetup({ ...base(), token: undefined, steps: "git" }, makeDeps());
    expect(out.join("\n")).toContain("[git] ok (already present)");
    expect(out.join("\n")).not.toContain("[cli");
    expect(pairCalls).toBe(0);
  });

  it("rejects an unknown step name", async () => {
    expect(await runWorkerSetup({ ...base(), steps: "git,bogus" }, makeDeps())).toBe(2);
  });

  it("skips pairing without a token, and fails the run when doctor has a FAIL", async () => {
    installed = new Set(["git", "claude", "codex"]);
    doctorFails = 1;
    const code = await runWorkerSetup({ board: "http://b", stateFile, steps: "pair,doctor" }, makeDeps());
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("[pair] skipped");
    expect(out.join("\n")).toContain("FAIL x: broken");
    expect(out.join("\n")).toContain("fix: fix it");
  });

  it("--guide prints the offline guide and does nothing else", async () => {
    expect(await runWorkerSetup({ ...base(), guide: true }, makeDeps())).toBe(0);
    expect(out.join("\n")).toContain("Agentic Kanban worker - setup guide");
    expect(ran).toEqual([]);
  });

  it("--start launches the daemon only after a clean run", async () => {
    const start = vi.fn(async () => {});
    installed = new Set(["git", "claude", "codex"]);
    await runWorkerSetup({ ...base(), yes: true, start: true, steps: "pair" }, makeDeps({ start }));
    expect(start).toHaveBeenCalledTimes(1);
  });
});
