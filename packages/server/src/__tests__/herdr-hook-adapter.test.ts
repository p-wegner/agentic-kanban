// @gate:always-run when:.claude/hooks/**,.codex/**,.pi/**,.herdr/**,packages/server/src/scaffold/** — spawns
// the live hook scripts and the live herdr adapter outside src/; imports nothing it checks (#538).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * #1146: a herdr-launched agent session must be held to the SAME pre-tool gates as
 * Claude/Codex/Pi — DB safety, cross-worktree writes, command safety — by delegating to
 * the existing `.claude/hooks/*.js` scripts rather than reimplementing the logic.
 *
 * Herdr itself has no `tool_call`-style extension event (unlike Pi's `--extension`), and
 * `HerdrProvider.buildLaunchConfig` (agent-provider/herdr-provider.ts) launches herdr the
 * same way Claude/Pi are launched — plain child_process.spawn, provider-agnostic env
 * wiring (KANBAN_WORKTREE_DIR is set for every provider in agent.service.ts, not just
 * Claude/Pi). So the guards themselves are ALREADY provider-agnostic: they only look at
 * `tool_name`/`tool_input`/env, never at which provider launched the session. This suite
 * proves that directly against the deployed scripts using herdr-shaped payloads, and
 * exercises the new `.herdr/plugin/agentic-kanban-hooks.mjs` bridge (the herdr-side
 * sibling of `.pi/plugin/agentic-kanban-hooks.ts`) end to end.
 */

const HOOKS_DIR = join(__dirname, "../../../../.claude/hooks");
const COMMAND_SAFETY_HOOK = join(HOOKS_DIR, "validate-command-safety.js");
const CROSS_WORKTREE_HOOK = join(HOOKS_DIR, "prevent-cross-worktree-writes.js");
const HERDR_ADAPTER = join(__dirname, "../../../../.herdr/plugin/agentic-kanban-hooks.mjs");

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function seedRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(["init", "-b", "master"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "T"], dir);
  writeFileSync(join(dir, "seed.md"), "seed\n", "utf8");
  git(["add", "seed.md"], dir);
  git(["commit", "-m", "seed"], dir);
}

interface HookResult {
  blocked: boolean;
  reason: string;
}

/** Run the deployed cross-worktree guard directly, exactly as any provider's launched
 * process would trigger it — the payload shape is provider-agnostic (tool_name/tool_input). */
function runCrossWorktreeHook(
  payload: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): HookResult {
  const res = spawnSync(process.execPath, [CROSS_WORKTREE_HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: undefined,
      KANBAN_WORKTREE_DIR: undefined,
      ALLOW_CROSS_WORKTREE_WRITE: undefined,
      ...env,
    },
  });
  return { blocked: res.status === 2, reason: res.stdout ?? "" };
}

let root: string;
let mainCheckout: string;
let worktree: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ak-herdr-guard-"));
  mainCheckout = join(root, "repo");
  worktree = join(root, ".worktrees", "repo", "ak-1146");
  seedRepo(mainCheckout);
  mkdirSync(join(root, ".worktrees", "repo"), { recursive: true });
  git(["worktree", "add", "-b", "feature/ak-1146", worktree], mainCheckout);
  // The herdr adapter resolves the hook scripts relative to CLAUDE_PROJECT_DIR
  // (.herdr/plugin/agentic-kanban-hooks.mjs: HOOKS_DIR = join(PROJECT_DIR, ".claude", "hooks")).
  // The bridge tests below point CLAUDE_PROJECT_DIR at this synthetic worktree, so it needs its
  // own .claude/hooks/ copy — mirroring what project scaffolding materializes into a real
  // worktree — or the adapter's spawn fails with MODULE_NOT_FOUND, which reads as a false
  // "block" (a spawn failure, not the guard refusing) and would mask the guard never running.
  mkdirSync(join(worktree, ".claude", "hooks"), { recursive: true });
  cpSync(CROSS_WORKTREE_HOOK, join(worktree, ".claude", "hooks", "prevent-cross-worktree-writes.js"));
});

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("cross-worktree guard treats a herdr-relayed tool call identically to any other provider (#1146)", () => {
  it("BLOCKS a herdr-relayed shell command that writes into the main checkout, same as a Claude/Codex/Pi call would", () => {
    const res = runCrossWorktreeHook(
      {
        tool_name: "Bash",
        tool_input: { command: `echo hi > ${mainCheckout.replace(/\\/g, "/")}/docs.md` },
        cwd: worktree,
      },
      { KANBAN_WORKTREE_DIR: worktree },
    );
    expect(res.blocked).toBe(true);
  });

  it("BLOCKS a herdr-relayed Write call into the main checkout", () => {
    const res = runCrossWorktreeHook(
      {
        tool_name: "Write",
        tool_input: { file_path: join(mainCheckout, "docs.md") },
        cwd: worktree,
      },
      { KANBAN_WORKTREE_DIR: worktree },
    );
    expect(res.blocked).toBe(true);
  });

  it("ALLOWS a write inside the herdr session's own authorized worktree", () => {
    const res = runCrossWorktreeHook(
      {
        tool_name: "Write",
        tool_input: { file_path: join(worktree, "notes.md") },
        cwd: worktree,
      },
      { KANBAN_WORKTREE_DIR: worktree },
    );
    expect(res.blocked).toBe(false);
  });
});

describe("command-safety guard treats a herdr-relayed shell command identically to any other provider (#1146)", () => {
  function runCommandSafetyHook(command: string, cwd: string): HookResult {
    const res = spawnSync(process.execPath, [COMMAND_SAFETY_HOOK], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command, cwd } }),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ALLOW_DB_DESTROY: undefined },
    });
    let decision: { decision?: string } | undefined;
    try { decision = JSON.parse(res.stdout ?? ""); } catch { /* not JSON */ }
    return { blocked: res.status !== 0 || decision?.decision === "block", reason: res.stdout ?? "" };
  }

  it("BLOCKS a destructive db command the same way it blocks one from any other provider", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ak-herdr-db-"));
    try {
      mkdirSync(join(cwd, "packages", "server"), { recursive: true });
      writeFileSync(join(cwd, "packages", "server", "kanban.db"), Buffer.alloc(16_384, 1));
      const res = runCommandSafetyHook("Remove-Item packages/server/kanban.db -Force", cwd);
      expect(res.blocked).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ALLOWS an ordinary read-only command", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ak-herdr-db-ok-"));
    try {
      const res = runCommandSafetyHook("git status", cwd);
      expect(res.blocked).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe(".herdr/plugin/agentic-kanban-hooks.mjs bridge (#1146)", () => {
  /** Invoke the adapter's exported evaluateHerdrToolCall via a tiny driver script, so the
   * test exercises the real ESM module exactly as any herdr-side wrapper would import it. */
  function evaluateViaAdapter(
    toolName: string,
    toolInput: Record<string, unknown>,
    cwd: string,
    env: Record<string, string | undefined> = {},
  ): { block: boolean; reason?: string } {
    const driver = [
      `import { evaluateHerdrToolCall } from ${JSON.stringify(pathToFileURL(HERDR_ADAPTER).href)};`,
      `const result = await evaluateHerdrToolCall(${JSON.stringify(toolName)}, ${JSON.stringify(toolInput)}, ${JSON.stringify(cwd)});`,
      `process.stdout.write(JSON.stringify(result));`,
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: undefined,
        KANBAN_WORKTREE_DIR: undefined,
        ALLOW_CROSS_WORKTREE_WRITE: undefined,
        ...env,
      },
    });
    return JSON.parse(res.stdout ?? "{}");
  }

  it("blocks a cross-worktree write routed through the herdr adapter", () => {
    const result = evaluateViaAdapter(
      "Write",
      { file_path: join(mainCheckout, "docs.md") },
      worktree,
      { CLAUDE_PROJECT_DIR: worktree, KANBAN_WORKTREE_DIR: worktree },
    );
    expect(result.block).toBe(true);
    expect(result.reason).toBeTruthy();
  });

  it("allows a write inside the authorized worktree routed through the herdr adapter", () => {
    const result = evaluateViaAdapter(
      "Edit",
      { file_path: join(worktree, "seed.md") },
      worktree,
      { CLAUDE_PROJECT_DIR: worktree, KANBAN_WORKTREE_DIR: worktree },
    );
    expect(result.block).toBe(false);
  });

  it("returns block:false for a tool it does not cover", async () => {
    const result = evaluateViaAdapter("Read", { file_path: join(worktree, "seed.md") }, worktree);
    expect(result.block).toBe(false);
  });
});
