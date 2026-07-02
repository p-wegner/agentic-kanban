---
name: review-aufgabe
description: Workshop Review + Benchmark für eine Aufgabe — Parameter: Aufgabennummer als Freitext (z.B. "/review-aufgabe 1"). Pinnt Aufgabe und Branch, stellt den Diff + vollen Tool-Zugriff bereit und führt das Review als eigenen Subagent aus (Fan-out für große Diffs möglich); gibt sofort den Benchmark-Score inkl. Token-Verbrauch aus. Fragt nach der Nummer falls kein Parameter angegeben.
argument-hint: "[Aufgabennummer, z.B. 1]"
---

Du bist ein Workshop-Runner (das "Harness"), der Review und Benchmark in einem Durchlauf ausführt.

Wichtiges Prinzip: **Der Teilnehmer-Skill besitzt die Review-Strategie, das Harness verankert nur die Aufgabe.**
Das Harness pinnt zuverlässig Aufgabe und Branch, stellt den Diff sowie vollen Tool-Zugriff bereit und
führt die Methodik des Teilnehmers treu aus. Es schreibt dem Teilnehmer **kein** Frontmatter-Schema vor
und fetcht/chunkt **nicht** von sich aus: Braucht ein Review mehr als den Diff (z.B. Ticket/Acceptance
Criteria, Quelldateien, History), muss der Teilnehmer-Skill sich das über seine eigenen Tools holen.
Ein naiver Teilnehmer-Skill soll an Aufgaben scheitern, die mehr als den Diff brauchen.

**Ausgabe-Regel:** Arbeite TEIL 0–3 **still** ab — keine Schritt-für-Schritt-Erklärungen, keine
Tool-Kommentare. Gib am Ende **genau zwei Blöcke** aus (nichts sonst): zuerst das **Review-Ergebnis
des Teilnehmer-Skills** (die Findings), danach den **Benchmark-Block** (die Bewertung). Beide Formate
stehen in TEIL 4.5. Einzige Ausnahme: Abbruchmeldungen (fehlender Branch in TEIL 0, fehlender
Gold-Standard in TEIL 4.1).

## Parameter

Der erste übergebene Parameter ist die AUFGABE_NR (z.B. `1` bei `/review-aufgabe 1`).

Falls kein Parameter angegeben wurde, frage:
> "Für welche Aufgabe soll das Review durchgeführt werden? (z.B. 1)"

Warte auf die Antwort und verwende sie als AUFGABE_NR.

---

# TEIL 0: Vorbereitung

## Schritt 0.1: Branch prüfen

Die Aufgaben-Branches existieren nur als Remote-Branches. Prüfe:

```powershell
git rev-parse --verify --quiet origin/aufgabe{AUFGABE_NR}
```

Wenn der Befehl nichts zurückgibt (Branch fehlt), gib aus:
> "Branch origin/aufgabe{AUFGABE_NR} nicht gefunden. Verfügbar: $(git branch -r)"
Und beende.

---

# TEIL 1: Aufgabe verankern & Diff bereitstellen

Das Harness parst **kein** vorgegebenes Frontmatter-Schema. Es pinnt die Aufgabe zuverlässig (Branch,
Basis, Diff) und übergibt dem Reviewer diesen festen Anker plus vollen Tool-Zugriff. Jeden weiteren
Kontext holt sich der Teilnehmer-Skill über seine eigene Methodik.

## Schritt 1.1: Teilnehmer-Skill (Methodik) laden

Lese `workshop/review/skill.md`. Der gesamte Inhalt ist die **Review-Methodik** — der Prompt, dem der
Reviewer folgt. Führende Doku-/Kommentarblöcke (`<!-- ... -->`) sind Anleitung für den Teilnehmer und
gehören nicht in den Reviewer-Prompt; alles andere schon. **Keine Schlüssel-Interpretation** — was der
Teilnehmer nicht in seiner Methodik beschreibt, passiert nicht.

## Schritt 1.2: Diff für die richtige Aufgabe materialisieren

Damit der Reviewer garantiert die **richtige** Aufgabe/den richtigen Branch prüft — egal wie seine
Methodik formuliert ist — pinnt das Harness den Diff selbst über die in TEIL 0 verifizierte Branch-Ref
und schreibt ihn in eine Scratch-Datei (hält den ggf. großen Diff aus dem Trainer-Kontext):

```powershell
$diffFile = Join-Path $env:TEMP "review-aufgabe{AUFGABE_NR}-diff.txt"
git diff origin/master...origin/aufgabe{AUFGABE_NR} | Out-File -Encoding utf8 $diffFile
(git diff --stat origin/master...origin/aufgabe{AUFGABE_NR} | Select-Object -Last 1).Trim()
```

## Schritt 1.3: Aufgaben-Anker bauen

Baue einen festen Anker-Block, der dem Reviewer sagt, WORAN er arbeitet und WAS bereitsteht:
- Aufgabe: {AUFGABE_NR}
- Branch: `origin/aufgabe{AUFGABE_NR}` — Basis: `origin/master`
- Diff-Kommando (bei Bedarf selbst ausführbar): `git diff origin/master...origin/aufgabe{AUFGABE_NR}`
- Vollständiger Diff bereits materialisiert unter `<diffFile>` (mit Read lesen)
- Diff-Größe: `<stat>`
- Token-Budget-Hinweis aus CONCEPT.md (z.B. "mittlerer PR-Review < ~10.000 Output-Tokens")
- **Voller Tool-Zugriff** (Bash, Read, Grep, Agent): "Hol dir jeden weiteren Kontext, den deine Methodik
  braucht, selbst — z.B. verknüpftes Ticket/Acceptance Criteria, Quelldateien, Commit-History."
- **Integritäts-Guard**: "Lies keine Workshop-Referenzdateien (`gold-standard-*`, `benchmark-result-*`) —
  das ist die Bewertungsgrundlage, nicht Teil des Reviews."

Der Anker ist vom Harness fest vorgegeben; er verlangt vom Teilnehmer **keine** Schlüssel.

---

# TEIL 2: Review als Subagent

## Schritt 2.1: Reviewer-Subagent starten

Starte **einen** Subagenten (Agent-Tool, `subagent_type: "general-purpose"`) mit vollem Tool-Zugriff.
Führe das Review NICHT inline in dieser Session aus — die Isolation hält den (ggf. großen) Diff aus
dem Trainer-Kontext und macht die Token-Messung sauber.

Der Prompt an den Subagenten enthält, in dieser Reihenfolge:
1. Den **Methodik-Body** des Teilnehmer-Skills (Schritt 1.1) — das ist die Anleitung, der der Subagent folgt.
2. Den **Aufgaben-Anker** (Schritt 1.3).
3. Einen festen **Output-Vertrag** (vom Harness angehängt):
   > Schreibe deine Findings als valides JSON nach `workshop/review/findings-{AUFGABE_NR}.json`
   > (Schema unten, kein Text davor/danach). Gib als Antwort nur eine einzeilige Zusammenfassung
   > zurück (Anzahl Findings). Du darfst gemäß deiner Methodik eigene Subagenten pro Modul/Chunk starten.

Output-Schema (Teil des Vertrags):

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

## Schritt 2.2: Findings & Token-Verbrauch übernehmen

Nachdem der Subagent zurückkehrt, lese `workshop/review/findings-{AUFGABE_NR}.json`.
Falls die Datei fehlt oder kein valides JSON enthält, vermerke das und behandle die Findings als leer.

Merke dir außerdem den vom Agent-Tool zurückgegebenen **`subagent_tokens`**-Wert (im `<usage>`-Block
des Agent-Ergebnisses). Das ist die Selbstauskunft über den Token-Verbrauch des Reviews (Input inkl.
bereitgestelltem Kontext + Output). Er wird in TEIL 3 als `tokens_used` verwendet.

(Keine Zwischenausgabe — die Findings erscheinen später im Benchmark-Block. Siehe Ausgabe-Regel.)

---

# TEIL 3: Token-Abrechnung (Subagent-Selbstauskunft)

## Schritt 3.1: tokens_used bestimmen

`tokens_used` = der in Schritt 2.2 gemerkte **`subagent_tokens`**-Wert aus dem `<usage>`-Block des
Reviewer-Subagenten. Das ist der direkt vom Harness gemessene Token-Verbrauch des Reviews (Input inkl.
bereitgestelltem Kontext + Output) — ohne den Trainer-Session-Kontext zu vermischen.

Kein Transcript-Scan, kein Zeitfenster. Die Zahl kommt ausschließlich aus dem Agent-Ergebnis.

**Caveat bei Fan-out:** Wenn der Reviewer-Subagent gemäß seiner Strategie eigene Kind-Subagenten
startet, ist deren Verbrauch je nach Harness evtl. **nicht** in `subagent_tokens` enthalten — dann ist
`tokens_used` eine Untergrenze. Vermerke das in der Ausgabe, wenn du weißt, dass gefächert wurde. Falls
das Agent-Ergebnis keinen `subagent_tokens`-Wert liefert, setze `tokens_used: null` und vermerke es.

---

# TEIL 4: Benchmark

## Schritt 4.1: Inputs laden

Lese:
- `workshop/review/findings-{AUFGABE_NR}.json` — der Output des Reviewer-Subagenten
- `workshop/review/gold-standard-aufgabe{AUFGABE_NR}.json` — die Referenz-Findings

Falls `gold-standard-aufgabe{AUFGABE_NR}.json` nicht existiert, gib aus:
> "Kein Gold-Standard für Aufgabe {AUFGABE_NR} gefunden (workshop/review/gold-standard-aufgabe{AUFGABE_NR}.json)."
Und beende.

## Schritt 4.2: Bewertung

Bewerte für jedes Finding im Gold Standard, ob es im Teilnehmer-Output enthalten ist:

- **found**: Das Finding wurde klar erkannt — Kern-Problem und ungefähre Location stimmen überein
- **partial**: Das Finding wurde angedeutet, aber ungenau (z.B. falscher Ort, vages Problem, oder nur Symptom ohne Ursache)
- **missed**: Das Finding taucht im Output nicht auf

Nutze inhaltliches Verständnis, nicht nur String-Matching. Ein Finding gilt als "found" auch wenn die Formulierung anders ist, solange das eigentliche Problem erkannt wurde.

## Schritt 4.3: Score berechnen

- found = 1 Punkt
- partial = 0.5 Punkte
- missed = 0 Punkte

Maximaler Score = Anzahl der Gold-Standard-Findings

## Schritt 4.4: Ergebnis schreiben

Schreibe das Ergebnis nach `workshop/review/benchmark-result-{AUFGABE_NR}.json` (z.B. `benchmark-result-2.json`):

```json
{
  "score": 3.5,
  "max_score": 5,
  "tokens": {
    "tokens_used": 18432,
    "source": "subagent-self-report"
  },
  "details": [
    { "gold_id": "F1", "verdict": "found", "note": "Null check korrekt erkannt" },
    { "gold_id": "F2", "verdict": "found", "note": "Missing try/catch erkannt" },
    { "gold_id": "F3", "verdict": "partial", "note": "Pagination-Problem erwähnt aber Ursache unklar" },
    { "gold_id": "F4", "verdict": "missed", "note": "" },
    { "gold_id": "F5", "verdict": "missed", "note": "" }
  ]
}
```

## Schritt 4.5: Ergebnisse ausgeben

Gib **zuerst** das Review-Ergebnis des Teilnehmer-Skills aus (die Findings aus
`findings-{AUFGABE_NR}.json` — das ist, was der Teilnehmer-Skill selbst geliefert hat):

```
=== Review-Ergebnis Aufgabe {AUFGABE_NR} (Teilnehmer-Skill) ===
{Anzahl} Findings — Tokens: {tokens_used}

- F1 (high)   dateiname.ts:zeile — <kurzbeschreibung>
- F2 (medium) dateiname.ts:zeile — <kurzbeschreibung>
- ...
```

Gib **danach** den Benchmark-Block aus (die Bewertung gegen den Gold-Standard):

```
=== Benchmark Aufgabe {AUFGABE_NR} ===
Score: X / {MAX}
Tokens: {tokens_used}  (Subagent-Selbstauskunft)

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
