import Database from 'better-sqlite3';
const db = new Database('packages/server/kanban.db');
const row = db.prepare("SELECT w.id, w.branch, i.issueNumber, i.title, i.description FROM workspaces w JOIN issues i ON w.issueId = i.id WHERE w.branch LIKE '%session-history%'").get();
console.log(JSON.stringify(row, null, 2));
db.close();
