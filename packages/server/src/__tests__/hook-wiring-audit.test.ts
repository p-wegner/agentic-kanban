// @covers hooks.wiringAudit.crossWorktree [security, boundary]
//
// #391/#396: the #369 incident was NOT a missing guard — it was a guard that LOOKED installed.
// `eventhub-backend` shipped `prevent-cross-worktree-writes.js` on disk but never registered it
// as a hook, so 17 writes into another worktree succeeded with the guard sitting right there. A
// later audit found 9 of 20 registered projects in some version of that state, most missing the
// SHELL matcher specifically — the exact vector the incident used (`cd <checkout> && git commit`).
//
// The state worth failing loudly about is therefore "script present, hook entry absent": it is
// indistinguishable from protected at a glance, and silent by construction.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditHookWiring, sweepHookWiring, formatHookWiringReport } from "../services/hook-wiring-audit.service.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GUARD_CMD = "node $CLAUDE_PROJECT_DIR/.claude/hooks/prevent-cross-worktree-writes.js";

function makeRepo(opts: { script?: boolean; matchers?: string[] }): string {
  const root = mkdtempSync(join(tmpdir(), "ak-hook-audit-"));
  created.push(root);
  mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
  if (opts.script !== false) {
    writeFileSync(join(root, ".claude", "hooks", "prevent-cross-worktree-writes.js"), "// guard\n");
  }
  if (opts.matchers) {
    const settings = {
      hooks: {
        PreToolUse: opts.matchers.map((matcher) => ({ matcher, hooks: [{ type: "command", command: GUARD_CMD }] })),
      },
    };
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  }
  return root;
}

function audit(root: string) {
  return auditHookWiring({ id: "p1", name: "proj", repoPath: root });
}

describe("auditHookWiring (#391/#396)", () => {
  it("flags the deceptive state: script on disk, NO hook entry at all", () => {
    const status = audit(makeRepo({}));
    expect(status.scriptPresent).toBe(true);
    expect(status.wiredForWrites).toBe(false);
    expect(status.wiredForShell).toBe(false);
    expect(status.looksInstalledButIsNot).toBe(true);
  });

  it("flags a guard wired ONLY for writes — the exact #369 hole", () => {
    // This is what eventhub-backend looked like: writes covered, shell open, and the incident
    // commit was `cd <main checkout> && git commit`, which the write matcher never sees.
    const status = audit(makeRepo({ matchers: ["Write|Edit|MultiEdit|NotebookEdit"] }));
    expect(status.wiredForWrites).toBe(true);
    expect(status.wiredForShell).toBe(false);
    expect(status.looksInstalledButIsNot).toBe(true);
  });

  it("flags a guard wired ONLY for shell", () => {
    const status = audit(makeRepo({ matchers: ["Bash|PowerShell"] }));
    expect(status.wiredForShell).toBe(true);
    expect(status.wiredForWrites).toBe(false);
    expect(status.looksInstalledButIsNot).toBe(true);
  });

  it("passes a fully wired project", () => {
    const status = audit(makeRepo({ matchers: ["Write|Edit|MultiEdit|NotebookEdit", "Bash|PowerShell"] }));
    expect(status.looksInstalledButIsNot).toBe(false);
  });

  it("does NOT call a project with no guard script 'deceptive' — it is unprotected, but honestly", () => {
    const status = audit(makeRepo({ script: false }));
    expect(status.scriptPresent).toBe(false);
    expect(status.looksInstalledButIsNot).toBe(false);
  });

  it("treats an unparseable settings.json as unwired rather than assuming it is fine", () => {
    const root = makeRepo({});
    writeFileSync(join(root, ".claude", "settings.json"), "{ not json");
    expect(audit(root).looksInstalledButIsNot).toBe(true);
  });
});

describe("sweepHookWiring", () => {
  it("separates the deceptive projects from the merely unguarded ones", () => {
    const broken = makeRepo({ matchers: ["Write|Edit|MultiEdit|NotebookEdit"] });
    const fine = makeRepo({ matchers: ["Write|Edit|MultiEdit|NotebookEdit", "Bash|PowerShell"] });
    const none = makeRepo({ script: false });
    const result = sweepHookWiring([
      { id: "1", name: "broken", repoPath: broken },
      { id: "2", name: "fine", repoPath: fine },
      { id: "3", name: "none", repoPath: none },
    ]);
    expect(result.scanned).toBe(3);
    expect(result.broken.map((b) => b.projectName)).toEqual(["broken"]);
    expect(result.unguarded).toEqual(["none"]);
  });

  it("skips a project whose repo path is gone instead of reporting it", () => {
    // A moved/unmounted project is a different problem; reporting it here would bury the finding.
    const result = sweepHookWiring([{ id: "1", name: "gone", repoPath: join(tmpdir(), "ak-does-not-exist-xyz") }]);
    expect(result.scanned).toBe(0);
    expect(result.broken).toEqual([]);
  });

  it("names the missing matcher in the report, not just the count", () => {
    const broken = makeRepo({ matchers: ["Write|Edit|MultiEdit|NotebookEdit"] });
    const lines = formatHookWiringReport(sweepHookWiring([{ id: "1", name: "broken", repoPath: broken }]));
    expect(lines.join("\n")).toContain("Bash|PowerShell");
    expect(lines.join("\n")).toContain("looks installed and does not run");
  });

  it("is silent when every project is wired", () => {
    const fine = makeRepo({ matchers: ["Write|Edit|MultiEdit|NotebookEdit", "Bash|PowerShell"] });
    expect(formatHookWiringReport(sweepHookWiring([{ id: "1", name: "fine", repoPath: fine }]))).toEqual([]);
  });
});
