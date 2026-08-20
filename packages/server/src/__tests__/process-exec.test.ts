import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  parseLsofPids,
  parseNetstatListenerPids,
  parseNetstatListeners,
  parsePowerShellProcessList,
  parsePsProcessList,
  parseWmicProcessList,
  safeParsePowerShellJson,
} from "../services/process-exec.js";

const NETSTAT_SAMPLE = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       111
  TCP    127.0.0.1:3001         127.0.0.1:55555        ESTABLISHED     222
  TCP    [::]:5173              [::]:0                 LISTENING       333
  UDP    0.0.0.0:5353           *:*                                    444
`;

describe("process-exec parsers", () => {
  it("parses only TCP LISTENING and UDP rows from netstat output", () => {
    expect(parseNetstatListeners(NETSTAT_SAMPLE)).toEqual([
      { pid: 111, port: 3001, address: "0.0.0.0:3001", protocol: "tcp" },
      { pid: 333, port: 5173, address: "[::]:5173", protocol: "tcp" },
      { pid: 444, port: 5353, address: "0.0.0.0:5353", protocol: "udp" },
    ]);
    expect(parseNetstatListenerPids(NETSTAT_SAMPLE, 3001)).toEqual([111]);
  });

  it("parses lsof pid lists defensively", () => {
    expect(parseLsofPids("123\n\nabc\n456\n")).toEqual([123, 456]);
  });

  it("parses wmic process list output without ad hoc caller regexes", () => {
    const stdout = [
      "CommandLine=node C:\\repo\\server.js",
      "ParentProcessId=10",
      "ProcessId=20",
      "",
      "CommandLine=pnpm dev",
      "ParentProcessId=20",
      "ProcessId=21",
    ].join("\n");

    expect(parseWmicProcessList(stdout)).toEqual([
      { pid: 20, ppid: 10, name: "", commandLine: "node C:\\repo\\server.js" },
      { pid: 21, ppid: 20, name: "", commandLine: "pnpm dev" },
    ]);
  });

  it("sanitizes invalid control characters in PowerShell JSON process output", () => {
    const ctrl = String.fromCharCode(0x08);
    const parsed = safeParsePowerShellJson(
      `[{"ProcessId":7,"ParentProcessId":1,"Name":"node.exe","CommandLine":"node${ctrl}app.js"}]`,
    );
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsePowerShellProcessList(JSON.stringify(parsed))).toEqual([
      { pid: 7, ppid: 1, name: "node.exe", commandLine: "node app.js" },
    ]);
  });

  it("parses ps output with command arguments intact", () => {
    expect(parsePsProcessList("  10   1 node node server.js --flag\n")).toEqual([
      { pid: 10, ppid: 1, name: "node", commandLine: "node server.js --flag" },
    ]);
  });
});

describe("listOsProcesses on a runtime with no ps binary (e.g. node:*-slim Docker images)", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("degrades to an empty list instead of throwing spawn ps ENOENT", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        execFile: (...args: unknown[]) => {
          const cb = args[args.length - 1] as (err: Error) => void;
          cb(Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" }));
          return new EventEmitter() as unknown as ChildProcess;
        },
      };
    });
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const { listOsProcesses } = await import("../services/process-exec.js");
      await expect(listOsProcesses()).resolves.toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
