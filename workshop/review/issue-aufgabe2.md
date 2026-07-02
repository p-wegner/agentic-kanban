# Issue: Export issues as CSV file

Ein neuer Endpoint soll die Issues eines Projekts als CSV-Datei exportieren.

## Acceptance Criteria

- **AC1** – Endpoint: `GET /api/projects/:projectId/export/csv`
- **AC2** – Issues werden nach Status-Reihenfolge sortiert:
  `todo → in_progress → done → cancelled`
- **AC3** – Erforderliche CSV-Spalten: `id`, `title`, `status`, `priority`,
  `created_at` (ISO 8601: `YYYY-MM-DDTHH:mm:ssZ`), `assignee`
- **AC4** – Issues mit Status `cancelled` werden standardmäßig ausgeschlossen;
  sie werden nur einbezogen, wenn `?includeCancelled=true` übergeben wird
- **AC5** – Leeres Ergebnis (nach Filterung) → `204 No Content`, nicht eine
  leere CSV mit Status 200
- **AC6** – Header:
  `Content-Disposition: attachment; filename="issues-{projectId}-{YYYY-MM-DD}.csv"`
