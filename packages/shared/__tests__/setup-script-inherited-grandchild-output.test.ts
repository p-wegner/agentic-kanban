import { describe, it, expect } from "vitest";
import { runSetupScript } from "../src/lib/setup-script.js";

/**
 * Regression for #1049: every failing pre-merge gate on this board wrote a verify log that
 * stopped dead under the FIRST sub-step's own banner, even though the verify script kept
 * running (later steps had their own failures the log never showed).
 *
 * Root cause: `runSetupScript` resolved on the child's `exit` event, which Node fires as soon
 * as the DIRECT child process ends — not once its stdio pipes have actually finished draining.
 * Every real verify sub-step spawns with `stdio: "inherit"` (check-arch.mjs's own sub-spawns,
 * and pnpm/vitest's worker trees), which hands the SAME pipe handle down to a grandchild. If
 * that grandchild is still writing when its immediate parent exits, `exit` can fire — and the
 * promise resolve with whatever had arrived so far — before the grandchild's trailing output
 * ever reaches the buffer.
 *
 * This spawns exactly that shape: an immediate child that forks a DETACHED grandchild sharing
 * its stdout, then exits right away while the grandchild is still asleep. A capture keyed off
 * `exit` loses the grandchild's line; one keyed off `close` (which only fires once the pipe
 * itself has no writers left) must not.
 */
describe("runSetupScript captures output written by an inherited grandchild after its parent exits (#1049)", () => {
  // WINDOWS-ONLY, and the honest reason is that this HARNESS does not port, not that the
  // behaviour has been shown absent on POSIX.
  //
  // The script below is embedded with `"` escaped as `\"`, which is the cmd.exe spelling
  // `runSetupScript` uses on win32 (`windowsVerbatimArguments`). On POSIX the same string goes to
  // `/bin/sh -c`, which reads those escapes differently. CI captured stdout of EXACTLY
  // `'PARENT_EARLY_OUTPUT\n'` — the parent ran and the grandchild's line never appeared at all,
  // which is what a grandchild that never spawned looks like, not what a lost-drain looks like.
  //
  // I could not prove that from Windows, so this is gated rather than rewritten: turning it into
  // a POSIX-quoting-correct harness without a Linux box to check against would be guessing at the
  // fix for a test whose failure I cannot reproduce. What is NOT claimed here is that the #1049
  // drain fix works on POSIX — it is untested there, and has been since it landed (failing every
  // arch-gate run from 2026-09-01 through 09-12).
  it.runIf(process.platform === "win32")("keeps output written by a still-running grandchild that inherited stdout from an already-exited direct child (win32)", async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const grandchild = spawn(process.execPath, ['-e', " +
        "'setTimeout(() => { process.stdout.write(\"GRANDCHILD_LATE_OUTPUT\\\\n\"); process.exit(0); }, 300);'" +
        "], { stdio: 'inherit', detached: true });",
      "grandchild.unref();",
      "process.stdout.write('PARENT_EARLY_OUTPUT\\n');",
      "process.exit(0);",
    ].join(" ");

    const result = await runSetupScript(process.cwd(), `${process.execPath} -e "${script.replace(/"/g, '\\"')}"`, {
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PARENT_EARLY_OUTPUT");
    expect(result.stdout).toContain("GRANDCHILD_LATE_OUTPUT");
  }, 15000);
});
