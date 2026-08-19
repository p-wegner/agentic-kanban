// @gate:always-run — scans the mcp-server tools tree for hand-built error envelopes; imports nothing it checks (#538/#617).
/**
 * #617 (ring R17) — one spelling for an MCP error return.
 *
 * `db-utils.ts` has shipped `mcpError`/`mcpStructuredError` since #617's predecessor, but
 * 36 tools still hand-built `{ content: [{ type: "text", text: `Error: …` }] }` and seven
 * carried a private `const text = (v) => …` clone. The envelope itself is now one function
 * (#508); this pins the second half — an ERROR return says `mcpError`, so a reader can tell
 * a failure path from a payload path without reading the string.
 *
 * `mcpText` is not banned: it is the general wrapper and most returns are payloads. What is
 * banned is `mcpText("Error: …")`, which is an error wearing the payload spelling.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TOOLS_DIR = join(import.meta.dirname, "..", "tools");

describe("MCP error spelling (#617)", () => {
  it("no tool hand-builds the text envelope", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(TOOLS_DIR).filter(x => x.endsWith(".ts"))) {
      const src = readFileSync(join(TOOLS_DIR, f), "utf8");
      // A private `const text = (v) => ({content: …})` clone, or the literal envelope.
      if (/content:\s*\[\s*\{\s*type:\s*"text"/.test(src)) offenders.push(f);
    }
    // `set-preference` keeps two literals because they also carry `isError: true`, which
    // the envelope helper does not model — see the #508 commit message.
    expect(offenders).toEqual(["set-preference.ts"]);
  });

  it("error returns use mcpError, not mcpText with an Error string", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(TOOLS_DIR).filter(x => x.endsWith(".ts"))) {
      const src = readFileSync(join(TOOLS_DIR, f), "utf8");
      if (/mcpText\((?:`Error|"Error)/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
