// Imports scripts/cli-json.mjs directly, so `vitest related`/the impact selector already
// reaches this suite from a change to that script — no `@gate:always-run` marker needed (#1109).
import { describe, expect, it } from "vitest";
import { buildCliArgs, buildPnpmExecArgs } from "../../../../scripts/cli-json.mjs";

describe("cli-json.mjs arg building (#1109)", () => {
  it("strips a leading `--` separator", () => {
    expect(buildCliArgs(["--", "issue", "get", "1", "--json"])).toEqual(["issue", "get", "1", "--json"]);
  });

  it("passes args through unchanged when there is no separator", () => {
    expect(buildCliArgs(["issue", "get", "1", "--json"])).toEqual(["issue", "get", "1", "--json"]);
  });

  it("builds a pnpm exec invocation that runs the CLI directly, not via a named script", () => {
    const args = buildPnpmExecArgs(["issue", "get", "1", "--json"]);
    expect(args[0]).toBe("--filter");
    expect(args).not.toContain("run");
    expect(args).toContain("src/cli/index.ts");
    expect(args.slice(args.indexOf("src/cli/index.ts") + 1)).toEqual(["issue", "get", "1", "--json"]);
  });
});
