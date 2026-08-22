import { describe, expect, it } from "vitest";
import {
  readAgentField,
  readForkMaxParallel,
  readForkMode,
  readGuidance,
  readJoinStrategy,
  writeAgentField,
  writeForkMaxParallel,
  writeForkMode,
  writeGuidance,
  writeJoinStrategy,
} from "./workflowNodeConfig.js";

/**
 * These accessors all read and write ONE JSON document (#722), so the properties worth
 * pinning are the shared ones: a bad document reads as the default, a writer never drops a
 * key it does not own, and clearing the last key collapses back to `null` rather than "{}".
 */
describe("workflow node config codec", () => {
  it("reads defaults from an absent or unparseable config", () => {
    for (const bad of [null, "", "not json", "[1,2]", '"str"']) {
      expect(readJoinStrategy(bad)).toBe("artifacts");
      expect(readForkMode(bad)).toBe("worktree");
      expect(readGuidance(bad)).toBe("");
      expect(readForkMaxParallel(bad)).toBe("");
      expect(readAgentField(bad, "provider")).toBe("");
    }
  });

  it("preserves keys owned by other accessors", () => {
    let config = writeGuidance(null, "check the diff");
    config = writeJoinStrategy(config, "merge");
    config = writeForkMode(config, "shared");
    config = writeForkMaxParallel(config, "3");
    config = writeAgentField(config, "provider", "codex");
    config = writeAgentField(config, "model", "gpt-5");

    expect(readGuidance(config)).toBe("check the diff");
    expect(readJoinStrategy(config)).toBe("merge");
    expect(readForkMode(config)).toBe("shared");
    expect(readForkMaxParallel(config)).toBe("3");
    expect(readAgentField(config, "provider")).toBe("codex");
    expect(readAgentField(config, "model")).toBe("gpt-5");
    expect(readAgentField(config, "profile")).toBe("");
  });

  it("collapses to null once the last key is cleared", () => {
    const withGuidance = writeGuidance(null, "x");
    expect(withGuidance).not.toBeNull();
    expect(writeGuidance(withGuidance, "")).toBeNull();

    const withAgent = writeAgentField(null, "provider", "claude");
    expect(writeAgentField(withAgent, "provider", "")).toBeNull();
  });

  it("stores only the non-default variant of each enum-ish field", () => {
    expect(writeJoinStrategy(null, "artifacts")).toBeNull();
    expect(writeForkMode(null, "worktree")).toBeNull();
    expect(writeJoinStrategy(null, "merge")).toBe('{"joinStrategy":"merge"}');
    expect(writeForkMode(null, "shared")).toBe('{"forkMode":"shared"}');
  });

  it("rejects a maxParallel below 1 or non-numeric", () => {
    for (const raw of ["0", "-2", "abc", ""]) {
      expect(writeForkMaxParallel(null, raw)).toBeNull();
    }
    expect(writeForkMaxParallel(null, "2.9")).toBe('{"maxParallel":2}');
    expect(readForkMaxParallel('{"maxParallel":"4"}')).toBe("");
  });
});
