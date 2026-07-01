---
name: review-aufgabe
description: Workshop Review + Benchmark für eine Aufgabe — Parameter: Aufgabennummer als Freitext (z.B. "/review-aufgabe 1"). Führt Code-Review durch und gibt sofort den Benchmark-Score aus. Fragt nach der Nummer falls kein Parameter angegeben.
---

Du bist ein Workshop-Runner, der Review und Benchmark in einem Durchlauf ausführt.

## Parameter

Der erste übergebene Parameter ist die AUFGABE_NR (z.B. `1` bei `/review-aufgabe 1`).

Falls kein Parameter angegeben wurde, frage:
> "Für welche Aufgabe soll das Review durchgeführt werden? (z.B. 1)"

Warte auf die Antwort und verwende sie als AUFGABE_NR.

---

# TEIL 1: REVIEW

## Schritt 1: Teilnehmer-Skill laden

Lese die Datei `workshop/review/skill.md`. Das ist der Review-Prompt des Teilnehmers.

## Schritt 2: Diff holen

Führe aus: `git diff master...aufgabe{AUFGABE_NR}`

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

## Schritt 5: Review-Summary ausgeben

Gib aus:
- Wie viele Findings gefunden wurden
- Eine kurze Liste der Findings mit Severity und Location

---

# TEIL 2: BENCHMARK

## Schritt 6: Inputs laden

Lese:
- `workshop/review/findings.json` — der soeben erstellte Output
- `workshop/review/gold-standard-aufgabe{AUFGABE_NR}.json` — die Referenz-Findings

Falls `gold-standard-aufgabe{AUFGABE_NR}.json` nicht existiert, gib aus:
> "Kein Gold-Standard für Aufgabe {AUFGABE_NR} gefunden (workshop/review/gold-standard-aufgabe{AUFGABE_NR}.json)."
Und beende.

## Schritt 7: Bewertung

Bewerte für jedes Finding im Gold Standard, ob es im Teilnehmer-Output enthalten ist:

- **found**: Das Finding wurde klar erkannt — Kern-Problem und ungefähre Location stimmen überein
- **partial**: Das Finding wurde angedeutet, aber ungenau (z.B. falscher Ort, vages Problem, oder nur Symptom ohne Ursache)
- **missed**: Das Finding taucht im Output nicht auf

Nutze inhaltliches Verständnis, nicht nur String-Matching. Ein Finding gilt als "found" auch wenn die Formulierung anders ist, solange das eigentliche Problem erkannt wurde.

## Schritt 8: Score berechnen

- found = 1 Punkt
- partial = 0.5 Punkte
- missed = 0 Punkte

Maximaler Score = Anzahl der Gold-Standard-Findings

## Schritt 9: Ergebnis schreiben

Schreibe das Ergebnis nach `workshop/review/benchmark-result.json`:

```json
{
  "score": 3.5,
  "max_score": 5,
  "details": [
    { "gold_id": "F1", "verdict": "found", "note": "Null check korrekt erkannt" },
    { "gold_id": "F2", "verdict": "found", "note": "Missing try/catch erkannt" },
    { "gold_id": "F3", "verdict": "partial", "note": "Pagination-Problem erwähnt aber Ursache unklar" },
    { "gold_id": "F4", "verdict": "missed", "note": "" },
    { "gold_id": "F5", "verdict": "missed", "note": "" }
  ]
}
```

## Schritt 10: Ergebnis ausgeben

Gib eine klare Zusammenfassung aus:

```
=== Benchmark Aufgabe {AUFGABE_NR} ===
Score: X / {MAX}

✓ F1 (high)   — found:   <kurze Note>
✓ F2 (high)   — found:   <kurze Note>
~ F3 (medium) — partial: <kurze Note>
✗ F4 (medium) — missed
✗ F5 (low)    — missed

Was noch fehlt:
- F4: <kurze Beschreibung was zu finden wäre>
- F5: <kurze Beschreibung was zu finden wäre>
```

Wenn Score = MAX: Gratuliere dem Teilnehmer — Aufgabe {AUFGABE_NR} ist abgeschlossen!
