# PRD-02: Original Architecture Analysis

Detailed technical analysis of the vibe-kanban codebase architecture.

## Overview

### Scale
- **34 Rust crates** in a Cargo workspace
- **4 frontend packages** in a pnpm workspace
- **2200+ files** total
- **Build system**: Cargo (Rust) + pnpm + Vite (frontend) + Docker

### Languages
- **Backend**: Rust 2024 edition
- **Frontend**: TypeScript 5.9 + React 18
- **Build scripts**: JavaScript/Node.js

## Backend Architecture (Rust)

### Core Crates
| Crate | Responsibility |
|-------|---------------|
| `server` | Main Axum HTTP server, routes, WebSocket |
| `db` | SQLite database models, SQLx queries, migrations |
| `api-types` | Shared types between local and remote backends |
| `services` | Business logic layer |
| `executors` | AI agent execution (10+ agents) |
| `mcp` | MCP server binary for Claude Code integration |
| `deployment` | Deployment abstractions |
| `local-deployment` | Local deployment logic |
| `git` | Git operations (worktree, branch, diff) |
| `worktree-manager` | Git worktree lifecycle |
| `workspace-manager` | Workspace CRUD and orchestration |
| `utils` | Shared utilities |
| `tauri-app` | Desktop app wrapper |

### Supporting Crates
| Crate | Responsibility |
|-------|---------------|
| `relay-client` | WebSocket relay client |
| `relay-control` | Relay control logic |
| `relay-protocol` | Protocol definitions |
| `relay-types` | Relay-specific types |
| `relay-ws` | WebSocket implementation |
| `relay-hosts` | Relay host management |
| `relay-tunnel-core` | Core tunnel functionality |
| `relay-webrtc` | WebRTC transport |
| `ws-bridge` | WebSocket bridge |
| `desktop-bridge` | Desktop app bridge |
| `embedded-ssh` | SSH functionality |
| `trusted-key-auth` | Authentication system |
| `preview-proxy` | Preview URL proxy |
| `git-host` | Git host integration (GitHub, etc.) |
| `review` | PR review functionality |
| `client-info` | Client information tracking |
| `remote-info` | Remote server info |
| `remote` | Cloud deployment (PostgreSQL + ElectricSQL) |

### Key Technologies
- **Web Framework**: Axum 0.8 with WebSocket support
- **Database**: SQLite (local) via SQLx, PostgreSQL (remote) via SQLx
- **Auth**: SPAKE2 key exchange, Ed25519 signatures, JWT (remote)
- **MCP**: rmcp 1.2.0 (Rust MCP implementation)
- **Agent Protocol**: agent-client-protocol 0.8
- **Serialization**: serde + ts-rs (Rust->TypeScript type generation)
- **Async**: Tokio runtime
- **Logging**: tracing + Sentry
- **TLS**: rustls with AWS-LC-RS

## Frontend Architecture (TypeScript/React)

### Packages
| Package | Role |
|---------|------|
| `local-web` | Main frontend app (local mode) |
| `remote-web` | Cloud frontend app |
| `web-core` | Shared components and logic |
| `ui` | Shared UI primitives |

### Key Libraries
- **React 18** + React Compiler
- **Vite 7** build tool
- **TanStack Router** for routing
- **TanStack Query** for server state
- **Zustand** for client state
- **Radix UI** for accessible components
- **Tailwind CSS** for styling
- **Lexical** for rich text editing
- **xterm.js** for terminal emulation
- **@hello-pangea/dnd** + @dnd-kit for drag-and-drop
- **react-use-websocket** for real-time updates
- **ElectricSQL** for reactive DB sync

### Routing Structure
```
/                           → Root/redirect
/onboarding                 → First-time setup
/onboarding/sign-in         → Authentication
/workspaces                 → List workspaces
/workspaces/create          → Create workspace
/workspaces/$id             → Workspace detail
/projects/$id               → Project kanban board
/projects/$id/issues/$id    → Issue detail
/notifications              → Notification center
/export                     → Data export
```

## MCP Server Architecture

### Binary: `vibe-kanban-mcp`
- Standalone Rust binary distributed via npm
- Uses `rmcp` for MCP protocol implementation
- stdio transport for communication
- Two modes: **Global** (full access) and **Orchestrator** (scoped)

### MCP Tools Provided
| Tool | Description |
|------|-------------|
| `create_issue` | Create issue in project |
| `list_issues` | List issues with filters |
| `get_issue` | Get issue details |
| `update_issue` | Update issue fields |
| `delete_issue` | Delete issue |
| `list_workspaces` | List local workspaces |
| `update_workspace` | Update workspace |
| `delete_workspace` | Delete workspace |
| `create_session` | Create coding session |
| `list_sessions` | List sessions |
| `stop_session` | Stop running session |
| `delete_session` | Delete session |
| `start_workspace` | Create + start workspace |
| `link_workspace_issue` | Link workspace to issue |
| `get_context` | Get project/issue/workspace metadata |
| `list_tags` | List project tags |
| `create_issue_tag` | Tag an issue |
| `list_repos` | List repos in workspace |
| `create_repo` | Add repo to workspace |

### Communication Flow
```
Claude Code ←→ MCP Server (stdio) ←→ REST API ←→ Axum Server ←→ SQLite
```

## Build & Deployment

### Local Development
```bash
pnpm install
pnpm run dev          # Start both backend and frontend
```

### Production
- Multi-stage Docker build
- NPX CLI: `npx vibe-kanban`
- Tauri desktop app for native install

## Architecture Patterns
1. **Workspace Isolation**: Each workspace = separate git worktree + Docker container
2. **Type-Safe RPC**: Rust types → TypeScript via ts-rs code generation
3. **Real-time Sync**: ElectricSQL for reactive queries, WebSocket for events
4. **Plugin Executors**: Modular agent system with JSON schema config
5. **Dual Backend**: Local (SQLite) and Remote (PostgreSQL) sharing api-types
