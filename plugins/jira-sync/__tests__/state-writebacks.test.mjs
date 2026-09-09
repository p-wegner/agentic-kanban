import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWritebacks, writebacksPath, writeJsonFile } from "../tools/lib/state.mjs";

test("readWritebacks: defaults to an empty map when no writebacks file exists yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "jira-sync-writebacks-"));
  try {
    assert.deepEqual(readWritebacks(dir), { keys: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readWritebacks: round-trips a written key map", () => {
  const dir = mkdtempSync(join(tmpdir(), "jira-sync-writebacks-"));
  try {
    writeJsonFile(writebacksPath(dir), { keys: { "board-issue-1": "ENG-42" } });
    assert.deepEqual(readWritebacks(dir), { keys: { "board-issue-1": "ENG-42" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
