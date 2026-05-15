# Agentic Kanban

Ein Kanban-Board zur Verwaltung KI-gesteuerter Programmieraufgaben. Entwickelt als fokussierte, lokale Alternative zu [vibe-kanban](https://github.com/BloopAI/vibe-kanban) — konzipiert für Einzelnutzer-Workflows mit Claude Code als Agent.

Jede Aufgabenkarte auf dem Board basiert auf einem Git-Worktree und einer laufenden Claude-Code-Sitzung. Der Kernkreislauf lautet: **planen → ausführen (Claude Code) → prüfen (Diff) → liefern (Merge)**.

## Funktionen

- **Kanban-Board** — Drag-and-Drop zwischen Spalten (Todo, In Progress, In Review, Done, Cancelled), einklappbare Archivgruppe
- **Issue-Verwaltung** — Erstellen, Bearbeiten, Löschen, Suchen/Filtern mit hervorgehobenen Treffern, Prioritäts-Badges, Tags, automatisch aufsteigende Issue-Nummern
- **Workspace-Lebenszyklus** — Ein-Schritt-Erstellung: Branch + Git-Worktree + automatischer Start von Claude Code. Unterstützt direkte Workspaces (ohne Worktree) für schnelle Aufgaben
- **Live-Agent-Ausgabe** — Echtzeit-Streaming per WebSocket, Chat-ähnliche Eingabe mit Senden/Stoppen, `--resume`-Unterstützung für Sitzungskontinuität
- **Diff-Anzeige** — Unified- und Split-Ansicht mit Inline-Kommentaren, Diff-Statistiken, Merge- und Schließen-Aktionen
- **MCP-Server** — 10 Tools für KI-Agenten-Integration (Issues auflisten, Workspaces erstellen, Branches mergen usw.)
- **Echtzeit-Board-Updates** — WebSocket-Push + Polling-Fallback für tab-übergreifende und MCP-gesteuerte Änderungen
- **Kommandopalette** — Ctrl+K Aktionsuche mit Tastaturnavigation
- **Mehrere Projekte** — Mehrere Git-Repos registrieren und zwischen ihnen wechseln
- **Sitzungsverlauf** — Vergangene Agent-Sitzungen pro Workspace durchsuchen, ohne den Kontext zu verlassen
- **Worktree-Übersicht** — Alle Git-Worktrees über Workspaces hinweg einsehen mit Diff-Statistiken und Status-Badges

## Technologie-Stack

| Schicht | Technologie |
|---------|------------|
| Backend | Hono (Node.js), Drizzle ORM, SQLite |
| Frontend | React, TypeScript, Tailwind CSS, Vite |
| Agent | Claude Code per Subprozess |
| Integration | MCP SDK (stdio JSON-RPC) |
| Tests | Vitest (Unit), Playwright (E2E) |
| Monorepo | pnpm Workspaces |

## Erste Schritte

```bash
pnpm install
pnpm db:setup        # Migrationen + Seeding + dieses Repo als Projekt registrieren
pnpm dev             # Server (Port 3001) + Client (Port 5173) starten
```

http://localhost:5173 öffnen — das Board lädt mit 3 aktiven Spalten für das registrierte Projekt.

Ausführliche Installationsanleitung inklusive Voraussetzungen siehe [INSTALL.md](INSTALL.md).

### Zurücksetzen in den Ursprungszustand

Zuerst den Dev-Server stoppen, dann:

```bash
pnpm db:reset        # Datenbank löschen, Migrationen neu ausführen, Tags neu befüllen
pnpm cli -- register .   # Repo neu registrieren
pnpm dev
```

## CLI

```bash
pnpm cli -- register <pfad>    # Ein Git-Repo als Projekt registrieren
pnpm cli -- list               # Registrierte Projekte auflisten
pnpm cli -- unregister <name>  # Projekt nach Name oder ID entfernen
pnpm cli -- cleanup            # Verwaiste Worktrees für geschlossene Workspaces anzeigen
```

## Kern-Workflow

1. **Repo registrieren** — `pnpm cli -- register /pfad/zum/repo`
2. **Issue erstellen** — Aufgabe über das Inline-Formular zum Board hinzufügen
3. **Workspace starten** — „New Workspace" auf einer Issue-Karte klicken (erstellt Branch + Worktree + startet Claude Code mit dem Issue als Prompt)
4. **Änderungen prüfen** — Diff im Workspace-Panel anzeigen, Inline-Kommentare hinzufügen
5. **Mergen** — Branch in den Standard-Branch des Projekts mergen und Workspace schließen

## MCP-Server

Der MCP-Server stellt 10 Tools für die KI-Agenten-Integration per stdio JSON-RPC bereit:

| Tool | Beschreibung |
|------|-------------|
| `getContext` | Aktuellen Projektkontext und Issue-Anzahlen abrufen |
| `listIssues` | Issues mit optionalem Status-Filter auflisten |
| `getIssue` | Detaillierte Issue-Informationen abrufen |
| `createIssue` | Neues Issue erstellen |
| `updateIssue` | Issue-Titel, -Beschreibung, -Status oder -Priorität aktualisieren |
| `listWorkspaces` | Workspaces mit optionalem Issue-Filter auflisten |
| `startWorkspace` | Workspace mit Git-Worktree erstellen und Agent starten |
| `getWorkspaceDiff` | Git-Diff für einen Workspace abrufen |
| `mergeWorkspace` | Workspace-Branch mergen und schließen |
| `closeWorkspace` | Workspace ohne Mergen schließen |

MCP-Server starten:

```bash
pnpm --filter @agentic-kanban/mcp-server dev
```

## Tests

```bash
pnpm test                # Vitest Unit-Tests
pnpm test:e2e            # Playwright E2E-Tests
```

## Architektur

```
packages/
├── server/        # Hono-API-Server, SQLite-Datenbank, Session-Manager, CLI
├── client/        # React-Frontend (Vite + Tailwind)
├── shared/        # Drizzle-Schemas, Migrationen, geteilte Typen
├── mcp-server/    # MCP-Server (stdio JSON-RPC, 10 Tools)
└── e2e/           # Playwright End-to-End-Tests
```

Zentrale Muster:
- **Serverseitige Aggregation** — Workspace-Zusammenfassungen werden im Board-Endpunkt berechnet, nicht clientseitig
- **Board-Events** — Zweiwege-System: WebSocket-Push für sofortige Updates + 30s Polling-Fallback
- **Ein-Schritt-Workspace-Erstellung** — Ein einzelner POST-Aufruf erstellt DB-Eintrag, Git-Worktree und startet den Agent
- **Sitzungs-Resume-Ketten** — Claudes interne Sitzungs-ID wird erfasst für `--resume` beim Neustart

## Lizenz

Privat — nur zur persönlichen Nutzung.

---

[README.md](README.md) — English version
[README.fr.md](README.fr.md) — Version française
[README.it.md](README.it.md) — Versione italiana
