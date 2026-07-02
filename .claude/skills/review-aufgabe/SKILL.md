---
name: review-aufgabe
description: Workshop Review + Benchmark für eine Aufgabe — Parameter: Aufgabennummer als Freitext (z.B. "/review-aufgabe 1"). Materialisiert den vom Teilnehmer-Skill deklarierten Kontext, führt das Review als eigenen Subagent aus (Fan-out für große Diffs möglich) und gibt sofort den Benchmark-Score inkl. Token-Verbrauch aus. Fragt nach der Nummer falls kein Parameter angegeben.
argument-hint: "[Aufgabennummer, z.B. 1]"
---

Du bist ein Workshop-Runner (das "Harness"), der Review und Benchmark in einem Durchlauf ausführt.

Wichtiges Prinzip: **Der Teilnehmer-Skill besitzt die Review-Strategie, das Harness stellt nur bereit.**
Das Harness materialisiert ausschließlich den Kontext, den der Teilnehmer-Skill *deklariert*, und
führt dessen Methodik treu aus. Es fetcht oder chunkt **nicht** von sich aus — ein naiver
Teilnehmer-Skill soll an Aufgaben scheitern, die mehr als den Diff brauchen.

## Parameter

Der erste übergebene Parameter ist die AUFGABE_NR (z.B. `1` bei `/review-aufgabe 1`).

Falls kein Parameter angegeben wurde, frage:
> "Für welche Aufgabe soll das Review durchgeführt werden? (z.B. 1)"

Warte auf die Antwort und verwende sie als AUFGABE_NR.

---

# TEIL 0: Vorbereitung & Token-Watermark

## Schritt 0.1: Branch prüfen

Die Aufgaben-Branches existieren nur als Remote-Branches. Prüfe:

```powershell
git rev-parse --verify --quiet origin/aufgabe{AUFGABE_NR}
```

Wenn der Befehl nichts zurückgibt (Branch fehlt), gib aus:
> "Branch origin/aufgabe{AUFGABE_NR} nicht gefunden. Verfügbar: $(git branch -r)"
Und beende.

## Schritt 0.2: Token-Watermark setzen

Merke dir den Startzeitpunkt des Reviews (UTC, ISO 8601):

```powershell
(Get-Date).ToUniversalTime().ToString("o")
```

Speichere den Wert als `t0`. Er grenzt später die Token-Messung ein.

---

# TEIL 1: Kontext materialisieren

## Schritt 1.1: Teilnehmer-Skill laden & Frontmatter parsen

Lese `workshop/review/skill.md`. Die Datei besteht aus:
- **Optionalem YAML-Frontmatter** (zwischen `---`-Zeilen) mit `inputs:` und/oder `strategy:`
- **Methodik-Body** (der Rest) — der eigentliche Reviewer-Prompt

Parse das Frontmatter defensiv:
- Kein/ungültiges Frontmatter → Default `inputs: { diff: full }` verwenden und in der Ausgabe vermerken ("Kein Frontmatter — nur Diff bereitgestellt").
- **Materialisiere ausschließlich die deklarierten Inputs.** Was nicht deklariert ist, wird nicht bereitgestellt.
- Den Gold-Standard **niemals** dem Reviewer zeigen.

Unterstützte `inputs`-Schlüssel (alle optional):

| Schlüssel | Werte | Bedeutung |
|---|---|---|
| `diff` | `full` \| `per-file` \| `none` | Default `full` |
| `issue` | `true` \| `false` | `true` → `workshop/review/issue-aufgabe{AUFGABE_NR}.md` einlesen |
| `files` | Liste von Globs | Quelldateien auf Branch-HEAD via `git show` |
| `git-log` | `true` \| `false` | Commit-Messages des Branches |
| `manifest` | `true` \| `false` | Datei-Manifest + Diff-Stat |

## Schritt 1.2: Inputs materialisieren

Führe je nach Deklaration aus:

- `diff: full` → `git diff origin/master...origin/aufgabe{AUFGABE_NR}`
- `diff: per-file` → Änderungsdateien ermitteln (`git diff --name-only origin/master...origin/aufgabe{AUFGABE_NR}`), dann pro Datei `git diff origin/master...origin/aufgabe{AUFGABE_NR} -- <datei>` — als getrennte Blöcke bereitstellen.
- `manifest: true` → `git diff --stat --name-status origin/master...origin/aufgabe{AUFGABE_NR}`
- `issue: true` → Inhalt von `workshop/review/issue-aufgabe{AUFGABE_NR}.md`. Fehlt die Datei, vermerke das ("Kein Issue-File für Aufgabe {AUFGABE_NR}") und fahre fort — nicht ersetzen.
- `files: [globs]` → je Treffer `git show origin/aufgabe{AUFGABE_NR}:<pfad>`
- `git-log: true` → `git log origin/master..origin/aufgabe{AUFGABE_NR} --oneline`

## Schritt 1.3: Kontext-Bundle zusammenstellen

Baue ein Bundle aus:
- **Header**: Branch-Ref (`origin/aufgabe{AUFGABE_NR}`), Diff-Größe (Zeilen/Dateien aus dem Manifest bzw. `git diff --stat`), Hinweis auf das Token-Budget aus CONCEPT.md (z.B. "Ein Review für PR-2 sollte unter 10.000 Output-Tokens fertig sein").
- Die materialisierten Inputs aus Schritt 1.2.
- Den Methodik-Body aus Schritt 1.1.

---

# TEIL 2: Review als Subagent

## Schritt 2.1: Reviewer-Subagent starten

Starte **einen** Subagenten (Agent-Tool, `subagent_type: "general-purpose"`) mit vollem Tool-Zugriff.
Führe das Review NICHT inline in dieser Session aus — die Isolation hält den (ggf. großen) Diff aus
dem Trainer-Kontext und macht die Token-Messung sauber.

Der Prompt an den Subagenten enthält, in dieser Reihenfolge:
1. Den **Methodik-Body** des Teilnehmer-Skills (Schritt 1.1) — das ist die Anleitung, der der Subagent folgt.
2. Das **Kontext-Bundle** (Schritt 1.3).
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

## Schritt 2.2: Findings übernehmen

Nachdem der Subagent zurückkehrt, lese `workshop/review/findings-{AUFGABE_NR}.json`.
Falls die Datei fehlt oder kein valides JSON enthält, vermerke das und behandle die Findings als leer.

## Schritt 2.3: Review-Summary ausgeben

Gib aus:
- Wie viele Findings gefunden wurden
- Eine kurze Liste der Findings mit Severity und Location

---

# TEIL 3: Token-Abrechnung (über alle Transcripts)

## Schritt 3.1: Endzeit setzen & Transcripts scannen

Setze `t1 = (Get-Date).ToUniversalTime().ToString("o")`. Summiere dann die Tokens aller
Assistant-Nachrichten (Trainer-Session **und** Reviewer-Subagent(en)), deren Zeitstempel in
`[t0, t1]` liegt. So werden auch verschachtelte Subagenten erfasst — egal ob Claude Code sie in
eigene `*.jsonl`-Dateien oder als Sidechain in die Eltern-Datei schreibt.

```powershell
$t0 = [datetime]"<t0>"; $t1 = [datetime]"<t1>"
$slug = ($PWD.Path -replace '[:\\/]','-')
$dir  = Join-Path $env:USERPROFILE ".claude\projects\$slug"
$out = 0; $ctx = 0
Get-ChildItem $dir -Filter *.jsonl | ForEach-Object {
  $lastCtx = 0
  Get-Content $_.FullName | ForEach-Object {
    try { $m = $_ | ConvertFrom-Json } catch { return }
    if ($m.type -ne 'assistant' -or -not $m.message.usage -or -not $m.timestamp) { return }
    $ts = [datetime]$m.timestamp
    if ($ts -ge $t0 -and $ts -le $t1) {
      $u = $m.message.usage
      $out += [int]$u.output_tokens
      $lastCtx = [int]$u.input_tokens + [int]$u.cache_creation_input_tokens + [int]$u.cache_read_input_tokens
    }
  }
  $ctx += $lastCtx
}
"output_tokens=$out context=$ctx tokens_used=$($out + $ctx)"
```

- `output_tokens` — vom Modell im Review-Fenster generierte Tokens (inkl. Subagenten)
- `context` — Summe des letzten In-Window-Kontexts je Transcript (Review-Input)
- `tokens_used = output_tokens + context` — geschätzter Gesamt-Token-Verbrauch des Reviews

Hinweis: Näherung — die allerletzte Antwort eines Subagenten ist beim Auslesen evtl. noch nicht ins
Transcript geschrieben (Flush-Race). Der Wert kann leicht zu niedrig sein.

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
    "output_tokens": 15230,
    "context": 3202
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

## Schritt 4.5: Ergebnis ausgeben

Gib eine klare Zusammenfassung aus:

```
=== Benchmark Aufgabe {AUFGABE_NR} ===
Score: X / {MAX}
Tokens: {tokens_used}  (Output {output_tokens} / Kontext {context})

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
