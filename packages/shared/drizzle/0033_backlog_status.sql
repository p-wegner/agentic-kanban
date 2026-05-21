INSERT INTO project_statuses (id, project_id, name, sort_order, is_default, created_at)
SELECT lower(hex(randomblob(4)) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
       p.id, 'Backlog', -1, 0, datetime('now')
FROM projects p;
