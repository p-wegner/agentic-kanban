import { describe, expect, it } from "vitest";
import {
  buildContainerSetupSpec,
  type SetupScriptContainer,
} from "../src/lib/setup-script.js";

const CONTAINER: SetupScriptContainer = {
  containerId: "abc123",
  remoteUser: "node",
  remoteWorkspaceFolder: "/workspaces/taskflow",
};

describe("buildContainerSetupSpec", () => {
  it("dispatches the setup script into the container via docker exec", () => {
    // Regression (#135): a host-run `pnpm install` materializes node_modules as
    // symlinks into the HOST package store, so on Windows every link target is a
    // Windows path and nothing resolves inside a Linux container — the agent
    // could write code but not run tests ("Cannot find module .../vitest.mjs").
    const spec = buildContainerSetupSpec("pnpm install -r", CONTAINER);
    expect(spec.command).toBe("docker");
    expect(spec.args).toEqual([
      "exec",
      "-u",
      "node",
      "-w",
      "/workspaces/taskflow",
      "abc123",
      "/bin/sh",
      "-c",
      "pnpm install -r",
    ]);
  });

  it("uses the container's view of the worktree, never the host path", () => {
    const spec = buildContainerSetupSpec("npm ci", CONTAINER);
    expect(spec.args).toContain("/workspaces/taskflow");
    expect(spec.args.some((a) => a.includes("C:\\"))).toBe(false);
  });

  it("passes the script as a single argument so quoting survives", () => {
    // #111 is the host-side counterpart: a legitimately-quoted setup script must
    // not be re-split or re-escaped on its way to the shell.
    const script = 'node -e "console.log(\'hi\')"';
    const spec = buildContainerSetupSpec(script, CONTAINER);
    expect(spec.args[spec.args.length - 1]).toBe(script);
    expect(spec.args.filter((a) => a === script)).toHaveLength(1);
  });

  it("runs as the container's remote user, not root by default", () => {
    const spec = buildContainerSetupSpec("ls", { ...CONTAINER, remoteUser: "vscode" });
    expect(spec.args[spec.args.indexOf("-u") + 1]).toBe("vscode");
  });
});
