# Agentic Kanban

Ein KI-gesteuertes Kanban-Board zur Verwaltung von Coding-Aufgaben. Lokale, fokussierte Alternative zu [vibe-kanban](https://github.com/BloopAI/vibe-kanban) — entwickelt für Einzelnutzer mit Claude Code als Agent.

Jede Aufgabenkarte auf dem Board ist mit einem Git-Worktree und einer live Claude-Code-Session verknüpft. Der Kernablauf lautet: **planen → umsetzen (Claude Code) → prüfen (Diff) → ausliefern (Merge)**.

## Features

- **Kanban-Board** — Drag-and-Drop zwischen Spalten (Todo, In Progress, In Review, Done, Abgebrochen), einklappbare Archiv-Gruppe
- **Issue-Verwaltung** — erstellen, bearbeiten, löschen, suchen/filtern mit Trefferhervorhebung, Prioritäts-Badges, Tags, automatische Issue-Nummern
- **Workspace-Lebenszyklus** — Ein-Schritt-Erstellung: Branch + Git-Worktree + automatischer Start von Claude Code. Unterstützt direkte Workspaces (ohne Worktree) für schnelle Aufgaben
- **Live-Agenten-Ausgabe** — Echtzeit-Streaming via WebSocket, Chat-artiger Input mit Senden/Stopp, `--resume`-Unterstützung für Session-Kontinuität
- **Diff-Viewer** — Unified- und Split-Ansicht mit Inline-Kommentaren, Diff-Statistiken, Merge- und Schließen-Aktionen
- **MCP-Server** — 27 Tools für KI-Agent-Integration (Issues auflisten, Workspaces erstellen, Branches mergen usw.)
- **Echtzeit-Board-Updates** — WebSocket-Push + Polling-Fallback für Tab-übergreifende und MCP-gesteuerte Änderungen
- **Command Palette** — Ctrl+K Aktionssuche mit Tastatur-Navigation
- **Mehrere Projekte** — mehrere Git-Repos registrieren und zwischen ihnen wechseln
- **Session-Verlauf** — vergangene Agenten-Sessions pro Workspace durchsuchen, ohne den Kontext zu verlassen
- **Worktree-Übersicht** — alle Git-Worktrees über Workspaces hinweg mit Diff-Statistiken und Status-Badges
- **KI-Code-Review** — automatisch nach Agenten-Session (konfigurierbar) oder manuell auslösbar
- **Agent Skills** — Prompt-Templates, die dem Agenten bei Workspace-Erstellung als Kontext mitgegeben werden
- **Desktop-App** — Tauri v2 mit System-Tray, Minimize-to-Tray und OS-Benachrichtigungen

## Tech Stack

| Ebene | Technologie |
|-------|------------|
| Backend | Hono (Node.js), Drizzle ORM, SQLite |
| Frontend | React, TypeScript, Tailwind CSS, Vite |
| Agent | Claude Code als Subprocess |
| Integration | MCP SDK (stdio JSON-RPC) |
| Tests | Vitest (Unit), Playwright (E2E) |
| Monorepo | pnpm Workspaces |
| Desktop | Tauri v2 |

## Schnellstart

```powershell
pnpm install
pnpm db:setup        # migrieren + seed + dieses Repo als Projekt registrieren
pnpm dev             # Server (Port 3001) + Client (Port 5173) starten
```

`http://localhost:5173` öffnen — das Board lädt mit 3 aktiven Spalten für das registrierte Projekt.

### Zurücksetzen auf sauberen Zustand

Dev-Server zuerst stoppen, dann:

```powershell
pnpm db:reset              # DB löschen, neu migrieren, Tags neu einpflegen
pnpm cli -- register .     # Repo neu registrieren
pnpm dev
```

## CLI

```powershell
pnpm cli -- register <pfad>    # Git-Repo als Projekt registrieren
pnpm cli -- list               # registrierte Projekte auflisten
pnpm cli -- status             # Board-Übersicht (Agenten, Workspaces, Diffs)
pnpm cli -- issue list         # Issues auflisten
pnpm cli -- issue create <titel>  # Issue anlegen
pnpm cli -- workspace list     # Workspaces auflisten
pnpm cli -- unregister <name>  # Projekt nach Name oder ID entfernen
pnpm cli -- cleanup            # veraltete Worktrees für geschlossene Workspaces anzeigen
```

## Kern-Workflow

1. **Repo registrieren** — `pnpm cli -- register /pfad/zum/repo`
2. **Issue anlegen** — Aufgabe via Inline-Formular zum Board hinzufügen
3. **Workspace starten** — "New Workspace" auf einer Issue-Karte klicken (erstellt Branch + Worktree + startet Claude Code mit dem Issue als Prompt)
4. **Änderungen prüfen** — Diff im Workspace-Panel anzeigen, Inline-Kommentare hinzufügen
5. **Mergen** — Branch in den Default-Branch des Projekts mergen und Workspace schließen

## MCP-Server

Der MCP-Server stellt 27 Tools für die KI-Agent-Integration via stdio JSON-RPC bereit — darunter Issues verwalten, Workspaces steuern, Branches mergen, Skills laden und den Board-Status abrufen.

MCP-Server starten:

```powershell
pnpm --filter @agentic-kanban/mcp-server dev
```

Claude Code-Konfiguration (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "agentic-kanban": {
      "command": "node",
      "args": ["<pfad-zum-repo>/packages/mcp-server/dist/index.js"]
    }
  }
}
```

## Tests

```powershell
pnpm test            # Vitest Unit-Tests
pnpm test:e2e        # Playwright E2E-Tests
```

## Architektur

```
packages/
├── server/        # Hono API-Server, SQLite DB, Session-Manager, CLI
├── client/        # React-Frontend (Vite + Tailwind)
├── shared/        # Drizzle-Schemas, Migrationen, gemeinsame Typen
├── mcp-server/    # MCP-Server (stdio JSON-RPC, 27 Tools)
├── desktop/       # Tauri v2 Desktop-App
└── e2e/           # Playwright End-to-End-Tests
```

Wichtige Muster:
- **Server-seitige Aggregation** — Workspace-Summaries werden im Board-Endpunkt berechnet, nicht client-seitig
- **Board Events** — Dual-Pfad: WebSocket-Push für sofortige Updates + 30s Polling-Fallback
- **Ein-Schritt-Workspace-Erstellung** — ein POST erstellt DB-Eintrag, Git-Worktree und startet den Agenten
- **Session-Resume-Ketten** — Claude's interne Session-ID wird für `--resume` beim Neustart gespeichert

## Lizenz

MIT

---

[README.md](README.md) — English version
