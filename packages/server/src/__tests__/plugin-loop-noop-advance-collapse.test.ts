import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { pluginEnabledPreferenceKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { seedProject } from "./helpers/workflow-test-helpers.js";
import { getPluginService } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";
import type { CreateIssueInput, CreateIssueResult } from "../services/issue.service.js";

/**
 * #448 — a repeated no-op advance must not append another timeline row.
 *
 * The monitor re-plans a gated loop every ~4 minutes; on the live `mealplan` loop that produced
 * ~50 byte-identical `Advanced: nothing planned — <full gate note>` rows over 13 hours, which
 * pushed every real event (gate-reached, converged, butler pre-reads, step completions) out of the
 * client's 50-row window. The contract asserted here: an unchanged no-op bumps `repeatCount` on the
 * existing row instead of inserting; a CHANGED note inserts a new row.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A planner whose note is read from a file, so the loop's reported state can be changed. */
function makePluginDir(): { pluginDir: string; setNote: (note: string) => void } {
  const dir = makeTempDir("loop-noop-collapse-");
  const noteFile = join(dir, "note.txt");
  writeFileSync(
    join(dir, "kanban-plugin.json"),
    JSON.stringify({
      id: "collapse-plugin",
      name: "Collapse Plugin",
      skills: [{ dir: "skills/analysis" }],
      loops: [{
        name: "sweep",
        skill: "analysis",
        plan: { command: "node plan.mjs", cwd: "plugin", env: { NOTE_FILE: "{{pluginPath}}/note.txt" } },
      }],
    }, null, 2),
  );
  const skillDir = join(dir, "skills", "analysis");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# analysis");
  writeFileSync(
    join(dir, "plan.mjs"),
    "import { readFileSync } from 'node:fs';\n"
      + "const note = readFileSync(process.env.NOTE_FILE, 'utf8');\n"
      + "console.log(JSON.stringify({ units: [], converged: false, note,"
      + " gate: { id: 'g1', question: note, actions: [{ id: 'approve', label: 'Approve' }],"
      + " resolve: { command: 'node -e 0' } } }));\n",
  );
  const setNote = (note: string) => writeFileSync(noteFile, note);
  setNote("awaiting your review");
  return { pluginDir: dir, setNote };
}

async function setup(db: TestDb, pluginDir: string) {
  const { projectId } = await seedProject(db, "Collapse Project");
  const createIssue = async (input: CreateIssueInput): Promise<CreateIssueResult> => {
    void input;
    throw new Error("this test's planner never plans units");
  };
  const service = getPluginService(db as unknown as Database, { createIssue });
  const plugin = await service.installPlugin({ source: pluginDir });
  await db.insert(schema.preferences).values({
    key: pluginEnabledPreferenceKey("collapse-plugin", projectId),
    value: "true",
    updatedAt: new Date().toISOString(),
  });
  return { projectId, plugin, service };
}

function advanceRows(db: TestDb, projectId: string) {
  return db
    .select()
    .from(schema.pluginLoopEvents)
    .where(and(
      eq(schema.pluginLoopEvents.projectId, projectId),
      eq(schema.pluginLoopEvents.type, "advance"),
    ));
}

describe("#448 repeated no-op advances collapse instead of appending", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — best-effort cleanup */
      }
    }
  });

  it("an unchanged no-op advance creates no second row, and bumps repeatCount instead", async () => {
    const { db } = createTestDb();
    const { pluginDir } = makePluginDir();
    const { projectId, plugin, service } = await setup(db, pluginDir);

    await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(await advanceRows(db, projectId)).toHaveLength(1);

    await service.advanceLoop(plugin.id, "sweep", projectId);
    await service.advanceLoop(plugin.id, "sweep", projectId);

    const rows = await advanceRows(db, projectId);
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson!) as { repeatCount?: number; firstSeenAt?: string };
    expect(payload.repeatCount).toBe(3);
    // The run is bounded at both ends: `firstSeenAt` is where it began, `createdAt` is the
    // most recent poll (which is what `lastAdvanceAt` and the monitor's interval gate read).
    expect(typeof payload.firstSeenAt).toBe("string");
    expect(new Date(rows[0]!.createdAt).getTime())
      .toBeGreaterThanOrEqual(new Date(payload.firstSeenAt!).getTime());

    // The liveness signal survives: the surface still reports a recent advance.
    const statuses = await service.listLoops(plugin.id, projectId);
    expect(statuses[0]?.lastAdvanceAt).toBe(rows[0]!.createdAt);
  });

  it("a changed note is a new row — the first no-op after a state change is never swallowed", async () => {
    const { db } = createTestDb();
    const { pluginDir, setNote } = makePluginDir();
    const { projectId, plugin, service } = await setup(db, pluginDir);

    await service.advanceLoop(plugin.id, "sweep", projectId);
    await service.advanceLoop(plugin.id, "sweep", projectId);
    expect(await advanceRows(db, projectId)).toHaveLength(1);

    setNote("step 8/9 now awaits your review");
    await service.advanceLoop(plugin.id, "sweep", projectId);

    const rows = await advanceRows(db, projectId);
    expect(rows).toHaveLength(2);
    const notes = rows.map((r) => (JSON.parse(r.payloadJson!) as { note: string }).note).sort();
    expect(notes).toEqual(["awaiting your review", "step 8/9 now awaits your review"]);

    // …and the repeat run that followed the change collapses onto the NEW row, not the old one.
    await service.advanceLoop(plugin.id, "sweep", projectId);
    const after = await advanceRows(db, projectId);
    expect(after).toHaveLength(2);
    const changed = after.find((r) => (JSON.parse(r.payloadJson!) as { note: string }).note.startsWith("step 8"));
    expect((JSON.parse(changed!.payloadJson!) as { repeatCount?: number }).repeatCount).toBe(2);
  });
});
