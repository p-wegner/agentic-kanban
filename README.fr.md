# Agentic Kanban

Un tableau kanban pour gérer les tâches de développement pilotées par l'IA. Alternative locale et ciblée à [vibe-kanban](https://github.com/BloopAI/vibe-kanban) — conçu pour une utilisation mono-utilisateur avec Claude Code comme agent.

Chaque carte de tâche sur le tableau est soutenue par un worktree git et une session Claude Code en direct. Le cycle principal est : **planifier → exécuter (Claude Code) → réviser (diff) → livrer (fusion)**.

## Fonctionnalités

- **Tableau kanban** — glisser-déposer entre les colonnes (À faire, En cours, En révision, Terminé, Annulé), groupe d'archives repliable
- **Gestion des tickets** — créer, modifier, supprimer, rechercher/filtrer avec correspondances surlignées, badges de priorité, tags, numéros auto-incrémentés
- **Cycle de vie des espaces de travail** — création en une étape : branche + worktree git + lancement automatique de Claude Code. Support des espaces directs (sans worktree) pour les tâches rapides
- **Sortie agent en direct** — streaming en temps réel via WebSocket, saisie de type chat avec Envoyer/Stop, support `--resume` pour la continuité des sessions
- **Visualiseur de diff** — vues unifiée et côte à côte avec commentaires en ligne, statistiques de diff, actions de fusion et fermeture
- **Serveur MCP** — 10 outils pour l'intégration d'agents IA (lister les tickets, créer des espaces de travail, fusionner des branches, etc.)
- **Mises à jour du tableau en temps réel** — push WebSocket + polling de secours pour les changements inter-onglets et via MCP
- **Palette de commandes** — recherche d'actions Ctrl+K avec navigation au clavier
- **Multi-projet** — enregistrer plusieurs dépôts git et basculer entre eux
- **Historique des sessions** — parcourir les sessions passées par espace de travail sans quitter le contexte
- **Vue d'ensemble des worktrees** — voir tous les worktrees git avec statistiques de diff et badges de statut

## Stack Technique

| Couche | Technologie |
|--------|------------|
| Backend | Hono (Node.js), Drizzle ORM, SQLite |
| Frontend | React, TypeScript, Tailwind CSS, Vite |
| Agent | Claude Code via subprocess |
| Intégration | MCP SDK (stdio JSON-RPC) |
| Tests | Vitest (unitaires), Playwright (E2E) |
| Monorepo | pnpm workspaces |

## Démarrage

```bash
pnpm install
pnpm db:setup        # migrer + peupler + enregistrer ce dépôt comme projet
pnpm dev             # démarrer serveur (port 3001) + client (port 5173)
```

Ouvrir http://localhost:5173 — le tableau se charge avec 3 colonnes actives pour le projet enregistré.

### Réinitialiser l'état

Arrêter d'abord le serveur de développement, puis :

```bash
pnpm db:reset        # effacer la DB, re-migrer, re-peupler les tags
pnpm cli -- register .   # ré-enregistrer le dépôt
pnpm dev
```

## CLI

```bash
pnpm cli -- register <chemin>   # enregistrer un dépôt git comme projet
pnpm cli -- list                # lister les projets enregistrés
pnpm cli -- unregister <nom>    # supprimer un projet par nom ou ID
pnpm cli -- cleanup             # afficher les worktrees obsolètes
```

## Workflow Principal

1. **Enregistrer le dépôt** — `pnpm cli -- register /chemin/vers/le/depot`
2. **Créer un ticket** — ajouter une tâche au tableau via le formulaire intégré
3. **Démarrer un espace de travail** — cliquer « Nouvel espace de travail » sur une carte (crée la branche + worktree + lance Claude Code avec le ticket comme prompt)
4. **Réviser les changements** — voir le diff dans le panneau de l'espace de travail, ajouter des commentaires en ligne
5. **Fusionner** — fusionner la branche dans la branche par défaut du projet et fermer l'espace de travail

## Serveur MCP

Le serveur MCP expose 10 outils pour l'intégration d'agents IA via stdio JSON-RPC :

| Outil | Description |
|-------|-------------|
| `getContext` | Obtenir le contexte du projet et le nombre de tickets |
| `listIssues` | Lister les tickets avec filtre de statut optionnel |
| `getIssue` | Obtenir les détails d'un ticket |
| `createIssue` | Créer un nouveau ticket |
| `updateIssue` | Mettre à jour titre, description, statut ou priorité |
| `listWorkspaces` | Lister les espaces de travail avec filtre par ticket |
| `startWorkspace` | Créer un espace avec worktree git et lancer l'agent |
| `getWorkspaceDiff` | Obtenir le diff git d'un espace de travail |
| `mergeWorkspace` | Fusionner la branche et fermer l'espace |
| `closeWorkspace` | Fermer l'espace sans fusionner |

Lancer le serveur MCP :

```bash
pnpm --filter @agentic-kanban/mcp-server dev
```

## Tests

```bash
pnpm test                # tests unitaires Vitest
pnpm test:e2e            # tests E2E Playwright
```

## Architecture

```
packages/
├── server/        # Serveur API Hono, DB SQLite, gestionnaire de sessions, CLI
├── client/        # Frontend React (Vite + Tailwind)
├── shared/        # Schémas Drizzle, migrations, types partagés
├── mcp-server/    # Serveur MCP (stdio JSON-RPC, 10 outils)
└── e2e/           # Tests end-to-end Playwright
```

Patterns clés :
- **Agrégation côté serveur** — les résumés d'espaces de travail sont calculés dans le point d'accès du tableau, pas par jointures côté client
- **Événements du tableau** — double canal : push WebSocket pour les mises à jour instantanées + polling de secours toutes les 30s
- **Création d'espace en une étape** — un seul POST crée l'enregistrement DB, le worktree git, et lance l'agent
- **Chaînes de reprise de session** — l'ID de session interne de Claude est capturé pour `--resume` au relancement

## Licence

Privé — usage personnel uniquement.

---

[README.md](README.md) — English version
