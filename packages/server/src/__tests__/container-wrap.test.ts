import { describe, expect, it } from "vitest";
import type { DevcontainerHandle } from "@agentic-kanban/shared/lib/devcontainer-exec";
import {
  containerCommandFor,
  translateHostPathsInArg,
  wrapLaunchConfigForContainer,
} from "../services/agent-provider/container-wrap.js";
import type { AgentLaunchConfig } from "../services/agent-provider/types.js";

const HANDLE: DevcontainerHandle = {
  containerId: "abc123",
  remoteUser: "node",
  remoteWorkspaceFolder: "/workspaces/taskflow",
};

const MAPPINGS = [
  { hostPrefix: "C:\\worktrees\\ak-42", containerPrefix: "/workspaces/taskflow" },
  { hostPrefix: "C:\\Users\\dev\\.claude", containerPrefix: "/home/node/.claude" },
];

function baseConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    command: "claude",
    args: ["--output-format", "stream-json", "-p"],
    useShell: false,
    isMockAgent: false,
    env: {},
    ...overrides,
  };
}

describe("translateHostPathsInArg", () => {
  it("translates a bare host path to its container equivalent", () => {
    expect(translateHostPathsInArg("C:\\worktrees\\ak-42", MAPPINGS)).toBe("/workspaces/taskflow");
  });

  it("translates a path embedded in a larger argument", () => {
    // Providers emit `--mcp-config=<path>` as ONE argv entry; whole-string
    // matching would silently leave a host path pointing nowhere in the container.
    expect(
      translateHostPathsInArg("--mcp-config=C:\\worktrees\\ak-42\\.mcp.json", MAPPINGS),
    ).toBe("--mcp-config=/workspaces/taskflow/.mcp.json");
  });

  it("translates the claude profile settings path so --settings resolves inside the container", () => {
    expect(
      translateHostPathsInArg("C:\\Users\\dev\\.claude\\settings_anth.json", MAPPINGS),
    ).toBe("/home/node/.claude/settings_anth.json");
  });

  it("matches regardless of separator style and case", () => {
    expect(translateHostPathsInArg("c:/worktrees/AK-42/src/app.ts", MAPPINGS)).toBe(
      "/workspaces/taskflow/src/app.ts",
    );
  });

  it("converts backslashes to forward slashes in the translated remainder", () => {
    expect(translateHostPathsInArg("C:\\worktrees\\ak-42\\src\\app.ts", MAPPINGS)).toBe(
      "/workspaces/taskflow/src/app.ts",
    );
  });

  it("prefers the longest matching prefix so nested mappings are not shadowed", () => {
    const nested = [
      { hostPrefix: "C:\\repos", containerPrefix: "/repos" },
      { hostPrefix: "C:\\repos\\inner", containerPrefix: "/workspaces/inner" },
    ];
    expect(translateHostPathsInArg("C:\\repos\\inner\\a.ts", nested)).toBe(
      "/workspaces/inner/a.ts",
    );
  });

  it("leaves unrelated arguments byte-for-byte untouched", () => {
    expect(translateHostPathsInArg("--output-format", MAPPINGS)).toBe("--output-format");
    expect(translateHostPathsInArg("stream-json", MAPPINGS)).toBe("stream-json");
  });
});

describe("containerCommandFor", () => {
  it("reduces a host-resolved Windows absolute path to the bare program name", () => {
    // Regression: the live containerized launch died with exit 127,
    // `exec: "C:\\Users\\pwegner\\.local\\bin\\claude.exe": executable file not
    // found in $PATH`, because claude-provider resolves the command via
    // `where claude.exe` on the HOST before the config reaches the wrapper.
    expect(containerCommandFor("C:\\Users\\pwegner\\.local\\bin\\claude.exe")).toBe("claude");
  });

  it("strips the other Windows executable suffixes", () => {
    expect(containerCommandFor("C:\\tools\\codex.cmd")).toBe("codex");
    expect(containerCommandFor("C:\\tools\\agent.bat")).toBe("agent");
    expect(containerCommandFor("C:\\tools\\agent.ps1")).toBe("agent");
  });

  it("reduces a POSIX absolute path to the bare program name", () => {
    expect(containerCommandFor("/usr/local/bin/claude")).toBe("claude");
  });

  it("leaves a bare command untouched so the container PATH resolves it", () => {
    expect(containerCommandFor("claude")).toBe("claude");
    expect(containerCommandFor("docker")).toBe("docker");
  });
});

describe("wrapLaunchConfigForContainer", () => {
  it("passes the bare agent name to docker exec, never the host binary path", () => {
    const wrapped = wrapLaunchConfigForContainer(
      baseConfig({ command: "C:\\Users\\pwegner\\.local\\bin\\claude.exe" }),
      { handle: HANDLE, pathMappings: MAPPINGS },
    );
    const idIndex = wrapped.args.indexOf("abc123");
    expect(wrapped.args[idIndex + 1]).toBe("claude");
    expect(wrapped.args.some((a) => a.toLowerCase().includes(".exe"))).toBe(false);
  });

  it("routes the agent through docker exec against the provisioned container", () => {
    const wrapped = wrapLaunchConfigForContainer(baseConfig(), {
      handle: HANDLE,
      pathMappings: MAPPINGS,
    });
    expect(wrapped.command).toBe("docker");
    expect(wrapped.args.slice(0, 6)).toEqual([
      "exec",
      "-i",
      "-u",
      "node",
      "-w",
      "/workspaces/taskflow",
    ]);
    expect(wrapped.args).toContain("abc123");
  });

  it("keeps the agent command and its flags in order after the container id", () => {
    const wrapped = wrapLaunchConfigForContainer(baseConfig(), {
      handle: HANDLE,
      pathMappings: MAPPINGS,
    });
    const idIndex = wrapped.args.indexOf("abc123");
    expect(wrapped.args.slice(idIndex + 1)).toEqual([
      "claude",
      "--output-format",
      "stream-json",
      "-p",
    ]);
  });

  it("forces useShell false so the agent stays detachable", () => {
    // shouldDetachAgent() refuses to detach a shell-spawned agent, and a
    // non-detached agent does not survive a tsx hot-reload. Routing through the
    // `devcontainer` .cmd shim would have required shell:true; docker must not.
    const wrapped = wrapLaunchConfigForContainer(baseConfig({ useShell: true }), {
      handle: HANDLE,
      pathMappings: MAPPINGS,
    });
    expect(wrapped.useShell).toBe(false);
  });

  it("forwards agent-relevant env into the container as -e flags", () => {
    const wrapped = wrapLaunchConfigForContainer(
      baseConfig({ env: { ANTHROPIC_BASE_URL: "https://example.test", KANBAN_SERVER_PORT: "3001" } }),
      { handle: HANDLE, pathMappings: MAPPINGS },
    );
    expect(wrapped.args).toContain("ANTHROPIC_BASE_URL=https://example.test");
    expect(wrapped.args).toContain("KANBAN_SERVER_PORT=3001");
    // The docker CLI must not inherit the agent's credential env on the host side.
    expect(wrapped.env).toEqual({});
  });

  it("never forwards the host PATH, which would clobber the container's own", () => {
    // Regression: a live containerized launch exited 127 with
    // `exec: "claude": executable file not found in $PATH` because
    // buildSpawnEnv() returns a full copy of the host process.env, so
    // `-e PATH=C:\Windows\...` replaced the container's Linux PATH.
    const wrapped = wrapLaunchConfigForContainer(
      baseConfig({
        env: {
          PATH: "C:\\Windows\\system32;C:\\Users\\dev\\.local\\bin",
          HOME: "C:\\Users\\dev",
          USERPROFILE: "C:\\Users\\dev",
          SystemRoot: "C:\\Windows",
          ANTHROPIC_API_KEY: "sk-test",
        },
      }),
      { handle: HANDLE, pathMappings: MAPPINGS },
    );
    expect(wrapped.args.some((a) => a.startsWith("PATH="))).toBe(false);
    expect(wrapped.args.some((a) => a.startsWith("HOME="))).toBe(false);
    expect(wrapped.args.some((a) => a.startsWith("USERPROFILE="))).toBe(false);
    expect(wrapped.args.some((a) => a.startsWith("SystemRoot="))).toBe(false);
    // ...while the credential the agent actually needs still crosses.
    expect(wrapped.args).toContain("ANTHROPIC_API_KEY=sk-test");
  });

  it("forwards proxy configuration, which the container cannot infer", () => {
    const wrapped = wrapLaunchConfigForContainer(
      baseConfig({ env: { HTTPS_PROXY: "http://proxy.corp:8080" } }),
      { handle: HANDLE, pathMappings: MAPPINGS },
    );
    expect(wrapped.args).toContain("HTTPS_PROXY=http://proxy.corp:8080");
  });

  it("translates host paths inside the forwarded agent arguments", () => {
    const wrapped = wrapLaunchConfigForContainer(
      baseConfig({ args: ["--mcp-config", "C:\\worktrees\\ak-42\\.mcp.json", "-p"] }),
      { handle: HANDLE, pathMappings: MAPPINGS },
    );
    expect(wrapped.args).toContain("/workspaces/taskflow/.mcp.json");
    expect(wrapped.args.some((a) => a.includes("C:\\"))).toBe(false);
  });

  it("preserves the stdin-handling contract the providers rely on", () => {
    const wrapped = wrapLaunchConfigForContainer(
      baseConfig({ suppressStdinPrompt: true, keepStdinOpen: true, promptPrefix: "PREFIX" }),
      { handle: HANDLE, pathMappings: MAPPINGS },
    );
    expect(wrapped.suppressStdinPrompt).toBe(true);
    expect(wrapped.keepStdinOpen).toBe(true);
    expect(wrapped.promptPrefix).toBe("PREFIX");
  });
});
