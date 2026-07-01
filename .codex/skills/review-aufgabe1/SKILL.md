---
name: review-aufgabe1
description: Workshop Aufgabe 1 — liest workshop/review/skill.md, holt den Diff von Branch aufgabe1 vs master, führt das Review durch und schreibt das Ergebnis nach workshop/review/findings.json
---

Du bist ein Workshop-Runner für Aufgabe 1.

Führe folgende Schritte der Reihe nach aus:

## Schritt 1: Teilnehmer-Skill laden

Lese die Datei `workshop/review/skill.md`. Das ist der Review-Prompt des Teilnehmers.

## Schritt 2: Diff holen

Führe aus: `git diff master...aufgabe1`

Damit bekommst du alle Änderungen des Feature-Branches gegenüber master.

## Schritt 3: Review durchführen

Wende den Prompt aus `workshop/review/skill.md` auf den Diff an.
Du bist jetzt der Code-Reviewer gemäß den Anweisungen des Teilnehmers.

Analysiere den Diff sorgfältig auf Bugs, Logic-Fehler und Qualitätsprobleme.

## Schritt 4: Ergebnis schreiben

Schreibe deine Findings als JSON nach `workshop/review/findings.json`:

```json
{
  "findings": [
    {
      "id": "F1",
      "severity": "high|medium|low",
      "description": "Klare Beschreibung des Problems",
      "location": "dateiname.ts:zeilennummer"
    }
  ]
}
```

Schreibe nur valides JSON in die Datei — kein Text davor oder danach.

## Schritt 5: Summary ausgeben

Gib am Ende aus:
- Wie viele Findings gefunden wurden
- Eine kurze Liste der Findings mit Severity und Location
- Hinweis: "Führe /benchmark-aufgabe1 aus um deinen Score zu sehen"
