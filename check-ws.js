const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("packages/server/kanban.db");
const rows = db.prepare(
  "SELECT id, branch, status, working_dir FROM workspaces WHERE status = 'active' AND working_dir LIKE '%agentic-kanban' LIMIT 10"
).all();
console.log(JSON.stringify(rows, null, 2));
db.close();
