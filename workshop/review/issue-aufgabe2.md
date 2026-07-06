# Issue: Issues als CSV exportieren

Als Projektmanagerin möchte ich die Issues meines Projekts als CSV-Datei herunterladen können,
damit ich sie in Excel weiterverarbeiten oder an Stakeholder weitergeben kann, die keinen
Zugriff auf das Board haben.

## Hintergrund

Aktuell gibt es keine Möglichkeit, den aktuellen Stand der Issues aus dem System zu exportieren.
Der Export soll über einen neuen API-Endpoint erreichbar sein und eine sauber formatierte
CSV-Datei zurückgeben.

## Acceptance Criteria

- **AC1** – Der Endpoint ist unter `GET /api/projects/:projectId/export/csv` erreichbar
- **AC2** – Die Issues sind nach Bearbeitungsstatus sortiert: `todo → in_progress → done → cancelled`
- **AC3** – Die CSV enthält die Spalten: `id`, `title`, `status`, `priority`, `created_at`, `assignee`
  — Datumsformat für `created_at`: ISO 8601 (`YYYY-MM-DDTHH:mm:ssZ`)
- **AC4** – Abgebrochene Issues (`cancelled`) werden standardmäßig nicht exportiert;
  mit dem Query-Parameter `?includeCancelled=true` werden sie eingeschlossen
- **AC5** – Wenn nach Filterung keine Issues vorhanden sind, antwortet der Endpoint mit `204 No Content`
- **AC6** – Die Antwort enthält den Header `Content-Disposition: attachment; filename="issues-{projectId}-{YYYY-MM-DD}.csv"`,
  damit der Browser die Datei direkt zum Download anbietet
