// @gate:always-run when:package.json — reads the root package.json engines.node and pins it to BOARD_NODE_ENGINES (#1457).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BOARD_NODE_ENGINES, nodeSatisfiesEngines } from "../lib/node-engines.js";

describe("node-engines (#1457)", () => {
  it("root package.json engines.node is the one declared range", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../../../package.json"), "utf8"));
    expect(pkg.engines.node).toBe(BOARD_NODE_ENGINES);
  });

  it.each([
    ["v22.0.0", true], ["v22.12.1", true], ["v23.7.0", false], ["v24.0.0", true], ["v21.9.0", false], ["v20.12.0", false],
  ])("%s -> %s", (v, ok) => {
    expect(nodeSatisfiesEngines(v)).toBe(ok);
  });

  it("returns null for an unparseable version", () => {
    expect(nodeSatisfiesEngines("nope")).toBeNull();
  });
});
