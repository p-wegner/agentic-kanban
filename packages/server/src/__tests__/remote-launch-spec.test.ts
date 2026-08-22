// #747 — a launch spec sent to a fleet worker must not bake in the BOARD's OS.
//
// The regression these tests exist for: the spec was built from a provider launch config
// resolved against the board's own platform, so a Windows board sent a Linux worker
// `C:\Users\...\claude.exe` (ENOENT) and a Linux board sent a Windows worker a bare
// `claude` with `shell: false` (cannot resolve the `.cmd` shim). Only same-OS fleets
// worked, and nothing tested it because every fleet e2e suite runs one machine.
//
// The two halves are tested separately because they live on separate machines: the board
// builds INTENT (no absolute path, no shell decision), and the worker resolves that intent
// against its own platform.

import { describe, it, expect, vi } from "vitest";
import {
  buildLaunchIntent,
  buildRemoteLaunchSpec,
  logicalProgramName,
  looksHostAbsolutePath,
  relativizeAttachmentArgs,
  stripHostPathArgs,
  undoDirectEntryArgs,
  type RemoteLaunchSpecParams,
} from "../services/remote-launch-spec.js";
import { resolveSpecCommand } from "../worker/worker-command-resolver.js";
import { parseBoardToWorkerMessage } from "@agentic-kanban/shared/lib/worker-protocol";

/** A claude launch config exactly as a WINDOWS board builds it. */
const WINDOWS_CLAUDE_CONFIG = {
  command: "C:\\Users\\board\\AppData\\Roaming\\npm\\claude.exe",
  args: [
    "--output-format", "stream-json", "--verbose",
    "--mcp-config", "C:\\Users\\board\\AppData\\Local\\Temp\\agentic-kanban-mcp-config.json",
    "--settings", "C:\\Users\\board\\.claude\\settings_anth.json",
    "--model", "opus",
    "-p",
  ],
  useShell: false,
  keepStdinOpen: false,
};

function params(overrides: Partial<RemoteLaunchSpecParams> = {}): RemoteLaunchSpecParams {
  return {
    config: { ...WINDOWS_CLAUDE_CONFIG },
    env: {},
    cwd: "C:\\projects\\board\\.worktrees\\feature-747",
    stdinPrompt: "do the ticket",
    provider: "claude",
    trueRemote: true,
    explicitCommand: false,
    ...overrides,
  };
}

describe("remote launch spec: no board-OS assumptions (#747)", () => {
  it("THE REGRESSION: a spec for a non-Windows worker carries no Windows-absolute path and no shell decision", () => {
    const spec = buildRemoteLaunchSpec(params());

    // The command is the logical program, not this machine's resolved binary.
    expect(spec.command).toBe("claude");
    expect(spec.command).not.toMatch(/^[A-Za-z]:[\\/]/);
    expect(spec.command).not.toMatch(/\.exe$/i);

    // No argument names a path on the board.
    for (const arg of spec.args) {
      expect(looksHostAbsolutePath(arg), `arg carries a host path: ${arg}`).toBe(false);
      expect(arg).not.toMatch(/^[A-Za-z]:[\\/]/);
      expect(arg).not.toContain("\\");
    }

    // `useShell` is the worker's decision. A board-derived value here IS the bug: it is
    // computed from the BOARD's process.platform and would be wrong for any other OS.
    expect(spec.useShell).toBeUndefined();
    expect("useShell" in spec).toBe(false);

    // And the intent says what to launch, so the worker can do the resolving.
    expect(spec.intent).toEqual({ provider: "claude", program: "claude" });

    // Belt and braces: nothing anywhere in the serialized spec looks like a drive path.
    expect(JSON.stringify({ command: spec.command, args: spec.args, intent: spec.intent }))
      .not.toMatch(/[A-Za-z]:\\\\/);
  });

  it("keeps a same-filesystem spec byte-for-byte as the board built it", () => {
    const spec = buildRemoteLaunchSpec(params({ trueRemote: false }));
    expect(spec.command).toBe(WINDOWS_CLAUDE_CONFIG.command);
    expect(spec.args).toEqual(WINDOWS_CLAUDE_CONFIG.args);
    expect(spec.useShell).toBe(false);
    expect(spec.intent).toBeUndefined();
  });

  it("an explicit agentCommand travels verbatim (minus the unusable MCP config)", () => {
    const spec = buildRemoteLaunchSpec(params({
      config: { command: "node", args: ["/tmp/mock-agent.cjs", "--mcp-config", "/tmp/x.json"], useShell: false, isMockAgent: true },
      explicitCommand: true,
    }));
    expect(spec.command).toBe("node");
    expect(spec.intent).toBeUndefined();
    expect(spec.args).toEqual(["/tmp/mock-agent.cjs"]);
  });

  it("drops --settings, because a board profile is a credential that never leaves this machine", () => {
    const spec = buildRemoteLaunchSpec(params());
    expect(spec.args).not.toContain("--settings");
    expect(spec.args.some((a) => a.includes("settings_anth.json"))).toBe(false);
    // The non-path flags survive untouched — this is a projection, not a rewrite.
    expect(spec.args).toEqual(["--output-format", "stream-json", "--verbose", "--model", "opus", "-p"]);
  });

  it("rewrites codex's board-side direct-entry form into the plain program", () => {
    const spec = buildRemoteLaunchSpec(params({
      provider: "codex",
      config: {
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: ["C:\\Users\\board\\AppData\\Roaming\\npm\\codex\\bin.js", "exec", "--json"],
        useShell: true,
      },
    }));
    expect(spec.intent).toEqual({ provider: "codex", program: "codex" });
    expect(spec.command).toBe("codex");
    expect(spec.args).toEqual(["exec", "--json"]);
  });

  it("relativizes copilot attachments, which now land in the worker's own checkout root", () => {
    const spec = buildRemoteLaunchSpec(params({
      provider: "copilot",
      config: {
        command: "C:\\Users\\board\\AppData\\Roaming\\npm\\copilot.cmd",
        args: ["--attachment", "C:\\projects\\board\\.worktrees\\feature-747\\CLAUDE.local.md", "-p", "go"],
        useShell: true,
      },
    }));
    expect(spec.intent).toEqual({ provider: "copilot", program: "copilot" });
    expect(spec.args).toEqual(["--attachment", "CLAUDE.local.md", "-p", "go"]);
  });

  it("warns rather than silently mangling argv when a host path survives", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const spec = buildRemoteLaunchSpec(params({
        config: { command: "claude", args: ["--add-dir", "C:\\projects\\board\\other"], useShell: false },
      }));
      // The unknown flag's value is NOT dropped — that could corrupt argv worse than the
      // path itself — but the operator is told.
      expect(spec.args).toContain("C:\\projects\\board\\other");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("board-host path argument"));
    } finally {
      warn.mockRestore();
    }
  });

  it("survives the wire: intent parses back on the worker", () => {
    const spec = buildRemoteLaunchSpec(params());
    const parsed = parseBoardToWorkerMessage(JSON.stringify({ type: "assign", sessionId: "s1", spec }));
    expect(parsed?.type).toBe("assign");
    if (parsed?.type !== "assign") throw new Error("unreachable");
    expect(parsed.spec.intent).toEqual({ provider: "claude", program: "claude" });
    // `useShell` defaults to false on parse; the resolver ignores it when intent is present.
    expect(parsed.spec.command).toBe("claude");
  });

  describe("pure helpers", () => {
    it("reduces a resolved executable to its logical program name", () => {
      expect(logicalProgramName("C:\\Users\\me\\.local\\bin\\claude.exe")).toBe("claude");
      expect(logicalProgramName("/usr/local/bin/claude")).toBe("claude");
      expect(logicalProgramName("copilot.cmd")).toBe("copilot");
      expect(logicalProgramName("claude")).toBe("claude");
    });

    it("recognizes a path of the machine that built the spec", () => {
      expect(looksHostAbsolutePath("C:\\x\\y")).toBe(true);
      expect(looksHostAbsolutePath("C:/x/y")).toBe(true);
      expect(looksHostAbsolutePath("\\\\server\\share")).toBe(true);
      expect(looksHostAbsolutePath("/home/me/x")).toBe(true);
      expect(looksHostAbsolutePath("--verbose")).toBe(false);
      expect(looksHostAbsolutePath("stream-json")).toBe(false);
    });

    it("strips host-path flags in both the separated and joined forms", () => {
      expect(stripHostPathArgs(["--mcp-config=C:\\t.json", "--settings", "C:\\s.json", "-p"])).toEqual(["-p"]);
    });

    it("leaves a relative attachment alone", () => {
      expect(relativizeAttachmentArgs(["--attachment", "CLAUDE.local.md"])).toEqual(["--attachment", "CLAUDE.local.md"]);
    });

    it("only drops leading script paths, never a real subcommand", () => {
      expect(undoDirectEntryArgs(["exec", "--json"])).toEqual(["exec", "--json"]);
      expect(undoDirectEntryArgs(["/opt/codex/bin.js", "exec"])).toEqual(["exec"]);
    });

    it("derives no intent when the board is not the one choosing the binary", () => {
      expect(buildLaunchIntent(params({ trueRemote: false }))).toBeNull();
      expect(buildLaunchIntent(params({ explicitCommand: true }))).toBeNull();
    });
  });
});

describe("worker-side command resolution (#747)", () => {
  const intentSpec = { command: "claude", useShell: false, intent: { provider: "claude", program: "claude" } };

  it("a Windows worker prefers a real .exe and needs no shell", () => {
    const resolved = resolveSpecCommand(intentSpec, {
      platform: "win32",
      lookup: (p) => (p === "claude.exe" ? "C:\\Users\\worker\\bin\\claude.exe" : null),
    });
    expect(resolved).toEqual({ command: "C:\\Users\\worker\\bin\\claude.exe", useShell: false, source: "resolved" });
  });

  it("a Windows worker turns the shell ON for a .cmd shim — the Linux-board half of the bug", () => {
    const resolved = resolveSpecCommand(intentSpec, {
      platform: "win32",
      lookup: (p) => (p === "claude" ? "C:\\Users\\worker\\AppData\\Roaming\\npm\\claude.cmd" : null),
    });
    expect(resolved.useShell).toBe(true);
    expect(resolved.command).toMatch(/claude\.cmd$/);
  });

  it("a Linux worker resolves on its own PATH and never sees the board's .exe", () => {
    const resolved = resolveSpecCommand(intentSpec, {
      platform: "linux",
      lookup: (p) => (p === "claude" ? "/usr/local/bin/claude" : null),
    });
    expect(resolved).toEqual({ command: "/usr/local/bin/claude", useShell: false, source: "resolved" });
  });

  it("an unresolvable program falls back to the bare name so the spawn reports the real ENOENT", () => {
    expect(resolveSpecCommand(intentSpec, { platform: "linux", lookup: () => null })).toEqual({
      command: "claude", useShell: false, source: "unresolved",
    });
    // On Windows the shell is the last chance at a shim `where` cannot see.
    expect(resolveSpecCommand(intentSpec, { platform: "win32", lookup: () => null })).toEqual({
      command: "claude", useShell: true, source: "unresolved",
    });
  });

  it("a spec with no intent is used verbatim — same-filesystem and legacy boards are untouched", () => {
    const resolved = resolveSpecCommand(
      { command: "C:\\board\\claude.exe", useShell: true },
      { platform: "linux", lookup: () => { throw new Error("must not look up"); } },
    );
    expect(resolved).toEqual({ command: "C:\\board\\claude.exe", useShell: true, source: "spec" });
  });
});
