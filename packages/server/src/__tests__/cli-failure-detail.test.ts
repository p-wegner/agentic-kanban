import { describe, expect, it } from "vitest";
import { __describeCliFailureForTests as describeCliFailure } from "../services/claude-cli.service.js";

/**
 * A failed AI operation must say WHAT failed (#665).
 *
 * `invokeClaudePrompt` used to reject with `err.message` alone, which for a spawned CLI is
 * always the same sentence — `Command failed: claude.exe --output-format text -p`. A
 * timeout, a missing login, an exhausted quota and a bad flag were indistinguishable, so
 * `group-scan` breaking on this board took a source read to diagnose. `execFile` carries
 * the distinguishing facts all along; this only stops discarding them.
 */
describe("describeCliFailure (#665)", () => {
  it("names a TIMEOUT, with the budget that was exceeded", () => {
    // The one failure whose fix is a config change rather than an auth problem, so it is
    // the one worth naming explicitly.
    const err = Object.assign(new Error("Command failed: claude.exe -p"), {
      killed: true, signal: "SIGTERM" as const, code: undefined,
    });
    const out = describeCliFailure(err, "", 60_000).message;
    expect(out).toContain("timed out after 60000ms");
    expect(out).toContain("SIGTERM");
  });

  it("reports a non-zero exit code when the process was not killed", () => {
    const err = Object.assign(new Error("Command failed: claude.exe -p"), { code: 1 });
    expect(describeCliFailure(err, "", 60_000).message).toContain("exited 1");
  });

  it("carries the tail of the child's stderr", () => {
    const err = Object.assign(new Error("Command failed: claude.exe -p"), { code: 1 });
    const out = describeCliFailure(err, "Invalid API key\nplease run /login\n", 60_000).message;
    expect(out).toContain("Invalid API key");
    expect(out).toContain("please run /login");
  });

  it("caps stderr at the last few lines so one error cannot flood a response body", () => {
    const err = Object.assign(new Error("boom"), { code: 1 });
    const noisy = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const out = describeCliFailure(err, noisy, 1000).message;
    expect(out).toContain("line 39");
    expect(out).not.toContain("line 0\n");
    expect(out.split("\n").length).toBeLessThan(10);
  });

  it("still returns the original message when there is nothing to add", () => {
    // No code, no signal, no stderr — the message must not gain a dangling separator.
    const err = new Error("Command failed: claude.exe -p");
    expect(describeCliFailure(err, undefined, 1000).message).toBe("Command failed: claude.exe -p");
  });
});
