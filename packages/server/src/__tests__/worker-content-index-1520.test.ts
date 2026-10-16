import { describe, expect, it } from "vitest";
import {
  checkContentIndexing,
  markDirsNotIndexed,
  parseNotIndexed,
  workerDataDirs,
  type AttribRunner,
} from "../worker/worker-content-index.js";

const DIR = "C:\\Users\\x\\.agentic-kanban";

describe("worker content-index (#1520)", () => {
  it("parses the attrib flag column", () => {
    expect(parseNotIndexed(`     I      ${DIR}\r\n`, DIR)).toBe(true);
    expect(parseNotIndexed(`            ${DIR}\r\n`, DIR)).toBe(false);
    expect(parseNotIndexed("", DIR)).toBeNull();
  });

  it("lists home data dir, work root and temp once each", () => {
    expect(workerDataDirs("W", "H", "T")).toEqual([expect.stringContaining(".agentic-kanban"), "W", "T"]);
    expect(workerDataDirs(undefined, "H", "T")).toHaveLength(2);
  });

  it("sets +I only on indexed dirs, and nothing off Windows", async () => {
    const calls: string[][] = [];
    const run: AttribRunner = async (args) => {
      calls.push(args);
      return { ok: true, output: args[0] === "+I" ? "" : `            ${args[0]}\r\n` };
    };
    expect(await markDirsNotIndexed([DIR], "win32", run, () => true)).toEqual([DIR]);
    expect(calls.some((c) => c[0] === "+I" && c[1] === DIR)).toBe(true);
    calls.length = 0;
    expect(await markDirsNotIndexed([DIR], "linux", run, () => true)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("doctor warns for an indexed dir, passes when flagged, is absent off Windows", async () => {
    const indexed: AttribRunner = async (a) => ({ ok: true, output: `            ${a[0]}\r\n` });
    const flagged: AttribRunner = async (a) => ({ ok: true, output: `     I      ${a[0]}\r\n` });
    expect((await checkContentIndexing(undefined, "win32", indexed, [DIR], () => true))?.status).toBe("warn");
    expect((await checkContentIndexing(undefined, "win32", flagged, [DIR], () => true))?.status).toBe("pass");
    expect(await checkContentIndexing(undefined, "linux", indexed, [DIR], () => true)).toBeNull();
  });
});
