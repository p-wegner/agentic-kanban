# nodeterm — Competitor Profile

**Repository**: [github.com/eneskirca/nodeterm](https://github.com/eneskirca/nodeterm)
**License**: **BUSL-1.1** (Business Source License — source-available, *not* open source)
**Last analyzed**: 2026-09-01
**Evidence level**: public README, docs site and release metadata only — **not read at
code level**. Treat feature claims below as the project's, not verified.

## What It Is

A node-based terminal manager: real terminals and agent sessions live as draggable
nodes on an infinite pan/zoom canvas. Every project **also has a Trello-style kanban
board of live Claude Code sessions** (`⌘⇧B`), so the same sessions are visible either
spatially or as cards.

**This is the closest competitor of the three**, and closer than its one-line
description suggests. It has a board, worktrees, agent-status tracking, GitHub Issues
sync and a review surface — the overlap with Agentic Kanban is substantial, on top of
a canvas we do not have.

## Architecture

| Aspect | Detail |
|--------|--------|
| Platform | Electron desktop (macOS arm64 + x64, Linux x64), **Server Edition** in any browser, **iOS companion app** |
| Language | TypeScript |
| Terminals | xterm.js over **tmux** — the macOS app ships its own tmux |
| Persistence | tmux sessions survive node remount, app restart and machine reboot (`claude --resume`) |
| Licence | BUSL-1.1 — source-available with a delayed open-source date |
| Age / traction | Created 2026-06-15; ~1.4k stars; ~1.2k installer downloads (hand-counted in the README) |

## Core Features

### Board
- Kanban board of **live session cards**, drag between columns, card modal opens the
  live Claude Code session inside the card
- **GitHub Issues on the board** — opt-in issue cards, exact label-to-column mapping,
  All / GitHub / Sessions filtering, and **two-way move, close and reopen sync**
- Assign teammates

### Canvas (no equivalent in Agentic Kanban)
- Node kinds: terminal, agent, sticky note, group, Monaco editor, diff, web/video
- **Group nodes bind to a git worktree** — agent-per-branch, spatially arranged
- Sticky notes link into an agent node as context; **context links** let agent nodes
  read each other's transcripts on demand
- Agents can drive the canvas themselves (open nodes, spawn teams, verify each other's
  work) through a built-in canvas-control CLI

### Agent status — the part worth attention
- **Hook-driven status, explicitly "no output scraping"**: RUNNING / NEEDS YOU badges,
  subagent cards with live transcripts, a per-node **context meter**, OS notifications
- Permission prompts answered inline in the node; "turn done" notification
- Multi-agent: Claude Code, Codex, Gemini, GitHub Copilot, opencode, Grok, custom
- Claude-only: **branch a conversation**, and **managed accounts** for several
  logged-in Claude identities side by side

### Reach
- **Phone pairing by QR** — the same live session continues on iOS, E2E encrypted over
  a relay (not just LAN), with push notifications and a mobile board
- **Server Edition** — the same canvas headless on Linux/macOS, single-user auth,
  WebSocket bridge, same renderer; board and agent badges work in the browser
- **Headless notification host** — install on any SSH box, phone gets RUNNING/NEEDS YOU
  push with zero open ports
- Remote/SSH projects: terminals, files, git and the board run on the remote host
- Local Whisper dictation (on-device, nothing auto-submits)
- Source control panel (stage/unstage, discard, branch, commit, push, worktrees, `gh`)
- Command palette (⌘K), file explorer, markdown view, undo/redo, auto-update
- Keeps the machine awake while an agent works

## Strengths

1. **Spatial model** — a map of what is running where, instead of hidden tabs; the
   sessions-as-nodes idea is genuinely different from every board competitor
2. **Hook-driven agent status** — the same architectural choice we made (parse, don't
   scrape), shipped with a context meter and subagent cards
3. **Mobile + remote reach** — phone attach to live sessions, push from any SSH host,
   full browser edition. No other competitor has this.
4. **Two-way GitHub Issues sync** with label-to-column mapping
5. **tmux-backed continuity across machine reboots**, with tmux bundled

## Weaknesses

1. **BUSL-1.1** — source-available, not open source; nothing can be copied from it
2. **No Windows build** (macOS + Linux only) — we run on Windows
3. **No visible testing story** — no E2E suite or mock-agent harness advertised
4. **No CLI** — the board is GUI-only
5. **Electron**, and a broad surface (canvas + board + editor + iOS + server) for a
   single maintainer
6. Not read at code level, so every claim here is the project's own

## What To Steal

| Idea | Why | Effort |
|---|---|---|
| **Per-session context meter on the card** | We parse the stream already; remaining context is the number that predicts a card stalling, and no other competitor surfaces it | Low |
| **"NEEDS YOU" as a first-class card state** with OS notification | We show status; a distinct *blocked-on-human* state is what makes a board glanceable across many cards | Low |
| **GitHub Issues ↔ column two-way sync with explicit label mapping** | Previously filed as "Linear/GitHub integration — Won't do" for personal use; the label-mapping design makes the cheap half of it worth reconsidering | Medium |
| **Sticky notes / context links as an input to an agent card** | A place to put context that is not the prompt and not the repo | Medium |

## Verdict

**Watch** — and re-read at code level if the board or hook-status design is ever
copied. BUSL-1.1 means the code is off-limits as a source of implementation, so the
value here is design ideas and a warning: it is ahead of us on notification reach and
on making a stalled agent visible.

> **Correction on the earlier triage.** This was first filed in the trending ledger as
> "a session manager for parallel agents — workspace UI, not a knowledge system" and
> dropped. That undersold it: it has a board, worktree binding, issue sync and
> hook-driven agent status. The ledger record has been re-bucketed accordingly.
