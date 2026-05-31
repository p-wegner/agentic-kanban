# living-specs

## Requirements

### Living Specs Are Project Truth

The project keeps persistent OpenSpec-style domain specs at `openspec/specs/<domain>/spec.md`.
These files are the source of truth for stable project behavior and architecture that should survive across Butler sessions and agent worktrees.

### Changes Use Scoped Deltas

Workspace changes describe spec updates as deltas under `openspec/changes/<change-id>/specs/<domain>/spec.md`.
Delta files use `## ADDED`, `## MODIFIED`, and `## REMOVED` sections.
Each delta should stay scoped to one domain whenever practical so parallel worktrees do not collide on the same living spec.

### Merge Applies Deltas

When a workspace branch merges, OpenSpec deltas introduced by that branch are applied to their living domain specs.
Applied delta folders are removed from `openspec/changes/` in the merge follow-up commit, leaving `openspec/specs/` as the current truth.

### Agents Read Specs Through MCP

Board agents and the Butler read living specs through MCP tools:
`openspec_list_specs` lists available domains, `show_spec` returns one domain spec, and `validate_change` checks pending deltas.
The Butler should answer project behavior questions from relevant living specs and cite the spec domain or path when it does.

### Same-Domain Work Warns

OpenSpec validation warns when multiple pending deltas touch the same domain.
This does not prevent all conflicts, but it makes the risk visible before merge in the same way migration-number collisions are handled as a coordination problem.
