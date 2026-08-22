// #708 — the board kills agents by PID, so Claude never removes its own
// `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`, and the orphans then name PIDs the OS recycles.
//
// This sweep DELETES files in the user's home directory, which makes the negative cases the
// load-bearing ones: a live PID, a too-young file, and anything whose name is not exactly
// `<digits>.json` must survive. Those are asserted here against an in-memory filesystem, so
// the suite can be exhaustive without a real `~/.claude` anywhere near it.

import { describe, expect, it, vi } from "vitest";
import { passReasonCounts } from "../lib/pass-report.js";
import { join } from "node:path";
import {
  decideRegistryFile,
  discoverClaudeConfigDirs,
  reapAgentSessionRegistry,
  type RegistryFs,
} from "../startup/agent-session-registry-reaper.js";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

/** In-memory `RegistryFs`. `files` maps an absolute path to its mtime in epoch ms. */
function fakeFs(opts: { dirs?: Record<string, string[]>; files?: Record<string, number> }) {
  const dirs = opts.dirs ?? {};
  const files = new Map(Object.entries(opts.files ?? {}));
  const removed: string[] = [];
  const fs: RegistryFs = {
    exists: (p) => p in dirs || [...files.keys()].some((f) => f.startsWith(p)),
    listDirs: (p) => dirs[p] ?? [],
    listFiles: (p) =>
      [...files.keys()]
        .filter((f) => f.slice(0, f.length - basename(f).length - 1) === p)
        .map((f) => basename(f)),
    mtimeMs: (p) => {
      const t = files.get(p);
      if (t === undefined) throw new Error(`ENOENT: ${p}`);
      return t;
    },
    remove: (p) => {
      if (!files.delete(p)) throw new Error(`ENOENT: ${p}`);
      removed.push(p);
    },
  };
  return { fs, removed, files };
}

const basename = (p: string) => p.split(/[\\/]/).pop()!;

const CONFIG_DIR = join("C:", "home", ".claude");
const SESSIONS = join(CONFIG_DIR, "sessions");
const file = (name: string) => join(SESSIONS, name);

describe("decideRegistryFile (#708)", () => {
  it("removes a registry file whose PID is dead and which is old enough to judge", () => {
    expect(decideRegistryFile({ fileName: "4242.json", pidAlive: false, ageMs: HOUR })).toEqual({
      action: "remove",
      reason: "dead-pid",
    });
  });

  it("keeps a file whose PID is still alive — including a stale one whose PID was recycled", () => {
    // The recycled-PID case is the very defect this ticket describes, and it is STILL a
    // keep: deleting a file that might describe a live session is the worse error, and the
    // file goes on the next pass after that process exits.
    expect(decideRegistryFile({ fileName: "4242.json", pidAlive: true, ageMs: 30 * HOUR })).toEqual({
      action: "keep",
      reason: "pid-alive",
    });
  });

  it("keeps a freshly written file, so a just-spawned session is never reaped from under itself", () => {
    expect(decideRegistryFile({ fileName: "4242.json", pidAlive: false, ageMs: 5_000 })).toEqual({
      action: "keep",
      reason: "too-recent",
    });
  });

  it.each([
    "settings.json",
    ".credentials.json",
    "4242.json.bak",
    "4242.txt",
    "42-42.json",
    "index.json",
  ])("never touches %s — the filename shape is a hard gate, not a filter", (fileName) => {
    expect(decideRegistryFile({ fileName, pidAlive: false, ageMs: 30 * HOUR })).toEqual({
      action: "keep",
      reason: "not-a-registry-file",
    });
  });
});

describe("reapAgentSessionRegistry (#708)", () => {
  it("removes only the dead-PID registry files and reports the rest as skipped with reasons", async () => {
    const { fs, removed } = fakeFs({
      files: {
        [file("100.json")]: NOW - HOUR, // dead → goes
        [file("200.json")]: NOW - HOUR, // alive → stays
        [file("300.json")]: NOW - 1_000, // dead but too young → stays
        [file("settings.json")]: NOW - HOUR, // not a registry file → stays
      },
    });

    const result = await reapAgentSessionRegistry({
      configDirs: [CONFIG_DIR],
      fs,
      nowMs: NOW,
      pidAlive: (pid) => pid === 200,
      log: () => {},
    });

    expect(removed).toEqual([file("100.json")]);
    expect(result.removed).toEqual([file("100.json")]);
    expect(result.scanned).toBe(4);
    expect(result.acted).toBe(1);
    expect(result.skipped).toBe(3);
    expect(passReasonCounts(result)).toEqual({
      "dead-pid": 1,
      "pid-alive": 1,
      "too-recent": 1,
      "not-a-registry-file": 1,
    });
  });

  it("never probes a PID it did not parse — a non-registry name must not invent one", async () => {
    const { fs } = fakeFs({ files: { [file("settings.json")]: NOW - HOUR } });
    const pidAlive = vi.fn(() => false);

    await reapAgentSessionRegistry({ configDirs: [CONFIG_DIR], fs, nowMs: NOW, pidAlive, log: () => {} });

    expect(pidAlive).not.toHaveBeenCalled();
  });

  it("counts a failed unlink as neither acted nor skipped, so the pass does not read clean", async () => {
    // The #592 contract: `acted + skipped < scanned` is how a swallowed failure stays visible.
    const { fs } = fakeFs({ files: { [file("100.json")]: NOW - HOUR } });
    const lines: string[] = [];
    const result = await reapAgentSessionRegistry({
      configDirs: [CONFIG_DIR],
      fs: { ...fs, remove: () => { throw new Error("EPERM: file is locked"); } },
      nowMs: NOW,
      pidAlive: () => false,
      log: (m) => lines.push(m),
    });

    expect(result.scanned).toBe(1);
    expect(result.acted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.removed).toEqual([]);
    expect(lines.join("\n")).toContain("EPERM");
    expect(lines.join("\n")).toContain("1 unaccounted");
  });

  it("skips a config dir with no sessions/ directory rather than failing the whole pass", async () => {
    const { fs } = fakeFs({ files: { [file("100.json")]: NOW - HOUR } });
    const result = await reapAgentSessionRegistry({
      configDirs: [join("C:", "home", ".claude-gone"), CONFIG_DIR],
      fs,
      nowMs: NOW,
      pidAlive: () => false,
      log: () => {},
    });

    expect(result.dirsScanned).toEqual([SESSIONS]);
    expect(result.removed).toEqual([file("100.json")]);
  });

  it("emits a summary whenever it looked at anything — a silent pass is indistinguishable from none", async () => {
    const { fs } = fakeFs({ files: { [file("200.json")]: NOW - HOUR } });
    const lines: string[] = [];
    await reapAgentSessionRegistry({
      configDirs: [CONFIG_DIR],
      fs,
      nowMs: NOW,
      pidAlive: () => true,
      log: (m) => lines.push(m),
    });

    expect(lines).toContain("scanned 1, acted 0, skipped 1");
  });
});

describe("discoverClaudeConfigDirs (#708)", () => {
  it("finds ~/.claude and every ~/.claude-<profile> sibling, and nothing else in home", () => {
    const { fs } = fakeFs({
      dirs: {
        [join("C:", "home")]: [".claude", ".claude-team_5x_3", ".claude-work", ".codex", "projects", "claude"],
      },
    });

    // #725: this asserts an EXACT set, and `discoverClaudeConfigDirs` also appends
    // `$CLAUDE_CONFIG_DIR` — which is set for every agent session launched with a non-default
    // profile (here `~/.claude-andrena_team_5x_2`). The fake `fs` and `home` cannot isolate an
    // env read, so the real dir leaked in as a fourth entry and this test failed for anyone
    // whose environment sets it, while passing in CI and on a default profile. Stub it empty:
    // the sibling test below owns the "explicit dir is included" case, so clearing it here is
    // narrowing this test to its actual subject (home-directory discovery), not hiding anything.
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    try {
      expect(discoverClaudeConfigDirs(fs, join("C:", "home")).sort()).toEqual(
        [
          join("C:", "home", ".claude"),
          join("C:", "home", ".claude-team_5x_3"),
          join("C:", "home", ".claude-work"),
        ].sort(),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("includes an explicit CLAUDE_CONFIG_DIR pointing outside home", () => {
    const { fs } = fakeFs({ dirs: { [join("C:", "home")]: [".claude"] } });
    const elsewhere = join("D:", "profiles", "claude-alt");
    vi.stubEnv("CLAUDE_CONFIG_DIR", elsewhere);
    try {
      expect(discoverClaudeConfigDirs(fs, join("C:", "home"))).toContain(elsewhere);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns an empty list rather than throwing when home cannot be read", () => {
    const fs: RegistryFs = {
      exists: () => false,
      listDirs: () => { throw new Error("EPERM"); },
      listFiles: () => [],
      mtimeMs: () => 0,
      remove: () => {},
    };
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    try {
      expect(discoverClaudeConfigDirs(fs, join("C:", "home"))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
