import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findInvalidUtf8Rows,
  repairInvalidUtf8Rows,
  UTF8_REPAIR_TABLES,
} from "../db/utf8-repair.js";
import { sanitizeUtf8 } from "@agentic-kanban/shared/lib/sanitize-utf8";

/**
 * arch-review #960 — libsql PANICS the whole process (Utf8Error, value.rs:237)
 * reading a TEXT column with invalid UTF-8 bytes via a plain SELECT. These tests
 * pin: reproduction of the hazard (invalid bytes land in a TEXT column), the
 * tolerant BLOB-cast scan detecting it without triggering the native decode, and
 * in-place repair (UPDATE, never delete). TEMP databases only.
 */

/** Minimal schema mirroring session_messages/sessions' text columns. */
async function makeDb(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  await client.execute(
    "CREATE TABLE `session_messages` (`id` integer PRIMARY KEY AUTOINCREMENT, `session_id` text NOT NULL, `type` text NOT NULL, `data` text, `exit_code` text, `created_at` text NOT NULL)",
  );
  await client.execute(
    "CREATE TABLE `sessions` (`id` text PRIMARY KEY NOT NULL, `workspace_id` text NOT NULL, `stats` text)",
  );
  return client;
}

/**
 * Insert a TEXT value containing an invalid UTF-8 byte sequence — the same class
 * of corruption a raw agent-stdout chunk split mid-codepoint can produce.
 * `unhex()` + `CAST(... AS TEXT)` writes the exact raw bytes into the TEXT
 * column via pure SQL, bypassing any JS-side string/encoding validation on the
 * write path (mirroring how a bad byte sequence lands in a live TEXT column).
 */
async function insertInvalidUtf8Row(client: Client, sessionId: string, data: Uint8Array) {
  const hex = Buffer.from(data).toString("hex");
  await client.execute({
    sql: "INSERT INTO session_messages (session_id, type, data, created_at) VALUES (?, 'stdout', CAST(unhex(?) AS TEXT), datetime('now'))",
    args: [sessionId, hex],
  });
}

let quarantineDir: string;

beforeEach(() => {
  quarantineDir = mkdtempSync(join(tmpdir(), "utf8-quarantine-test-"));
});

afterEach(() => {
  rmSync(quarantineDir, { recursive: true, force: true });
});

/**
 * The dangerous SELECT, run OUT OF PROCESS.
 *
 * It cannot be run in-process: libsql does not throw a catchable JS error here, it
 * PANICS the Rust thread, which aborts the whole process. Asserting `.rejects` on it
 * in-process was unreachable code that killed the vitest worker instead — taking the
 * other nine tests in this file down with it (so the repair machinery this file exists
 * to pin was never actually verified) and erroring the whole server suite, which
 * withheld every merge on the board.
 *
 * Running it in a child keeps the proof — a plain SELECT must never hand back the
 * corrupt text — while letting the rest of this file run.
 */
const PLAIN_SELECT_PROBE = `
import { createClient } from "@libsql/client";
const client = createClient({ url: ":memory:" });
await client.execute("CREATE TABLE t (id integer primary key, data text)");
// 0xFF is never valid as a UTF-8 lead or continuation byte.
await client.execute({ sql: "INSERT INTO t (data) VALUES (CAST(unhex(?) AS TEXT))", args: ["68656c6c6fff776f726c64"] });
try {
  const rows = await client.execute("SELECT data FROM t");
  console.log("RETURNED:" + JSON.stringify(rows.rows[0].data));
} catch (err) {
  console.log("THREW:" + String(err && err.message));
  process.exit(3);
}
`;

describe("reproduction: invalid UTF-8 in a TEXT column", () => {
  it("a plain SELECT on the corrupt row never returns the data (it kills the process)", () => {
    // cwd is packages/server, so the child resolves @libsql/client the same way we do.
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", PLAIN_SELECT_PROBE], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
    });

    // The whole point: the corrupt text is never successfully handed back.
    expect(probe.stdout).not.toContain("RETURNED:");
    // Either outcome is acceptable — a thrown Utf8Error (exit 3) or the native panic
    // observed in production (abnormal exit). What is not acceptable is exit 0.
    expect(probe.status).not.toBe(0);
  });
});

describe("findInvalidUtf8Rows", () => {
  it("detects the corrupt row via the tolerant BLOB-cast reader without throwing", async () => {
    const client = await makeDb();
    const bad = new Uint8Array([0x68, 0x69, 0xff, 0x21]);
    await insertInvalidUtf8Row(client, "s1", bad);
    await client.execute("INSERT INTO session_messages (session_id, type, data, created_at) VALUES ('s2', 'stdout', 'perfectly valid text', datetime('now'))");

    const violations = await findInvalidUtf8Rows(client, [...UTF8_REPAIR_TABLES]);
    expect(violations).toHaveLength(1);
    expect(violations[0].table).toBe("session_messages");
    expect(violations[0].columns.data).toBeDefined();
    // Lenient decode replaces the bad byte with U+FFFD rather than losing the rest of the string.
    expect(violations[0].columns.data).toContain("hi");
    expect(violations[0].columns.data).toContain("�");
    expect(violations[0].columns.data).toContain("!");
  });

  it("reports no violations on a clean DB", async () => {
    const client = await makeDb();
    await client.execute("INSERT INTO session_messages (session_id, type, data, created_at) VALUES ('s1', 'stdout', 'clean', datetime('now'))");
    const violations = await findInvalidUtf8Rows(client, [...UTF8_REPAIR_TABLES]);
    expect(violations).toHaveLength(0);
  });
});

describe("repairInvalidUtf8Rows", () => {
  it("repairs the corrupt row in place (UPDATE, not delete) and writes a quarantine dump", async () => {
    const client = await makeDb();
    const bad = new Uint8Array([0x61, 0xff, 0x62]);
    await insertInvalidUtf8Row(client, "s1", bad);

    const result = await repairInvalidUtf8Rows(client, [...UTF8_REPAIR_TABLES], quarantineDir);
    expect(result.repairedRows).toBe(1);
    expect(result.quarantinePath).not.toBeNull();

    const dumped = JSON.parse(readFileSync(result.quarantinePath!, "utf8"));
    expect(dumped.violations).toHaveLength(1);

    // The row now round-trips through a normal SELECT without failure.
    const rows = await client.execute("SELECT data FROM session_messages WHERE session_id = 's1'");
    expect(rows.rows).toHaveLength(1);
    expect(String(rows.rows[0].data)).toContain("a");
    expect(String(rows.rows[0].data)).toContain("�");
    expect(String(rows.rows[0].data)).toContain("b");

    const files = readdirSync(quarantineDir);
    expect(files.some((f) => f.startsWith("kanban-utf8-repair-"))).toBe(true);

    // Re-scanning now reports clean.
    const rescan = await findInvalidUtf8Rows(client, [...UTF8_REPAIR_TABLES]);
    expect(rescan).toHaveLength(0);
  });

  it("is a no-op on a clean DB (no quarantine file, nothing changed)", async () => {
    const client = await makeDb();
    await client.execute("INSERT INTO session_messages (session_id, type, data, created_at) VALUES ('s1', 'stdout', 'clean', datetime('now'))");
    const result = await repairInvalidUtf8Rows(client, [...UTF8_REPAIR_TABLES], quarantineDir);
    expect(result.repairedRows).toBe(0);
    expect(result.quarantinePath).toBeNull();
  });
});

describe("sanitizeUtf8 (write-boundary guard)", () => {
  it("leaves well-formed strings untouched", () => {
    expect(sanitizeUtf8("hello world 🎉")).toBe("hello world 🎉");
  });

  it("replaces a lone high surrogate with U+FFFD", () => {
    const withLoneSurrogate = "abc" + String.fromCharCode(0xd83d) + "def"; // half of 🎉
    const sanitized = sanitizeUtf8(withLoneSurrogate);
    expect(sanitized).toBe("abc�def");
    // Critically: the sanitized string round-trips cleanly through UTF-8 bytes.
    expect(Buffer.from(sanitized, "utf8").toString("utf8")).toBe(sanitized);
  });

  it("replaces a lone low surrogate with U+FFFD", () => {
    const withLoneSurrogate = "abc" + String.fromCharCode(0xdd89) + "def";
    expect(sanitizeUtf8(withLoneSurrogate)).toBe("abc�def");
  });

  it("preserves a valid surrogate pair (real emoji)", () => {
    const emoji = "🎉"; // U+1F389, a valid surrogate pair
    expect(sanitizeUtf8(emoji)).toBe(emoji);
  });

  it("detects a lone surrogate on every call, not just the first (global-regex lastIndex)", () => {
    // The detector regex has the `g` flag and is reused across calls; a naive
    // `.test()` without resetting `lastIndex` only checks from where the previous
    // call left off, silently skipping violations in later calls.
    const first = "abc" + String.fromCharCode(0xd800) + "def";
    const second = String.fromCharCode(0xd800) + "x";
    expect(sanitizeUtf8(first)).toBe("abc�def");
    expect(sanitizeUtf8(second)).toBe("�x");
  });
});
