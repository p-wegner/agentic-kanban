/**
 * Seeds example session messages for the "Verify output parser" issue.
 * Run AFTER the issue was created via API.
 *
 * Usage: npx tsx src/scripts/seed-example-session.ts <issueId> <workspaceId> <sessionId>
 *   OR: npx tsx src/scripts/seed-example-session.ts (auto-creates workspace + session)
 */
import { createClient } from "@libsql/client";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, "../../kanban.db");
const examplePath = resolve(__dirname, "../../../../docs/temp/examplesession.md");

const db = createClient({ url: `file:${dbPath}` });

const ISSUE_ID = process.argv[2];
const WS_ID = process.argv[3] || randomUUID();
const SESSION_ID = process.argv[4] || randomUUID();

async function main() {
  if (!ISSUE_ID) {
    console.error("Usage: npx tsx src/scripts/seed-example-session.ts <issueId> [workspaceId] [sessionId]");
    process.exit(1);
  }

  const content = readFileSync(examplePath, "utf-8");
  const lines = content.trim().split("\n").filter(l => l.trim());

  // Create workspace
  await db.execute({
    sql: `INSERT INTO workspaces (id, issue_id, branch, status, working_dir, base_branch, created_at, updated_at)
          VALUES (?, ?, 'feature/test-parser', 'idle', '/tmp/test', 'main', datetime('now'), datetime('now'))`,
    args: [WS_ID, ISSUE_ID],
  });
  console.log(`Created workspace: ${WS_ID}`);

  // Create session
  await db.execute({
    sql: `INSERT INTO sessions (id, workspace_id, executor, status, started_at, ended_at)
          VALUES (?, ?, 'claude', 'completed', datetime('now'), datetime('now'))`,
    args: [SESSION_ID, WS_ID],
  });
  console.log(`Created session: ${SESSION_ID}`);

  // Insert example session messages
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    await db.execute({
      sql: "INSERT INTO session_messages (session_id, type, data, created_at) VALUES (?, 'stdout', ?, datetime('now'))",
      args: [SESSION_ID, trimmed],
    });
    count++;
  }

  // Add exit message
  await db.execute({
    sql: "INSERT INTO session_messages (session_id, type, exit_code, created_at) VALUES (?, 'exit', '0', datetime('now'))",
    args: [SESSION_ID],
  });
  count++;

  console.log(`Inserted ${count} session messages`);
  console.log(`\nNow open http://localhost:${process.env.VITE_PORT || 5173}`);
  console.log(`Click "Verify output parser" → View Workspaces → expand workspace`);
}

main().catch(console.error);
