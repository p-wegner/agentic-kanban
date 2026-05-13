# Agentic Kanban

Un tableau kanban pour gérer les tâches de développement pilotées par l'IA. Réimplémentation from scratch de [vibe-kanban](https://github.com/BloopAI/vibe-kanban) — local-first, mono-utilisateur, Claude Code uniquement.

## Stack Technique

Monorepo TypeScript — Hono + Drizzle + React + MCP SDK

## Démarrage

```bash
pnpm install
pnpm db:setup        # migrer, peupler, enregistrer ce dépôt comme projet
pnpm dev             # démarrer serveur (3001) + client (5173)
```

Ouvrir http://localhost:5173

## CLI

```bash
pnpm cli -- register <chemin>   # enregistrer un dépôt git comme projet
pnpm cli -- list                # lister les projets enregistrés
pnpm cli -- unregister <nom>    # supprimer un projet
pnpm cli -- cleanup             # afficher les worktrees obsolètes
```

## Tests

```bash
pnpm test                # tests unitaires Vitest
pnpm test:e2e            # tests E2E Playwright
```

## Workflow Principal

Enregistrer un dépôt → Créer un ticket → Cliquer « Nouvel espace de travail » (branche + worktree + lancement agent) → Voir le diff → Fusionner

## Licence

Privé — usage personnel uniquement.
