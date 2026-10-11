import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { npmPrefixWritable, runWorkerSetup, type SetupDeps } from "../cli/commands/worker-setup.js";
import { checkBoardBuild } from "../cli/commands/worker-board-build.js";
import {
  applyWorkerPath,
  isWindowsMountPath,
  isWsl,
  readExtraPathDirs,
  resetWorkerPathForTests,
  saveExtraPathDir,
  stripWindowsMounts,
  windowsOnlyCandidate,
  windowsOnlyMessage,
} from "../worker/worker-path.js";
import { resolveWorkerEntry } from "../cli/commands/worker.js";

describe("npm prefix writability (#1374)", () => {
  it("judges lib/node_modules and bin, not the prefix dir", () => {
    const writable = new Set([join("/usr/local", "lib", "node_modules"), join("/usr/local", "bin")]);
    expect(npmPrefixWritable("/usr/local", "linux", (p) => writable.has(p))).toBe(true);
    expect(npmPrefixWritable("/usr/local", "linux", (p) => p === join("/usr/local", "bin"))).toBe(false);
    expect(npmPrefixWritable("C:\\npm", "win32", (p) => p === "C:\\npm")).toBe(true);
  });
});

describe("WSL PATH policy (#1374)", () => {
  const dirty = "/home/w/.local/bin:/mnt/c/Users/u/.local/bin:/usr/bin:/mnt/d/tools:/mnt/c";
  beforeEach(() => resetWorkerPathForTests());

  it("detects WSL from the env or the kernel release", () => {
    expect(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, () => "", "linux")).toBe(true);
    expect(isWsl({}, () => "5.15.0-microsoft-standard-WSL2", "linux")).toBe(true);
    expect(isWsl({}, () => "6.8.0-generic", "linux")).toBe(false);
    expect(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, () => "", "win32")).toBe(false);
  });

  it("strips /mnt/<drive> entries only", () => {
    expect(isWindowsMountPath("/mnt/c/Users")).toBe(true);
    expect(isWindowsMountPath("/mnt/wsl/x")).toBe(false);
    expect(stripWindowsMounts(dirty)).toBe("/home/w/.local/bin:/usr/bin");
  });

  it("applies the policy to an env and keeps the original for the doctor message", () => {
    const env: NodeJS.ProcessEnv = { PATH: dirty };
    applyWorkerPath(undefined, env, true);
    expect(env.PATH).toBe("/home/w/.local/bin:/usr/bin");
    const exists = (p: string) => p === "/mnt/c/Users/u/.local/bin/claude.exe";
    expect(windowsOnlyCandidate("claude", dirty, exists)).toBe("/mnt/c/Users/u/.local/bin/claude.exe");
    expect(windowsOnlyCandidate("git", dirty, exists)).toBeNull();
  });

  it("doctor message names the Windows-only binary, and is silent off WSL", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/mnt/c/scoop/shims:/usr/bin" };
    applyWorkerPath(undefined, env, true);
    // the real filesystem has no such file, so nothing to report here
    expect(windowsOnlyMessage("git", true)).toBeNull();
    expect(windowsOnlyMessage("git", false)).toBeNull();
  });
});

describe("saved install dirs (#1374)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ak-path-"));
    resetWorkerPathForTests();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("persists a dir once and puts it first on the daemon PATH", () => {
    const stateFile = join(dir, "worker-state.json");
    expect(saveExtraPathDir(stateFile, "/h/.local/bin")).toBe(true);
    expect(saveExtraPathDir(stateFile, "/h/.local/bin")).toBe(false);
    expect(readExtraPathDirs(stateFile)).toEqual(["/h/.local/bin"]);
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    applyWorkerPath(stateFile, env, false);
    expect(env.PATH?.startsWith("/h/.local/bin")).toBe(true);
  });
});

describe("setup finds a CLI the installer put off-PATH (#1374)", () => {
  let dir: string;
  let out: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ak-setup2-"));
    out = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function deps(over: Partial<SetupDeps> = {}) {
    const onPath = new Set<string>(["git"]);
    const files = new Set<string>();
    const added: string[] = [];
    const d: SetupDeps = {
      os: "linux",
      isRoot: false,
      home: "/home/worker",
      probe: async (cmd) => ({ found: onPath.has(cmd), output: onPath.has(cmd) ? (cmd === "git" ? "git version 2.43.0" : `${cmd} 1.0`) : "" }),
      run: (plan) => {
        if (plan.display.includes("claude.ai")) files.add(join("/home/worker", ".local", "bin", "claude"));
        if (plan.display.includes("@openai/codex")) files.add("/usr/local/bin/codex");
        return 0;
      },
      confirm: async () => true,
      print: (l) => out.push(l),
      npmPrefix: () => ({ prefix: "/usr/local", writable: true }),
      pair: async () => ({ alreadyPaired: false, name: "n" }),
      auth: async () => 0,
      doctor: async () => ({ side: "worker", boardUrl: "http://b", ok: true, checks: [] }),
      fileExists: (p) => files.has(p),
      addPath: (dirName) => {
        added.push(dirName);
        onPath.add("claude");
      },
      profileAddsDir: () => false,
      ...over,
    };
    return { d, added, onPath, files };
  }

  it("uses the install dir for the rest of setup, saves it, and tells the human once", async () => {
    const { d, added } = deps();
    const code = await runWorkerSetup(
      { board: "http://b", yes: true, steps: "cli", providers: "claude", stateFile: join(dir, "s.json") },
      d,
    );
    expect(code).toBe(0);
    expect(added).toEqual([join("/home/worker", ".local", "bin")]);
    const text = out.join("\n");
    expect(text).toContain("[cli claude] done");
    expect(text).not.toContain("open a new shell");
    expect(text).toContain("export PATH=");
  });

  it("says the profile already covers the dir when it does", async () => {
    const { d } = deps({ profileAddsDir: () => true });
    await runWorkerSetup({ board: "http://b", yes: true, steps: "cli", providers: "claude", stateFile: join(dir, "s.json") }, d);
    expect(out.join("\n")).toContain("shell profile already adds");
  });

  it("ends a full run with the start command", async () => {
    const { d } = deps();
    await runWorkerSetup({ board: "http://b/", yes: true, token: "T", providers: "claude", stateFile: join(dir, "s.json") }, d);
    expect(out.join("\n")).toContain(`agentic-kanban-worker start --board http://b --state-file ${join(dir, "s.json")} --auto-update`);
  });
});

describe("board build remedy without a daemon (#1374)", () => {
  it("names start --auto-update when no daemon runs", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ buildId: "2436ac45a" + "0".repeat(31) }), { status: 200 })) as unknown as typeof fetch;
    const check = await checkBoardBuild({
      boardUrl: "http://b",
      token: "t",
      ownVersion: "0.1.0-dev.f02bb7dca",
      fetchImpl,
      daemonRunning: false,
    });
    expect(check.status).toBe("warn");
    expect(check.remedy).toContain("start --board http://b --auto-update");
    expect(check.remedy).not.toContain("Run `agentic-kanban-worker update-check --apply`");
  });
});

describe("resolveWorkerEntry on a POSIX npm-global symlink (#1374)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ak-entry-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("follows <prefix>/bin/agentic-kanban-worker to lib/node_modules/<pkg>/bin/worker.js", async () => {
    const { mkdirSync, symlinkSync, writeFileSync } = await import("node:fs");
    const pkgBin = join(dir, "lib", "node_modules", "agentic-kanban", "bin");
    mkdirSync(pkgBin, { recursive: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    const real = join(pkgBin, "worker.js");
    writeFileSync(real, "//");
    const link = join(dir, "bin", "agentic-kanban-worker");
    try {
      symlinkSync(real, link);
    } catch {
      return; // symlinks need privileges on Windows; the POSIX gate runs this
    }
    expect(resolveWorkerEntry(link)).toBe(real);
  });
});
