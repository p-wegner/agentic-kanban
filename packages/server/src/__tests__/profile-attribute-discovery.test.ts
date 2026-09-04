// #1024 — profile discovery OBSERVES the role a profile declares for itself and caches
// it on the profile record the way the ring already caches `loggedIn`. The board never
// writes these keys, so this test only ever puts them on disk itself.
//
// Determinism: `node:os`.homedir is mocked to a fixture home (a real temp dir), so the
// ring's real readdir/existsSync discovery walks the fixture instead of the developer's
// actual `~`. The mocked homedir is never called at import time — only inside the ring
// functions the tests call — so the temp dir can be created after the imports.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fixture.home };
});

import { listClaudeSubscriptions } from "../services/claude-subscription-ring.js";
import { listCodexLicenses } from "../services/codex-license-ring.js";

const NOW = "2026-09-04T10:00:00.000Z";

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

beforeAll(() => {
  // `tmpdir` here is the mocked module's re-export of the real one (only homedir is faked).
  fixture.home = mkdtempSync(join(tmpdir(), "ak-profile-discovery-"));

  // A forbidden OAuth subscription: `~/.claude-training/` with a settings.json env block.
  write(
    join(fixture.home, ".claude-training", "settings.json"),
    JSON.stringify({ env: { KANBAN_PROFILE_ROLE: "forbidden", KANBAN_PROFILE_DEDICATED: "training" } }),
  );
  // A plain subscription that declares nothing -> pool.
  write(join(fixture.home, ".claude-anth", "settings.json"), JSON.stringify({ env: {} }));
  // A reserve subscription.
  write(
    join(fixture.home, ".claude-privat", "settings.json"),
    JSON.stringify({ env: { KANBAN_PROFILE_ROLE: "reserve" } }),
  );
  // An api-key profile living as a settings file in the shared `~/.claude`.
  write(
    join(fixture.home, ".claude", "settings_shared-key.json"),
    JSON.stringify({ env: { KANBAN_PROFILE_ROLE: "forbidden" } }),
  );
  // Codex: a forbidden license via the `[kanban]` table, and one declaring nothing.
  write(join(fixture.home, ".codex-kunde", "config.toml"), '[kanban]\nrole = "forbidden"\n');
  write(join(fixture.home, ".codex-kunde", "auth.json"), "{}");
  write(join(fixture.home, ".codex-plain", "config.toml"), 'model = "gpt-5"\n');
  write(join(fixture.home, ".codex-plain", "auth.json"), "{}");
});

afterAll(() => {
  if (fixture.home) rmSync(fixture.home, { recursive: true, force: true });
});

describe("claude profile discovery caches the observed role", () => {
  it("shows a KANBAN_PROFILE_ROLE=forbidden profile as forbidden, with its dedication and stamp", () => {
    const byProfile = new Map(listClaudeSubscriptions([], NOW).map((s) => [s.profile, s]));
    const training = byProfile.get("training");
    expect(training?.role).toBe("forbidden");
    expect(training?.dedicatedProject).toBe("training");
    expect(training?.roleObservedAt).toBe(NOW);
    expect(training?.roleConflict).toBe(false);
  });

  it("shows a profile without the key as pool, with no observation stamp", () => {
    const anth = listClaudeSubscriptions([], NOW).find((s) => s.profile === "anth");
    expect(anth?.role).toBe("pool");
    expect(anth?.roleObservedAt).toBeNull();
    expect(anth?.roleWarnings).toEqual([]);
  });

  it("reads reserve too, and leaves loggedIn/inRing untouched", () => {
    const privat = listClaudeSubscriptions([{ profile: "privat" }], NOW).find((s) => s.profile === "privat");
    expect(privat?.role).toBe("reserve");
    expect(privat?.loggedIn).toBe(true);
    expect(privat?.inRing).toBe(true);
  });

  it("an api-key ring entry pointing at another settings profile observes that file too", () => {
    const info = listClaudeSubscriptions([{ profile: "apikey", settingsProfile: "shared-key" }], NOW)
      .find((s) => s.profile === "apikey");
    expect(info?.mode).toBe("apikey");
    expect(info?.role).toBe("forbidden");
  });
});

describe("codex profile discovery caches the observed role", () => {
  it("reads the [kanban] table of a discovered license", () => {
    const kunde = listCodexLicenses([], NOW).find((l) => l.profile === "kunde");
    expect(kunde?.role).toBe("forbidden");
    expect(kunde?.roleObservedAt).toBe(NOW);
  });

  it("a license declaring nothing is pool", () => {
    const plain = listCodexLicenses([], NOW).find((l) => l.profile === "plain");
    expect(plain?.role).toBe("pool");
    expect(plain?.roleObservedAt).toBeNull();
  });
});

describe("the board never writes the attribute keys", () => {
  it("leaves the carrier file byte-identical after a full discovery pass", () => {
    const path = join(fixture.home, ".claude-training", "settings.json");
    const before = readFileSync(path, "utf8");
    listClaudeSubscriptions([], NOW);
    listCodexLicenses([], NOW);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
