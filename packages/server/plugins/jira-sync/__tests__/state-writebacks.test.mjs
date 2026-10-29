import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWritebacks, writebacksPath, writeJsonFile } from "../tools/lib/state.mjs";

test("readWritebacks: defaults to an empty map when no writebacks file exists yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "ak-jira-sync-writebacks-"));
  try {
    assert.deepEqual(readWritebacks(dir), { keys: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readWritebacks: round-trips a written key map", () => {
  const dir = mkdtempSync(join(tmpdir(), "ak-jira-sync-writebacks-"));
  try {
    writeJsonFile(writebacksPath(dir), { keys: { "board-issue-1": "ENG-42" } });
    assert.deepEqual(readWritebacks(dir), { keys: { "board-issue-1": "ENG-42" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { boardSnapshotPath, checkStateFiles, readBoardSnapshot, StateFileError } from "../tools/lib/state.mjs";

test("writeJsonFile: atomic, leaves no .tmp behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "ak-jira-sync-atomic-"));
  try {
    writeJsonFile(writebacksPath(dir), { keys: { a: "ENG-1" } });
    assert.equal(existsSync(`${writebacksPath(dir)}.tmp`), false);
    assert.deepEqual(JSON.parse(readFileSync(writebacksPath(dir), "utf8")), { keys: { a: "ENG-1" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a truncated board-snapshot.json is a loud failure, not a null fallback (push refuses)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ak-jira-sync-corrupt-"));
  try {
    writeFileSync(boardSnapshotPath(dir), '{"issues": {"a"');
    assert.throws(() => readBoardSnapshot(dir), StateFileError);
    assert.deepEqual(checkStateFiles(dir), { ok: false, step: "state", reason: "board-snapshot.json is not valid JSON" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a truncated writebacks.json is a loud failure, not an empty map (pull refuses)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ak-jira-sync-corrupt-"));
  try {
    writeFileSync(writebacksPath(dir), '{"keys": {"x"');
    assert.throws(() => readWritebacks(dir), StateFileError);
    assert.deepEqual(checkStateFiles(dir), { ok: false, step: "state", reason: "writebacks.json is not valid JSON" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkStateFiles: null when files are absent or valid", () => {
  const dir = mkdtempSync(join(tmpdir(), "ak-jira-sync-ok-"));
  try {
    assert.equal(checkStateFiles(dir), null);
    writeJsonFile(writebacksPath(dir), { keys: {} });
    assert.equal(checkStateFiles(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
