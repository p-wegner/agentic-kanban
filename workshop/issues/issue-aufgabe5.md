# Issue: Velocity-Tracking im Board-Stats-Panel

Als Teamlead möchte ich auf einen Blick sehen, wie viele Issues in den letzten
7, 30 oder 90 Tagen abgeschlossen wurden, damit ich die Team-Velocity ohne
manuelles Nachzählen einschätzen kann.

## Hintergrund

Das Board-Stats-Panel (`BoardStats.tsx`) zeigt bereits eine Fertigstellungsquote
und eine Spalten-Übersicht. Es fehlt aber ein Blick auf die *Geschwindigkeit*:
Wie viele Issues wurden zuletzt tatsächlich fertiggestellt? Dafür soll ein neuer
Velocity-Indikator ergänzt werden, der die Anzahl der im gewählten Zeitfenster
abgeschlossenen Issues anzeigt, inklusive eines Umschalters zwischen 7/30/90 Tagen
und dem Zeitpunkt der letzten Fertigstellung.

Die Berechnung soll als eigenständige, testbare Funktion (`computeVelocityStats`)
in `packages/client/src/lib/boardStats.ts` liegen, analog zu den bestehenden
Board-Stats-Berechnungen dort.

## Acceptance Criteria

- **AC1** – Ein neuer Indikator im Stats-Panel zeigt die Anzahl der im gewählten
  Fenster abgeschlossenen Issues ("Velocity")
- **AC2** – Ein Umschalter erlaubt die Wahl zwischen den Fenstern 7 Tage, 30 Tage
  und 90 Tage; die Auswahl aktualisiert die Anzeige sofort
- **AC3** – Zusätzlich wird angezeigt, wann das zuletzt abgeschlossene Issue im
  gewählten Fenster fertiggestellt wurde (bzw. ein Platzhalter, falls keins vorliegt)
- **AC4** – Die Berechnung basiert auf `statusChangedAt` der Issues in der
  Fertig-Spalte und berücksichtigt nur Issues, deren Statuswechsel innerhalb
  des gewählten Fensters liegt
- **AC5** – `computeVelocityStats` ist eine reine, unit-testbare Funktion ohne
  React-Abhängigkeiten (Input: Spalten-Daten + Fenster, Output: Zähler + Metadaten)
- **AC6** – Die Funktion ist so gebaut, dass ein zusätzliches Zeitfenster (z. B. "1 Jahr")
  sich anfügen lässt, ohne bestehenden Code umschreiben zu müssen
