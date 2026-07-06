# Issue: Tasks eines Projekts als CSV exportieren

Als Teamlead möchte ich die Tasks meines Projekts als CSV-Datei exportieren können,
damit ich den aktuellen Stand für Reportings oder externe Auswertungen nutzen kann,
ohne manuell Daten aus dem Board abzutippen.

## Hintergrund

Es soll ein neuer Endpoint entstehen, der die Tasks eines Projekts abfragt, als CSV
aufbereitet und die fertige Datei zur weiteren Verarbeitung ablegt. Der Export soll
seitenweise abrufbar sein, damit auch große Projekte performant exportiert werden können.

## Acceptance Criteria

- **AC1** – Der Endpoint ist unter `GET /api/projects/:projectId/export/tasks` erreichbar
- **AC2** – Über die Query-Parameter `limit` (Standard: 100) und `offset` (Standard: 0)
  kann die Ergebnismenge eingeschränkt werden; übermäßig große Werte werden abgelehnt
- **AC3** – Die CSV enthält die Spalten: `id`, `title`, `status`, `assignee`, `createdAt`
- **AC4** – Tasks ohne zugewiesene Person dürfen keinen Fehler verursachen;
  die `assignee`-Spalte bleibt in diesem Fall leer
- **AC5** – Tritt beim Ablegen der Exportdatei ein Fehler auf (z. B. Speicherplatz voll,
  fehlende Berechtigungen), wird ein aussagekräftiger HTTP-Fehler zurückgegeben
- **AC6** – Bei erfolgreichem Export antwortet der Endpoint mit `201 Created`
