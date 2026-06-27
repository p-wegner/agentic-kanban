// @covers mcp-server.create.agent-skill [security,error,boundary]
// Dimensions: this behaviour is INPUT VALIDATION of a name that becomes a filesystem
// path — no actor/role/authz is involved — so it is tagged `security`/`error`/`boundary`,
// NOT `permission`.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

// create_agent_skill writes to the module-level `db`/`schema` from ../db.js (it is
// NOT an injectable-ToolDeps tool). Swap that module for a fresh in-memory libsql DB
// so the test exercises the real registrar + real guard with no published-DB / FS
// dependency. The same db instance is shared back to the test via `dbRef` so we can
// assert on the rows the tool actually wrote.
const dbRef = vi.hoisted(() => ({}) as { db?: any; schema?: any });
vi.mock("../../db.js", async () => {
  const { createTestDb } = await import("../helpers/test-db.js");
  const schema = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  dbRef.db = db;
  dbRef.schema = schema;
  return { db, schema, rawClient: {} };
});

import { registerCreateAgentSkill } from "../../tools/create-agent-skill.js";
import { createToolHarness } from "../helpers/tool-harness.js";

function makeInvoke() {
  const { server, getHandler } = createToolHarness();
  registerCreateAgentSkill(server);
  return getHandler();
}

/** All skill rows whose name === `name` (any scope). */
async function rowsNamed(name: string) {
  return dbRef.db
    .select()
    .from(dbRef.schema.agentSkills)
    .where(eq(dbRef.schema.agentSkills.name, name));
}

describe("create_agent_skill MCP tool", () => {
  // The mock builds ONE shared in-memory DB (a vi.mock factory runs once). Without a
  // reset, tests would share rows and develop hidden ordering coupling (e.g. the
  // uniqueness test relying on no prior "duplo" row). Clear the table before each test
  // so every case starts from an empty skills table — same mocked module, fresh state.
  beforeEach(async () => {
    await dbRef.db.delete(dbRef.schema.agentSkills);
  });

  it("persists a valid skill (happy path)", async () => {
    const invoke = makeInvoke();

    const result = await invoke({
      name: "dependency-mapper",
      description: "Maps ticket dependencies",
      prompt: "Analyze {{issueId}} and propose dependency edges.",
    });

    // Success returns the created skill as JSON (id + echoed fields), not an Error string.
    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBeTruthy();
    expect(data.name).toBe("dependency-mapper");
    expect(data.projectId).toBeNull();

    // The row is actually in the table — this is what later materializes to
    // .claude/skills/<name>/SKILL.md, so persistence is the observable outcome.
    const rows = await rowsNamed("dependency-mapper");
    expect(rows).toHaveLength(1);
    expect(rows[0].isBuiltin).toBe(false);
  });

  it.each([
    ["../../evil", "parent-dir traversal"],
    ["..\\..\\evil", "windows parent-dir traversal"],
    ["nested/evil", "forward-slash subpath"],
    ["nested\\evil", "backslash subpath"],
    ["/etc/cron.d/payload", "absolute posix path"],
  ])(
    "rejects path-traversal name %j (%s) and writes NO row",
    async (maliciousName) => {
      const invoke = makeInvoke();

      const result = await invoke({
        name: maliciousName,
        description: "attempts to escape the skills directory",
        prompt: "should never be written to disk",
      });

      // The guard returns a plain Error string, NOT the success JSON. Assert on the
      // stable "cannot contain" token rather than the full sentence so wording can
      // change without breaking the security contract.
      const text = result.content[0].text;
      expect(text).toMatch(/Error/i);
      expect(text).toMatch(/cannot contain|'\/'|\.\./);
      // It must NOT be the success shape (a parseable object with an id).
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      expect((parsed as { id?: string } | undefined)?.id).toBeUndefined();

      // The security boundary: a traversal name is never inserted, so it can never
      // be materialized into a SKILL.md path OUTSIDE the intended skills dir.
      const rows = await rowsNamed(maliciousName);
      expect(rows).toHaveLength(0);
    },
  );

  // --- Create↔materialization guard divergence (ticket #931) ---------------------
  // The create-time guard (create-agent-skill.ts:19, /[/\\]|\.\./) is STRICTLY WEAKER
  // than the downstream filesystem guard (shared/src/lib/agent-skill-files.ts:11, which
  // also rejects the EXACT names "." and ".."). Several filesystem-degenerate names pass
  // create today and get a DB row, then later resolve to a degenerate skills path:
  //   "."  → join(skillsDir, ".")  = skillsDir itself
  //   ""   → join(skillsDir, "")   = skillsDir itself (zod has no .min(1) on `name`)
  //   "C:" → a Windows drive-relative path
  // These `it.fails` cases assert the DESIRED post-#931 behaviour (create REJECTS them
  // with zero rows). Today the body FAILS (the row IS inserted) → it.fails PASSES, so the
  // suite stays green while flagging the gap. When #931 unifies the guards the body will
  // PASS → it.fails FLIPS to failing, forcing whoever lands #931 to delete the `.fails`
  // marker and promote these to ordinary assertions.
  it.fails.each([
    [".", "bare current-dir"],
    ["", "empty string (no zod .min(1))"],
    ["C:", "windows drive-relative"],
  ])(
    "[#931 desired] rejects filesystem-degenerate name %j (%s) with zero rows",
    async (degenerateName) => {
      const invoke = makeInvoke();

      const result = await invoke({
        name: degenerateName,
        description: "filesystem-degenerate name that passes the weak create guard",
        prompt: "should be rejected once the guards are unified (#931)",
      });

      // DESIRED: an Error string, not the success JSON, and nothing persisted.
      const text = result.content[0].text;
      expect(text).toMatch(/Error/i);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      expect((parsed as { id?: string } | undefined)?.id).toBeUndefined();
      const rows = await rowsNamed(degenerateName);
      expect(rows).toHaveLength(0);
    },
  );

  it("enforces per-scope name uniqueness (no second row for a taken name)", async () => {
    const invoke = makeInvoke();

    const first = await invoke({
      name: "duplo",
      description: "first",
      prompt: "p1",
    });
    expect(JSON.parse(first.content[0].text).id).toBeTruthy();

    const second = await invoke({
      name: "duplo",
      description: "second",
      prompt: "p2",
    });
    // Duplicate is rejected with a non-success message…
    expect(second.content[0].text).toMatch(/already exists/i);
    // …and the table still holds exactly one "duplo".
    const rows = await rowsNamed("duplo");
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe("first");
  });
});
