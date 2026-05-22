const Database = require('better-sqlite3');
const db = new Database('./kanban.db', {readonly: true});
const row = db.prepare("SELECT i.id, i.issue_number, i.title, i.description, s.name as status FROM issues i JOIN issue_statuses s ON i.status_id = s.id WHERE i.issue_number = 62").get();
console.log(JSON.stringify(row, null, 2));
db.close();
