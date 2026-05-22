import { createClient } from '@libsql/client';
const client = createClient({ url: 'file:kanban.db' });
// Get workspace details
const ws = await client.execute(
  "SELECT w.*, i.title, i.description as issue_desc FROM workspaces w JOIN issues i ON w.issue_id = i.id WHERE w.branch LIKE '%mpfdm80q%'"
);
console.log('Workspace:', JSON.stringify(ws.rows[0], null, 2));
// Get sessions for this workspace
const sessions = await client.execute(
  `SELECT id, status, created_at FROM sessions WHERE workspace_id = '${ws.rows[0].id}' ORDER BY created_at DESC LIMIT 5`
);
console.log('Sessions:', JSON.stringify(sessions.rows, null, 2));
await client.close();
