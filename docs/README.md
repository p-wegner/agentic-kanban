# Agentic Kanban - Project Documentation

## Purpose
Cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban), tailored for personal use with a focus on testability and AI-driven development workflows.

## Documentation Structure

```
docs/
├── README.md              # This file - documentation index
├── diary.md               # Project diary (actions, decisions, workflow)
├── prd/
│   ├── 00-executive-summary.md    # High-level vision and scope
│   ├── 01-features-catalog.md     # Complete feature inventory from original
│   ├── 02-architecture-analysis.md # Original architecture deep-dive
│   ├── 03-data-model.md          # Core data entities and relationships
│   ├── 04-agent-integration.md   # MCP/Agent integration architecture
│   ├── 05-mvp-scope.md           # MVP definition and staging plan
│   └── 06-testability-strategy.md # E2E and testing approach
└── decisions/
    └── 001-initial-scope.md       # Key decisions log
```

## Key Principles
1. **Testability First** - E2E tests from day one, enabling AI-driven feedback loops
2. **Claude Code Only** - First iteration supports only Claude Code (via Agent SDK)
3. **Progressive Disclosure** - PRD starts high-level, drills into technical details per doc
4. **Diary-Driven** - All actions logged for potential talk/presentation
