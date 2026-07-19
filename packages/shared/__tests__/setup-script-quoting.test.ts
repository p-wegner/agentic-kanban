import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSetupScript } from "../src/lib/setup-script.js";

/**
 * Regression for #111: a setupScript containing nested double-quotes must reach
 * the shell VERBATIM. Before the fix, Node's default windowsVerbatimArguments
 * re-quoted the single `cmd.exe /c <script>` argument and corrupted embedded
 * quotes, so a `node -e "..."`-style script silently no-opped on Windows.
 *
 * The assertion is platform-agnostic: on Windows it exercises the cmd.exe verbatim
 * path, on POSIX the /bin/sh path. Either way a quoted command must run and produce
 * its side effect.
 */
describe("runSetupScript quoting (#111)", () => {
  it("runs a script with nested double-quotes without mangling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-setup-quote-"));
    try {
      const sentinel = join(dir, "sentinel.txt").replace(/\\/g, "/");
      // A command that only works if the embedded double-quotes survive intact:
      // node evaluates a quoted program that writes a file with a quoted string.
      const script = `node -e "require('fs').writeFileSync('${sentinel}', 'quoted-ok')"`;
      const result = await runSetupScript(dir, script);
      expect(result.exitCode).toBe(0);
      expect(existsSync(sentinel)).toBe(true);
      expect(readFileSync(sentinel, "utf8")).toBe("quoted-ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
