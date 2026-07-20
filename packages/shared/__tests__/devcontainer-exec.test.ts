import { describe, expect, it } from "vitest";
import {
  formatBindMount,
  parseDevcontainerUpResult,
} from "../src/lib/devcontainer-exec.js";

// A trimmed but faithful sample: the CLI streams a timestamped progress log to
// stdout and terminates with a single JSON result object.
const REAL_UP_OUTPUT = `[2026-07-20T00:25:23.295Z] @devcontainers/cli 0.87.0. Node.js v24.18.0. win32 10.0.26200 x64.
[2026-07-20T00:25:26.212Z] Error fetching image details: No manifest found for mcr.microsoft.com/devcontainers/typescript-node:22.
[2026-07-20T00:25:58.623Z] Container started
[2026-07-20T00:26:00.519Z] Running the postCreateCommand from devcontainer.json...

{"outcome":"success","containerId":"2eac86a70ee674984307e2244066287142daa6265794b78b453ba43b6f7de966","remoteUser":"node","remoteWorkspaceFolder":"/workspaces/taskflow"}
`;

describe("parseDevcontainerUpResult", () => {
  it("extracts the handle from real devcontainer up output", () => {
    const handle = parseDevcontainerUpResult(REAL_UP_OUTPUT);
    expect(handle).toEqual({
      containerId: "2eac86a70ee674984307e2244066287142daa6265794b78b453ba43b6f7de966",
      remoteUser: "node",
      remoteWorkspaceFolder: "/workspaces/taskflow",
    });
  });

  it("ignores the progress log even when a line mentions an error", () => {
    // The sample above contains "Error fetching image details" on a run that
    // SUCCEEDED (the image was simply pulled rather than resolved from cache).
    // Treating stderr-ish log text as failure would break the happy path.
    expect(parseDevcontainerUpResult(REAL_UP_OUTPUT)).toBeDefined();
  });

  it("returns undefined when the outcome is not success", () => {
    const output = '{"outcome":"error","message":"docker daemon not running"}';
    expect(parseDevcontainerUpResult(output)).toBeUndefined();
  });

  it("returns undefined when the result lacks a containerId", () => {
    const output = '{"outcome":"success","remoteWorkspaceFolder":"/workspaces/x"}';
    expect(parseDevcontainerUpResult(output)).toBeUndefined();
  });

  it("returns undefined when the result lacks a remoteWorkspaceFolder", () => {
    // Without the container-side folder the hot path has no valid -w to pass.
    const output = '{"outcome":"success","containerId":"abc"}';
    expect(parseDevcontainerUpResult(output)).toBeUndefined();
  });

  it("returns undefined for output with no JSON at all", () => {
    expect(parseDevcontainerUpResult("[log] nothing here\n")).toBeUndefined();
  });

  it("handles CRLF line endings", () => {
    const crlf = REAL_UP_OUTPUT.replace(/\n/g, "\r\n");
    expect(parseDevcontainerUpResult(crlf)?.remoteUser).toBe("node");
  });

  it("defaults remoteUser to root when the CLI omits it", () => {
    const output = '{"outcome":"success","containerId":"abc","remoteWorkspaceFolder":"/w"}';
    expect(parseDevcontainerUpResult(output)?.remoteUser).toBe("root");
  });

  it("takes the last result object when several are present", () => {
    const output = [
      '{"outcome":"success","containerId":"old","remoteWorkspaceFolder":"/w"}',
      '{"outcome":"success","containerId":"new","remoteWorkspaceFolder":"/w"}',
    ].join("\n");
    expect(parseDevcontainerUpResult(output)?.containerId).toBe("new");
  });
});

describe("formatBindMount", () => {
  it("emits a docker-style bind descriptor", () => {
    expect(
      formatBindMount({ source: "C:/Users/dev/.claude-agent", target: "/home/node/.claude" }),
    ).toBe("type=bind,source=C:/Users/dev/.claude-agent,target=/home/node/.claude");
  });
});
