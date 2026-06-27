// @covers agent-providers.login.oauthBootstrap [workflow, config]
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * OAuth login bootstrap (spawnCodexLogin / spawnClaudeLogin).
 *
 * When the operator picks a Codex license / Claude subscription that has no auth
 * on disk, the board creates the credential dir and pops a REAL, visible terminal
 * (`windowsHide: false`) running `codex login` / `claude /login` with the right
 * CODEX_HOME / CLAUDE_CONFIG_DIR. The load-bearing invariant is windowsHide:false:
 * a hidden/background spawn would tear down the OAuth callback server and cancel
 * the login. Spawning is fire-and-forget — if launching the terminal throws, the
 * failure is NON-FATAL because the equivalent manual command string is still
 * returned (for the UI's copy button).
 *
 * We mock the spawn seam (node:child_process) and the dir-create seam (node:fs)
 * so nothing real is spawned and no real dir is created.
 *
 * NOTE on error-handling (intentionally NOT claimed in @covers): the product does
 * NOT wrap spawn in a try/catch. The non-fatal property is achieved only by
 * FIRE-AND-FORGET — the launch is `spawn(...).unref()` with no awaiting and no
 * 'error' listener, so an (async) failure to pop the terminal is ignored and the
 * manual command is returned regardless. A *synchronous* spawn throw, however, IS
 * currently FATAL (there is no catch) — that real failure path is uncovered and is
 * the basis for a product-hardening ticket. We therefore claim only [workflow, config]
 * and assert the observable contract (manual command returned + unref) without pinning
 * the current no-hardening shape, so adding a catch/'error' listener would not break
 * this test.
 *
 * Mutation checks:
 *  - flip windowsHide to true   -> the windowsHide:false assertion goes RED.
 *  - drop the manual-command return / make it depend on spawn -> non-fatal tests RED.
 */

const spawnMock = vi.fn();
const mkdirSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("node:fs", () => ({
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
}));

import { spawnCodexLogin } from "../services/codex-login.service.js";
import { spawnClaudeLogin } from "../services/claude-login.service.js";

const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function fakeProc() {
  // spawn() result; .unref() is chained by the production code.
  return { unref: vi.fn() };
}

beforeEach(() => {
  spawnMock.mockReset();
  mkdirSyncMock.mockReset();
  spawnMock.mockReturnValue(fakeProc());
  // Force win32 so we exercise the windows branch that carries the
  // windowsHide:false invariant deterministically across CI platforms.
  setPlatform("win32");
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe("oauth-login-bootstrap (windows visible-terminal spawn)", () => {
  it("codex: creates CODEX_HOME dir, spawns a VISIBLE terminal (windowsHide:false) and returns the manual command", () => {
    const home = "C:\\creds\\codex-license-A";
    const result = spawnCodexLogin(home);

    // dir is created (so login has somewhere to write auth.json)
    expect(mkdirSyncMock).toHaveBeenCalledWith(home, { recursive: true });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, opts] = spawnMock.mock.calls[0] as [string, Record<string, unknown>];

    // command launches a real console running `codex login` with CODEX_HOME set
    expect(command).toContain("codex login");
    expect(command).toContain(`CODEX_HOME=${home}`);

    // THE load-bearing invariant: the terminal must be visible. A hidden spawn
    // would tear down the OAuth callback server. Mutation: windowsHide:true -> RED.
    expect(opts.windowsHide).toBe(false);
    expect(opts.shell).toBe(true);
    expect(opts.detached).toBe(true);

    // manual command (copy button) is returned and carries the same CODEX_HOME
    expect(result.command).toContain("codex login");
    expect(result.command).toContain(home);
  });

  it("claude: creates CLAUDE_CONFIG_DIR dir, spawns a VISIBLE terminal (windowsHide:false) and returns the manual command", () => {
    const dir = "C:\\creds\\claude-sub-B";
    const result = spawnClaudeLogin(dir);

    expect(mkdirSyncMock).toHaveBeenCalledWith(dir, { recursive: true });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, opts] = spawnMock.mock.calls[0] as [string, Record<string, unknown>];

    expect(command).toContain("claude /login");
    expect(command).toContain(`CLAUDE_CONFIG_DIR=${dir}`);

    // load-bearing invariant
    expect(opts.windowsHide).toBe(false);

    expect(result.command).toContain("claude /login");
    expect(result.command).toContain(dir);
  });

  it("non-fatal (fire-and-forget): the returned manual command does not depend on the spawned terminal succeeding (codex)", () => {
    // The launch is fire-and-forget: spawn(...).unref() with no awaiting and no
    // 'error' listener, so whatever happens to the terminal afterwards cannot
    // affect the synchronously-returned manual command.
    const proc = { unref: vi.fn() };
    spawnMock.mockReturnValue(proc);
    const home = "C:\\creds\\codex-license-C";

    const result = spawnCodexLogin(home);

    // result is available immediately, independent of the spawned terminal.
    expect(result.command).toContain("codex login");
    expect(result.command).toContain(home);
    // the launch was fire-and-forget: unref()'d, result does not depend on it.
    expect(proc.unref).toHaveBeenCalled();
  });

  it("non-fatal (fire-and-forget): the returned manual command does not depend on the spawned terminal succeeding (claude)", () => {
    const proc = { unref: vi.fn() };
    spawnMock.mockReturnValue(proc);
    const dir = "C:\\creds\\claude-sub-D";

    const result = spawnClaudeLogin(dir);

    expect(result.command).toContain("claude /login");
    expect(result.command).toContain(dir);
    expect(proc.unref).toHaveBeenCalled();
  });
});
