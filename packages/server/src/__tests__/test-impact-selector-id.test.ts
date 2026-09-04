import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  NO_SELECTOR_ID,
  parseSelectorId,
  resolveSelectorId,
} from "../services/test-impact-selector-id.js";
import { IMPACT_TOOL_RELATIVE_PATH } from "../services/test-impact-outcome.service.js";
import { IMPACT_MAP_PATH } from "../services/test-impact-map.service.js";

/**
 * The selector-identity component of the merge-gate verification key (#958).
 *
 * Two properties matter, and they pull in opposite directions:
 *  - a REAL id must reach the key, or a selector bump replays a stale green;
 *  - every failure must resolve to `""`, or a project that does not use the selector has its
 *    banked greens invalidated — and, worse, a flaky resolve would make the key vary run to run
 *    and quietly retire the memo altogether.
 */

const roots: string[] = [];

function makeWorktree(withTool: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-selector-id-"));
  roots.push(dir);
  if (withTool) {
    const toolPath = join(dir, IMPACT_TOOL_RELATIVE_PATH);
    mkdirSync(dirname(toolPath), { recursive: true });
    writeFileSync(toolPath, "// stand-in; every test injects runCommand\n");
  }
  return dir;
}

function cleanup(): void {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** A `runCommand` that records what it was asked and returns a canned result. */
function stubRun(result: { exitCode?: number; stdout?: string; stderr?: string }) {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const run = async (input: { cwd: string; args: string[]; timeoutMs: number }) => {
    calls.push({ cwd: input.cwd, args: input.args });
    return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { run, calls };
}

const silent = () => {};

describe("parseSelectorId", () => {
  it("accepts the tool's documented shape", () => {
    expect(parseSelectorId("ti1:0679b6655ff3138c17ba\n")).toBe("ti1:0679b6655ff3138c17ba");
  });

  it("takes the LAST line, so a notice printed above the answer is not mistaken for it", () => {
    expect(parseSelectorId("warning: config is stale\nti1:0679b6655ff3138c17ba\n")).toBe("ti1:0679b6655ff3138c17ba");
  });

  it("rejects anything that is not an id rather than keying the memo on it", () => {
    // Each of these, taken literally, would be a cache key. A varying one silently disables the
    // memo; a shared one silently reuses a pass across different selectors.
    for (const bad of ["", "\n", "no id here", "ti1:", "ti1:xyz", "0679b6655ff3138c17ba", "Selecting tests..."]) {
      expect(parseSelectorId(bad)).toBe(NO_SELECTOR_ID);
    }
  });
});

describe("resolveSelectorId", () => {
  it("returns the id the tool printed, stamped with the map it will select against", async () => {
    // #1018 appended `map=<stamp>`: the map left the tree hash, so a rebuild between two runs on
    // the same merged tree would otherwise reuse a banked pass earned against a different map.
    const dir = makeWorktree(true);
    const { run, calls } = stubRun({ stdout: "ti1:0679b6655ff3138c17ba\n" });
    expect(await resolveSelectorId({ workingDir: dir, runCommand: run, log: silent }))
      .toBe("ti1:0679b6655ff3138c17ba map=absent");
    // The ORDERING guarantee in one assertion: `selector-id`, never `select`. `select` needs an
    // inventory, and the memo key is read before the gate resolves — sourcing the component from
    // `select --json`'s `selectorId` is exactly the dependency #958 exists to avoid.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("selector-id");
    expect(calls[0]!.args).not.toContain("select");
    expect(calls[0]!.cwd).toBe(dir);
    cleanup();
  });

  it("passes selection-affecting flags through, so a pinned score floor keys differently", async () => {
    const dir = makeWorktree(true);
    const { run, calls } = stubRun({ stdout: "ti1:3b18c41daef985e7dc5f\n" });
    await resolveSelectorId({ workingDir: dir, selectorArgs: ["--min-score", "5"], runCommand: run, log: silent });
    expect(calls[0]!.args.slice(-3)).toEqual(["selector-id", "--min-score", "5"]);
    cleanup();
  });

  it("is a stable empty value when the skill is not materialized — the common case", async () => {
    // Almost every project. It must not spawn anything, and it must not churn the key.
    const dir = makeWorktree(false);
    const { run, calls } = stubRun({ stdout: "ti1:0679b6655ff3138c17ba\n" });
    expect(await resolveSelectorId({ workingDir: dir, runCommand: run, log: silent })).toBe(NO_SELECTOR_ID);
    expect(calls).toHaveLength(0);
    cleanup();
  });

  it("is a stable empty value with no worktree at all", async () => {
    expect(await resolveSelectorId({ workingDir: null, log: silent })).toBe(NO_SELECTOR_ID);
    expect(await resolveSelectorId({ workingDir: undefined, log: silent })).toBe(NO_SELECTOR_ID);
  });

  it("degrades to empty — never throws, never a partial key — on every tool failure", async () => {
    const dir = makeWorktree(true);
    const failures = [
      { exitCode: 2, stderr: "no inventory" },
      { exitCode: 1, stdout: "boom" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "not an id\n" },
    ];
    for (const failure of failures) {
      const { run } = stubRun(failure);
      expect(await resolveSelectorId({ workingDir: dir, runCommand: run, log: silent })).toBe(NO_SELECTOR_ID);
    }
    cleanup();
  });

  it("degrades to empty when the spawn itself throws", async () => {
    const dir = makeWorktree(true);
    const run = async () => {
      throw new Error("EACCES");
    };
    expect(await resolveSelectorId({ workingDir: dir, runCommand: run, log: silent })).toBe(NO_SELECTOR_ID);
    cleanup();
  });

  it("resolves against a REAL impact.mjs with no inventory built — the ordering pin", async () => {
    // #958's ordering constraint made executable: the memo key is read BEFORE the gate resolves,
    // so `selector-id` must answer in a repo where `build` has never run. A stand-in script
    // rather than the skill itself, because the skill is not materialized into this worktree —
    // what is pinned here is that the resolver reads NOTHING but the tool's stdout: no inventory,
    // no git history, no working tree.
    const dir = makeWorktree(false);
    const toolPath = join(dir, IMPACT_TOOL_RELATIVE_PATH);
    mkdirSync(dirname(toolPath), { recursive: true });
    writeFileSync(
      toolPath,
      [
        "if (process.argv[2] !== 'selector-id') { console.error('needs an inventory'); process.exit(2); }",
        "console.log('ti1:0679b6655ff3138c17ba');",
      ].join("\n"),
    );
    expect(await resolveSelectorId({ workingDir: dir, log: silent })).toBe("ti1:0679b6655ff3138c17ba map=absent");
    cleanup();
  });
});

describe("the map stamp in the selector component (#1018)", () => {
  /** Put a map with the given header stamp into a worktree. */
  function writeMap(dir: string, header: string): void {
    const mapPath = join(dir, ...IMPACT_MAP_PATH.split("/"));
    mkdirSync(dirname(mapPath), { recursive: true });
    writeFileSync(mapPath, header);
  }

  it("reads the stamp out of the map's header", async () => {
    const dir = makeWorktree(true);
    writeMap(dir, '{"format":"test-impact 1","commit":"8a0f35d793","generated":"2026-09-04T09:15:32.094Z"}\n');
    const { run } = stubRun({ stdout: "ti1:0679b6655ff3138c17ba\n" });
    expect(await resolveSelectorId({ workingDir: dir, runCommand: run, log: silent }))
      .toBe("ti1:0679b6655ff3138c17ba map=8a0f35d793");
    cleanup();
  });

  it("keys two different maps differently on the same selector — the whole point", async () => {
    const before = makeWorktree(true);
    const after = makeWorktree(true);
    writeMap(before, '{"commit":"aaaaaaaaaa"}\n');
    writeMap(after, '{"commit":"bbbbbbbbbb"}\n');
    const stdout = "ti1:0679b6655ff3138c17ba\n";
    const a = await resolveSelectorId({ workingDir: before, runCommand: stubRun({ stdout }).run, log: silent });
    const b = await resolveSelectorId({ workingDir: after, runCommand: stubRun({ stdout }).run, log: silent });
    expect(a).not.toBe(b);
    cleanup();
  });

  it("does not parse the whole map — only its header is read", async () => {
    // The map is ~1.4 MB of one-entry-per-line JSON and this runs on the merge path, so the
    // stamp is read from the first few KB. A body too large to sit in that window (and, here,
    // deliberately not even valid JSON) must not change the answer.
    const dir = makeWorktree(true);
    writeMap(dir, `{"commit":"cccccccccc","entries":{\n${"x".repeat(200_000)}`);
    const { run } = stubRun({ stdout: "ti1:0679b6655ff3138c17ba\n" });
    expect(await resolveSelectorId({ workingDir: dir, runCommand: run, log: silent }))
      .toBe("ti1:0679b6655ff3138c17ba map=cccccccccc");
    cleanup();
  });

  it("says `absent` for a map whose header carries no stamp, rather than failing", async () => {
    // Two runs that both selected without a usable inventory SHOULD share a key: each widened to
    // the package tier, which is the same, stronger claim.
    const dir = makeWorktree(true);
    writeMap(dir, "not json at all\n");
    const { run } = stubRun({ stdout: "ti1:0679b6655ff3138c17ba\n" });
    expect(await resolveSelectorId({ workingDir: dir, runCommand: run, log: silent }))
      .toBe("ti1:0679b6655ff3138c17ba map=absent");
    cleanup();
  });

  it("adds no stamp when there is no selector — an absent component stays exactly empty", async () => {
    // The #958 no-churn rule: a project that does not use the selector must hash the same bytes
    // it hashed before, so `map=` must never appear on its own.
    const dir = makeWorktree(false);
    writeMap(dir, '{"commit":"8a0f35d793"}\n');
    expect(await resolveSelectorId({ workingDir: dir, log: silent })).toBe(NO_SELECTOR_ID);
    cleanup();
  });
});
