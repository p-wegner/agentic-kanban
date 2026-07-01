---
name: benchmark-aufgabe1
description: Workshop Aufgabe 1 — vergleicht workshop/review/findings.json mit dem Gold Standard und gibt einen Score aus (LLM-as-judge)
---

Du bist ein Workshop-Benchmarker für Aufgabe 1.

Führe folgende Schritte der Reihe nach aus:

## Schritt 1: Inputs laden

Lese:
- `workshop/review/findings.json` — der Output des Teilnehmer-Skills
- `workshop/review/gold-standard-aufgabe1.json` — die Referenz-Findings

Falls `findings.json` nicht existiert, gib aus:
> "Noch kein findings.json gefunden. Führe zuerst /review-aufgabe1 aus."
Und beende.

## Schritt 2: Bewertung

Bewerte für jedes Finding im Gold Standard (F1–F5), ob es im Teilnehmer-Output enthalten ist:

- **found**: Das Finding wurde klar erkannt — Kern-Problem und ungefähre Location stimmen überein
- **partial**: Das Finding wurde angedeutet, aber ungenau (z.B. falscher Ort, vages Problem, oder nur Symptom ohne Ursache)
- **missed**: Das Finding taucht im Output nicht auf

Nutze inhaltliches Verständnis, nicht nur String-Matching. Ein Finding gilt als "found" auch wenn die Formulierung anders ist, solange das eigentliche Problem erkannt wurde.

## Schritt 3: Score berechnen

- found = 1 Punkt
- partial = 0.5 Punkte
- missed = 0 Punkte

Maximaler Score: 5

## Schritt 4: Ergebnis schreiben

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

## Schritt 5: Ergebnis ausgeben

Gib eine klare Zusammenfassung aus:

```
=== Benchmark Aufgabe 1 ===
Score: X / 5

✓ F1 (high)   — found:   <kurze Note>
✓ F2 (high)   — found:   <kurze Note>
~ F3 (medium) — partial: <kurze Note>
✗ F4 (medium) — missed
✗ F5 (low)    — missed

Was noch fehlt:
- F4: <kurze Beschreibung was zu finden wäre>
- F5: <kurze Beschreibung was zu finden wäre>
```

Wenn Score = 5: Gratuliere dem Teilnehmer — Aufgabe 1 ist abgeschlossen!
