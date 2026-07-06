---
name: review-aufgabe
description: Workshop Review + Benchmark für eine Aufgabe — Parameter: Aufgabennummer (z.B. "/review-aufgabe 1"). Checkt aufgabeN als isolierten Worktree aus, startet eine neue claude -p Session mit dem Teilnehmer-Skill als --append-system-prompt, parst JSON-Findings aus stdout und benchmarkt gegen den Gold-Standard. Fragt nach der Nummer falls kein Parameter angegeben.
argument-hint: "[Aufgabennummer, z.B. 1]"
---

Du bist ein Workshop-Runner (das "Harness"), der Review und Benchmark in einem Durchlauf ausführt.

Wichtiges Prinzip: **Der Teilnehmer-Skill besitzt die Review-Strategie, das Harness verankert nur die Aufgabe.**
Der Teilnehmer-Skill aus `workshop/review/skill.md` wird per `--append-system-prompt` an `claude -p`
übergeben; `claude -p` startet im aufgabeN-Worktree als eigenständige Session.

**Ausgabe-Regel:** Arbeite still ab — keine Schritt-für-Schritt-Erklärungen, keine Tool-Kommentare.
Gib **genau zwei Blöcke** aus (nichts sonst), und zwar an **zwei getrennten Zeitpunkten**:
1. Das **Review-Ergebnis des Teilnehmer-Skills** (die Findings) direkt nach TEIL 3 — also **bevor**
   TEIL 4 den Gold-Standard überhaupt liest (Format in TEIL 3.3).
2. Den **Benchmark-Block** (die Bewertung) am Ende nach TEIL 4 (Format in TEIL 4.5).

Diese Reihenfolge ist verbindlich: Der Review-Block muss ausgegeben sein, **bevor** die erste
`Read`-Operation auf eine `gold-standard-*`-Datei stattfindet. So belegt die Reihenfolge der
geloggten Tool-Aufrufe, dass der Reviewer die Bewertungsgrundlage nicht angefasst hat.
Einzige weitere Ausgaben: Abbruchmeldungen (fehlender Branch in TEIL 0, fehlender Gold-Standard in TEIL 4.1).

## Parameter

Der erste übergebene Parameter ist die AUFGABE_NR (z.B. `1` bei `/review-aufgabe 1`).

Falls kein Parameter angegeben wurde, frage:
> "Für welche Aufgabe soll das Review durchgeführt werden? (z.B. 1)"

Warte auf die Antwort und verwende sie als AUFGABE_NR.

---

# TEIL 0: Vorbereitung

## Schritt 0.1: Branch prüfen

Die Aufgaben-Branches existieren nur als Remote-Branches. Prüfe:

```bash
git rev-parse --verify --quiet origin/aufgabe{AUFGABE_NR}
```

Wenn der Befehl nichts zurückgibt (Branch fehlt), gib aus:
> "Branch origin/aufgabe{AUFGABE_NR} nicht gefunden. Verfügbar: $(git branch -r)"
Und beende.

---

# TEIL 1: Isolierten Worktree einrichten

## Schritt 1.1: Skill-Datei prüfen

Prüfe, dass `workshop/review/skill.md` existiert und nicht leer ist.
Der Skill wird in TEIL 2 direkt per `--append-system-prompt` übergeben — kein separates Laden nötig.

## Schritt 1.2: Worktree-Pfad bestimmen

```bash
echo "$(git rev-parse --show-toplevel)/../workshop-review-aufgabe{AUFGABE_NR}"
```

Merke dir den ausgegebenen absoluten Pfad als **WORKTREE_PATH**.

Falls der Pfad bereits existiert (fehlgeschlagener Vorläufer), erst aufräumen:

```bash
git worktree remove "$WORKTREE_PATH" --force 2>/dev/null || true
```

## Schritt 1.3: Worktree anlegen

```bash
git worktree add "$WORKTREE_PATH" origin/aufgabe{AUFGABE_NR}
```

---

# TEIL 2: Review via claude -p

## Schritt 2.1: claude -p starten

Führe folgenden Bash-Befehl in **einem einzigen Aufruf** aus (**Timeout: mind. 5 Minuten**).
Er liest den Skill, bereinigt HTML-Kommentarblöcke, übergibt ihn per `--append-system-prompt`
und wechselt in den Worktree:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_PATH="${REPO_ROOT}/../workshop-review-aufgabe{AUFGABE_NR}"
SKILL_BODY=$(sed '/<!--/,/-->/d' "${REPO_ROOT}/workshop/review/skill.md" | sed '/^[[:space:]]*$/{ /./!d }')
cd "$WORKTREE_PATH" && claude -p \
  --append-system-prompt "$SKILL_BODY" \
  --output-format text \
  --permission-mode bypassPermissions << 'HARNESS_PROMPT'
Aufgabe: {AUFGABE_NR}
Du bist in einem Worktree, in dem der Branch aufgabe{AUFGABE_NR} ausgecheckt ist (basiert auf master).

Folge deiner Review-Methodik (system prompt) und reviewe die Änderungen in diesem Branch.

Diff ziehen:
  git diff origin/master                      -- alle Änderungen zusammen
  git diff origin/master -- <dateiname>       -- pro Datei (bei großen Diffs)

Integritäts-Guard: Lies KEINE Referenzdateien in workshop/review/ (gold-standard-*, benchmark-*).

Gib deine Findings als genau einen JSON-Block aus, nichts davor oder danach:

{"findings": [{"id": "F1", "severity": "high|medium|low", "description": "...", "location": "datei.ts:zeile"}]}
HARNESS_PROMPT
```

Erfasse den gesamten Stdout als **CLAUDE_OUTPUT**. Exit-Code merken.

---

# TEIL 3: Cleanup & Findings extrahieren

## Schritt 3.1: Worktree aufräumen

Unabhängig vom Exit-Code in TEIL 2:

```bash
git worktree remove "$WORKTREE_PATH" --force
```

Bei Fehler: Hinweis ausgeben und weitermachen:
> "Worktree $WORKTREE_PATH konnte nicht automatisch aufgeräumt werden. Manuell: git worktree remove $WORKTREE_PATH --force"

## Schritt 3.2: JSON aus CLAUDE_OUTPUT extrahieren

Suche in CLAUDE_OUTPUT nach dem JSON-Block:
- Mit Codeblock-Wrapper: extrahiere den Inhalt zwischen dem ersten ` ```json ` (oder ` ``` `) und
  dem schließenden ` ``` `
- Ohne Wrapper: nimm alles vom ersten `{` bis zum letzten `}`

Parse das JSON und extrahiere das `findings`-Array als **FINDINGS**.

Falls CLAUDE_OUTPUT kein valides JSON enthält oder Exit-Code ≠ 0 war: setze FINDINGS = [] und
vermerke: "claude -p hat kein valides JSON geliefert — prüfe workshop/review/skill.md".

Token-Hinweis: `--output-format text` liefert keine nativen Token-Counts. Setze tokens_used = null.

## Schritt 3.3: Review-Ergebnis ausgeben (VOR dem Gold-Standard-Zugriff — Integritäts-Ankerpunkt)

Gib **jetzt** — bevor TEIL 4 irgendeine `gold-standard-*`-Datei liest — das Review-Ergebnis aus:

```
=== Review-Ergebnis Aufgabe {AUFGABE_NR} (Teilnehmer-Skill) ===
{Anzahl} Findings — Tokens: n/a

- F1 (high)   dateiname.ts:zeile — <kurzbeschreibung>
- F2 (medium) dateiname.ts:zeile — <kurzbeschreibung>
- ...
```

Erst nach dieser Ausgabe mit TEIL 4 fortfahren.

---

# TEIL 4: Benchmark

## Schritt 4.1: Gold-Standard laden

Lese: `workshop/review/gold-standard-aufgabe{AUFGABE_NR}.json`

(Die Findings kommen aus Schritt 3.2, nicht aus einer Datei.)

Falls die Datei nicht existiert, gib aus:
> "Kein Gold-Standard für Aufgabe {AUFGABE_NR} gefunden (workshop/review/gold-standard-aufgabe{AUFGABE_NR}.json)."
Und beende.

## Schritt 4.2: Bewertung

Bewerte für jedes Finding im Gold Standard, ob es in FINDINGS enthalten ist:

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

Schreibe das Ergebnis nach `workshop/review/benchmark-result-{AUFGABE_NR}.json`:

```json
{
  "score": 3.5,
  "max_score": 5,
  "tokens": {
    "tokens_used": null,
    "source": "unavailable (claude -p --output-format text)"
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

## Schritt 4.5: Benchmark-Block ausgeben

```
=== Benchmark Aufgabe {AUFGABE_NR} ===
Score: X / {MAX}
Tokens: n/a

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
