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
import { afterEach, describe, expect, it, vi } from "vitest";
/**
 * The repair step is the one place this sweep swallows an exception, so it is the only way to
 * produce the `scanned - acted - skipped` remainder that #723 is about. Mocked per-test via the
 * flag rather than globally: every other case here must exercise the real scaffold.
 */
let scaffoldThrows = false;
vi.mock("../services/project-scaffold.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/project-scaffold.js")>();
  return {
    ...actual,
    ensureHookScaffold: (repoPath: string, options?: Parameters<typeof actual.ensureHookScaffold>[1]) => {
      if (scaffoldThrows) throw new Error("settings.json is unwritable");
      return actual.ensureHookScaffold(repoPath, options);
    },
  };
});

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
    ], { log: () => {} });
    expect(result.scanned).toBe(3);
    expect(result.broken.map((b) => b.projectName)).toEqual(["broken"]);
    expect(result.unguarded).toEqual(["none"]);
  });

  it("skips a project whose repo path is gone instead of reporting it", () => {
    // A moved/unmounted project is a different problem; reporting it here would bury the finding.
    const result = sweepHookWiring([{ id: "1", name: "gone", repoPath: join(tmpdir(), "ak-does-not-exist-xyz") }], { log: () => {} });
    expect(result.scanned).toBe(0);
    expect(result.broken).toEqual([]);
  });

  it("names the missing matcher in the report, not just the count", () => {
    const broken = makeRepo({ matchers: ["Write|Edit|MultiEdit|NotebookEdit"] });
    const lines = formatHookWiringReport(sweepHookWiring([{ id: "1", name: "broken", repoPath: broken }], { log: () => {} }));
    expect(lines.join("\n")).toContain("Bash|PowerShell");
    expect(lines.join("\n")).toContain("looks installed and does not run");
  });

  it("is silent when every project is wired", () => {
    const fine = makeRepo({ matchers: ["Write|Edit|MultiEdit|NotebookEdit", "Bash|PowerShell"] });
    expect(
      formatHookWiringReport(sweepHookWiring([{ id: "1", name: "fine", repoPath: fine }], { log: () => {} })),
    ).toEqual([]);
  });
});

// #723: this sweep was the fifth `PassReport` adopter, and the one #689 missed — it built the
// report and returned it, while `formatHookWiringReport` returned `[]` for a clean run. The
// remainder the shape exists to expose therefore reached no log at all, so a run where every
// candidate threw read exactly like a run where every project was wired.
//
// These assertions are deliberately about what was LOGGED, not about the returned object: an
// assertion on the result would have passed before the fix too, which is precisely how the
// defect survived four other adopters being fixed.
describe("sweepHookWiring EMITS its pass summary (#723)", () => {
  it("logs the summary on a completely clean run, when the findings report is empty", () => {
    const fine = makeRepo({ matchers: ["Write|Edit|MultiEdit|NotebookEdit", "Bash|PowerShell"] });
    const alsoFine = makeRepo({ matchers: ["Write|Edit|MultiEdit|NotebookEdit", "Bash|PowerShell"] });
    const lines: string[] = [];

    const result = sweepHookWiring(
      [
        { id: "1", name: "fine", repoPath: fine },
        { id: "2", name: "also-fine", repoPath: alsoFine },
      ],
      { log: (message) => lines.push(message) },
    );

    // Nothing to act on — and that is exactly the case the old guard suppressed.
    expect(formatHookWiringReport(result)).toEqual([]);
    expect(
      lines,
      "the hook-wiring sweep returned a PassReport but logged no summary — the #689/#723 defect",
    ).toContain("scanned 2, acted 0, skipped 2");
  });

  it("logs the summary when it scanned nothing at all", () => {
    const lines: string[] = [];

    sweepHookWiring([{ id: "1", name: "gone", repoPath: join(tmpdir(), "ak-no-such-repo-723") }], {
      log: (message) => lines.push(message),
    });

    // A `scanned 0` line IS the report (#718): a pass that found nothing must not be
    // indistinguishable from a pass that never ran.
    expect(lines).toContain("scanned 0, acted 0, skipped 0");
  });

  it("names the unaccounted remainder, so a swallowed failure cannot read as a clean run", () => {
    // One project whose audit succeeds and whose repair path throws: neither acted nor skipped,
    // which is the whole reason `PassReport` distinguishes the two from `scanned`.
    const broken = makeRepo({ matchers: ["Write|Edit|MultiEdit|NotebookEdit"] });
    const lines: string[] = [];
    scaffoldThrows = true;
    try {
      sweepHookWiring([{ id: "1", name: "broken", repoPath: broken }], {
        repair: true,
        log: (message) => lines.push(message),
      });
    } finally {
      scaffoldThrows = false;
    }

    expect(lines).toContain("scanned 1, acted 0, skipped 0, 1 unaccounted");
  });

  it("applies its [hook-audit] tag once, in the default logger (#616)", () => {
    const fine = makeRepo({ matchers: ["Write|Edit|MultiEdit|NotebookEdit", "Bash|PowerShell"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let logged: unknown[][];

    try {
      sweepHookWiring([{ id: "1", name: "fine", repoPath: fine }]);
      // Read the calls BEFORE restoring: `mockRestore` also RESETS the spy, so a snapshot taken
      // afterwards is always empty (and the assertion always vacuously... fails, in this case).
      logged = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
    }

    // The tag is a literal first argument (what `console-tag-ratchet.test.ts` requires), and an
    // injected `log` must therefore not add one — `[hook-audit] [hook-audit]` is the regression.
    expect(logged).toContainEqual(["[hook-audit] scanned 1, acted 0, skipped 1"]);
  });
});
