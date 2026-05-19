---
name: learning-step
description: Pre-merge learning step — reads recent agent session transcripts from this worktree and improves docs and hooks for future sessions
---

# Learning Step — Pre-Merge Knowledge Extraction

You are running a pre-merge knowledge extraction step. Your job is to:

1. **Find relevant session transcripts** for this worktree:
   - Look in `~/.claude/projects/` for directories matching this worktree's path
   - Each `.jsonl` file is a session transcript

2. **Extract useful learnings** from the transcripts:
   - What problems did the agent encounter and how were they solved?
   - What patterns worked well?
   - What commands or workflows were effective?
   - Any surprising behaviors or edge cases discovered?

3. **Update project documentation** based on learnings:
   - If you found workflow improvements, add them to `.llm/workflows.md`
   - If you found architectural patterns, add them to `CLAUDE.md` under the appropriate section
   - If you found reusable commands or scripts, document them

4. **Improve agent hooks** if applicable:
   - Review `.claude/hooks/` for any improvements that would help future agents
   - Update hook logic if you found patterns that should be automated

5. **Commit your changes** with message: `docs: learning step — extract insights from session transcripts`

Keep changes focused and minimal. Only add genuinely useful, non-obvious information. Do not add noise.
