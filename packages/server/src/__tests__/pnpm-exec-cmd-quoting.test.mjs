// Imports scripts/pnpm-exec.mjs directly, so `vitest related`/the impact selector already
// reaches this suite from a change to that script — no `@gate:always-run` marker needed (#1109).
import { describe, expect, it } from "vitest";
import { resolvePnpmInvocation } from "../../../../scripts/pnpm-exec.mjs";

describe("resolvePnpmInvocation win32 shell quoting (#1109)", () => {
  const win32NoExecpath = (extra = {}) => resolvePnpmInvocation(["--filter", "agentic-kanban", "exec", "node", "src/cli/index.ts", ...(extra.args ?? [])], {}, "win32");

  it("leaves a plain argument unquoted", () => {
    const inv = win32NoExecpath({ args: ["issue", "get", "1", "--json"] });
    expect(inv.cmd).toContain(" issue get 1 --json");
  });

  it("quotes an argument containing a space", () => {
    const inv = win32NoExecpath({ args: ["issue", "update", "1", "--title", "Fix the bug"] });
    expect(inv.cmd).toContain('"Fix the bug"');
  });

  it("quotes an argument containing a comma so pnpm.cmd's batch parser doesn't split it into two params", () => {
    const inv = win32NoExecpath({ args: ["issue", "update", "1", "--title", "Fix bug, retry"] });
    expect(inv.cmd).toContain('"Fix bug, retry"');
  });

  it("quotes an argument containing a semicolon or an equals sign for the same reason", () => {
    const semi = win32NoExecpath({ args: ["issue", "update", "1", "--title", "a;b"] });
    expect(semi.cmd).toContain('"a;b"');
    const eq = win32NoExecpath({ args: ["issue", "update", "1", "--title", "a=b"] });
    expect(eq.cmd).toContain('"a=b"');
  });

  it("doubles an embedded double quote inside a quoted argument", () => {
    const inv = win32NoExecpath({ args: ["issue", "update", "1", "--title", 'He said "hi"'] });
    expect(inv.cmd).toContain('"He said ""hi"""');
  });

  // #1116: quoting alone does not suppress cmd.exe's %VAR% expansion - a title containing
  // %WINDIR%/%APPDATA%/%PATH% was silently replaced with the real environment value.
  it("neutralizes a %VAR% pattern so cmd.exe cannot expand it", () => {
    const inv = win32NoExecpath({ args: ["issue", "update", "1", "--title", "issue title %WINDIR% end"] });
    expect(inv.cmd).not.toMatch(/(?<!\^)%WINDIR%/);
    expect(inv.cmd).toContain('"^%"');
  });

  it("neutralizes a leading and trailing %", () => {
    const inv = win32NoExecpath({ args: ["issue", "update", "1", "--title", "%PATH% then %APPDATA%"] });
    expect(inv.cmd).not.toMatch(/(?<!\^)%PATH%/);
    expect(inv.cmd).not.toMatch(/(?<!\^)%APPDATA%/);
  });

  it("passes a lone % that matches no env var through unharmed once reconstructed", () => {
    const inv = win32NoExecpath({ args: ["issue", "update", "1", "--title", "50% to 80%"] });
    // The escaped form round-trips to the original text once cmd.exe re-joins the
    // caret-escaped `%` with its surrounding quoted segments.
    expect(inv.cmd).toContain('50');
    expect(inv.cmd).toContain('80');
  });
});
