# Issue: Liegengebliebene Issues anzeigen ("Stale Issues")

Als Teamlead möchte ich pro Projekt sehen können, welche Issues seit längerer Zeit nicht
mehr angefasst wurden, damit ich liegengebliebene Arbeit gezielt nachfassen kann, statt das
Board manuell nach alten Tickets zu durchsuchen.

## Hintergrund

Es soll ein neuer Endpoint entstehen, der die Issues eines Projekts abfragt und alle
zurückgibt, die seit mindestens einer konfigurierbaren Anzahl Tage "liegen geblieben" sind.
Standardmäßig werden abgeschlossene Tickets nicht berücksichtigt, da sie kein Nachfassen
benötigen.

## Acceptance Criteria

- **AC1** – Der Endpoint ist unter `GET /api/projects/:projectId/issues/stale` erreichbar
- **AC2** – Über den Query-Parameter `days` (Standard: 14) kann das Zeitfenster konfiguriert
  werden; Werte außerhalb von 1-365 werden auf die nächste gültige Grenze begrenzt statt
  einen Fehler zu werfen
- **AC3** – Abgebrochene Issues (`cancelled`) werden standardmäßig ausgeschlossen; mit
  `?includeDone=true` werden auch abgeschlossene Issues (`done`) eingeschlossen
- **AC4** – Jedes zurückgegebene Issue enthält ein Feld `daysSinceUpdate`, das angibt, wie
  viele Tage seit der letzten Aktualisierung (`updatedAt`) vergangen sind
- **AC5** – Die Ergebnisliste ist absteigend nach `daysSinceUpdate` sortiert — am längsten
  liegengebliebene Issues zuerst
- **AC6** – Gibt es nach Filterung keine liegengebliebenen Issues, antwortet der Endpoint mit
  `200` und einem leeren Array (kein Fehler)
