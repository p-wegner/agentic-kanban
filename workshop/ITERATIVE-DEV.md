# Aufgabe iterativ entwickeln und testen

Workflow um eine Aufgabe lokal zu verbessern und das Review-Ergebnis sofort zu sehen —
ohne den `origin`-Branch zu verändern.

## Setup (einmalig pro Aufgabe)

```bash
# Lokalen Dev-Branch von origin/aufgabe{N} anlegen
git branch aufgabe{N}-dev origin/aufgabe{N}

# Als Worktree auschecken (Claude Code macht das automatisch via EnterWorktree)
git worktree add .claude/worktrees/aufgabe{N}-dev aufgabe{N}-dev
```

Claude Code: `EnterWorktree` mit `name: aufgabe{N}-dev` und Basis `origin/aufgabe{N}` ODER
manuell wie oben und dann `EnterWorktree` mit `path: .claude/worktrees/aufgabe{N}-dev`.

## Iterationsloop

```
1. Dateien im Worktree bearbeiten (.claude/worktrees/aufgabe{N}-dev/...)
2. Änderungen committen (auf Branch aufgabe{N}-dev)
3. /review-aufgabe {N} aufgabe{N}-dev   ← lokaler Branch statt origin
4. Benchmark lesen → Findings anpassen oder Skill verbessern
5. → weiter bei 1
```

### Schritt 3 im Detail

```
/review-aufgabe 4 aufgabe4-dev
```

Der zweite Parameter übersteuert `origin/aufgabe4`. Alles andere läuft identisch:
- Temporärer Worktree wird angelegt und nach dem Review aufgeräumt
- `claude -p` bekommt den Teilnehmer-Skill als `--append-system-prompt`
- Benchmark läuft gegen `workshop/review/gold-standard-aufgabe{N}.json`

## Was gehört wohin

| Was | Wo | Branch |
|---|---|---|
| Aufgaben-Bugs (die eingebauten Fehler) | `packages/client/src/...` | `aufgabe{N}-dev` |
| Globale CSS-Overrides als versteckte Bugs | `packages/client/src/app.css` | `aufgabe{N}-dev` |
| Gold-Standard (Erwartete Findings) | `workshop/review/gold-standard-aufgabe{N}.json` | `vorbereitung-workshop` |
| Teilnehmer-Skill (Review-Prompt) | `workshop/review/skill.md` | `vorbereitung-workshop` |

Änderungen am Gold-Standard und am Skill immer im **Hauptcheckout** commiten,
Änderungen an den Aufgaben-Bugs immer im **Dev-Worktree** commiten.

## Finalisieren

Wenn die Aufgabe fertig ist, die Dev-Branch-Änderungen auf `origin/aufgabe{N}` pushen:

```bash
git push origin aufgabe{N}-dev:aufgabe{N}
```

Danach läuft `/review-aufgabe {N}` (ohne zweiten Parameter) wieder gegen die Origin.
