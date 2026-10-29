import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyState } from "../tools/lib/state.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ak-jira-sync-statedir-"));
  const legacy = join(root, "repo", ".jira-sync");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "pull-state.json"), '{"keys":{"A-1":{}}}');
  return { root, legacy };
}

test("migrateLegacyState: moves repo-local state into the per-project dir once", () => {
  const { root, legacy } = setup();
  try {
    const a = join(root, "data", "proj-a");
    const b = join(root, "data", "proj-b");
    assert.equal(migrateLegacyState(a, legacy), "migrated");
    assert.equal(readFileSync(join(a, "pull-state.json"), "utf8"), '{"keys":{"A-1":{}}}');
    assert.equal(existsSync(legacy), false);
    // two projects on one repo path: the second never inherits the first one's baseline
    assert.equal(migrateLegacyState(b, legacy), "none");
    assert.equal(existsSync(join(b, "pull-state.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateLegacyState: leaves an already-populated state dir alone", () => {
  const { root, legacy } = setup();
  try {
    const dir = join(root, "data", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pull-state.json"), "{}");
    assert.equal(migrateLegacyState(dir, legacy), "none");
    assert.equal(readFileSync(join(dir, "pull-state.json"), "utf8"), "{}");
    assert.equal(existsSync(legacy), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
