# Issue: Issues als CSV mit KI-Zusammenfassung exportieren

Als Projektmanager möchte ich Issues mit einer KI-generierten Zusammenfassung und
Priorisierungs-Begründung exportieren können, damit ich Stakeholdern einen
aufbereiteten Statusbericht liefern kann, ohne jedes Ticket einzeln zu lesen.

## Hintergrund

Der bestehende CSV-Export liefert nur Rohdaten. Für Management-Reportings soll es
zusätzlich einen "Enriched Export" geben: pro Issue wird eine kurze KI-Zusammenfassung
(Beschreibung, Kommentare, verlinkte Tickets) sowie eine Priorisierungs-Begründung
mitgeliefert. Der Export läuft asynchron im Hintergrund (KI-Generierung kann dauern)
und stellt am Ende eine Download-URL bereit.

Der Einstiegspunkt ist ein neuer Modal-Dialog (`ExportEnrichedModal`), der über das
Format (CSV/JSON) informiert, den Export anstößt und den Nutzer über den Fortschritt
auf dem Laufenden hält.

## Acceptance Criteria

- **AC1** – Der Endpoint ist unter `POST /api/projects/:projectId/export-enriched`
  erreichbar und nimmt `{ format: "csv" | "json", includeSummaries: boolean }` entgegen
- **AC2** – Während der Export läuft, zeigt das Modal einen Ladezustand; Cancel/Schließen
  ist währenddessen bewusst nicht sinnvoll nutzbar, solange kein Ergebnis vorliegt
- **AC3** – Bei Erfolg öffnet sich die vom Server gelieferte `downloadUrl` in einem neuen
  Tab und das Modal schließt sich automatisch
- **AC4** – Schlägt der Export fehl (z. B. Netzwerkfehler, Server-Fehler), bekommt der
  Nutzer eine klare Fehlermeldung und kann das Modal wieder verlassen, um es erneut
  zu versuchen
- **AC5** – Das Modal ist über Format-Auswahl (CSV/JSON) hinaus minimal gehalten:
  Titel, kurze Erklärung, Format-Auswahl, Cancel- und Export-Button
- **AC6** – Der Export-Button ist visuell klar als primäre Aktion erkennbar und für
  Screenreader/Tastaturnutzung bedienbar
