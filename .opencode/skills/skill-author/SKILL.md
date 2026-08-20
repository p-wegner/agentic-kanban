---
name: skill-author
description: Scaffold, validate, and install new OpenCode agent skills — handles directory creation, YAML frontmatter, naming rules, tool/permission wiring, and placement in the correct discovery paths. Use when asked to "create a skill", "write a skill", "scaffold a SKILL.md", "make a new agent skill", "add a skill to this repo", or any request to author reusable agent behavior.
metadata:
  audience: skill-authors
  workflow: skill-development
---

## What I do

I help you author new OpenCode agent skills end-to-end:

1. **Clarify** the skill's name, description, and scope with the user.
2. **Validate** the name against OpenCode's rules.
3. **Scaffold** a complete `SKILL.md` with correct frontmatter and body structure.
4. **Place** it in the right discovery path.
5. **Wire** permissions and tool access in `opencode.json` if needed.

---

## Naming rules (strict)

`name` in frontmatter **must** match the directory name and follow:

- 1–64 characters
- lowercase letters and digits only, separated by single hyphens
- must not start or end with `-`
- must not contain `--`
- Regex: `^[a-z0-9]+(-[a-z0-9]+)*$`

Reject names that fail this regex. Suggest the closest valid alternative.

---

## Description rules

- Required. 1–1024 characters.
- Write it so an LLM can decide whether to load this skill from its name + description alone.
- Start with a verb phrase or clear capability statement.
- Include trigger phrases ("Use when ...", "Triggers: ...").

---

## Frontmatter fields

Only these are recognized by OpenCode:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Must match directory name |
| `description` | yes | 1–1024 chars |
| `license` | no | e.g. `MIT` |
| `compatibility` | no | e.g. `opencode` |
| `metadata` | no | String-to-string map |

Unknown fields are ignored — do not add invented fields.

---

## Placement paths

Pick the right one based on scope:

| Scope | Path |
|---|---|
| Project (OpenCode) | `.opencode/skills/<name>/SKILL.md` |
| Project (Claude-compat) | `.claude/skills/<name>/SKILL.md` |
| Project (agents-compat) | `.agents/skills/<name>/SKILL.md` |
| Global (OpenCode) | `~/.config/opencode/skills/<name>/SKILL.md` |
| Global (Claude-compat) | `~/.claude/skills/<name>/SKILL.md` |
| Global (agents-compat) | `~/.agents/skills/<name>/SKILL.md` |

For project-scoped skills, prefer `.opencode/skills/` for OpenCode-native repos.
For cross-tool repos that also use Claude Code, duplicate into `.claude/skills/` as well.

---

## Body structure template

```markdown
---
name: <name>
description: <description>
---

## What I do
<Bullet list of capabilities — concrete, not aspirational>

## When to use me
<Trigger sentences so the agent knows when to load this skill>

## How I work
<Step-by-step workflow the agent follows after loading>

## Output format
<What the agent should return — file paths, structured output, user-facing text>

## Constraints
<Guardrails — what NOT to do, security rules, scope limits>
```

Omit empty sections. Every section you include must contain actionable guidance, not filler.

---

## Writing guidelines

1. **Write for an LLM, not a human.** The consumer is an agent reading this at runtime. Be unambiguous.
2. **Lead with triggers.** The description + "When to use me" section is what decides if this skill loads.
3. **Specify tool usage.** If the skill needs `bash`, `read`, `edit`, `webfetch`, etc., say so explicitly.
4. **Declare verification steps.** Every skill that modifies code should end with a lint/typecheck/test step.
5. **Keep it focused.** One skill = one capability. If it grows past ~200 lines, split it.
6. **Never hardcode secrets.** Reference env vars or credential files, never embed tokens.
7. **Use concrete examples.** A short input/output example is worth a paragraph of explanation.

---

## Permission wiring (optional)

To restrict a skill in `opencode.json`:

```json
{
  "permission": {
    "skill": {
      "<name>": "allow"
    }
  }
}
```

To disable the skill tool for a specific agent:

```json
{
  "agent": {
    "<agent-name>": {
      "tools": {
        "skill": false
      }
    }
  }
}
```

---

## Validation checklist (run before delivering)

- [ ] `name` matches directory name exactly
- [ ] `name` passes regex `^[a-z0-9]+(-[a-z0-9]+)*$`
- [ ] `description` is 1–1024 chars, starts with a clear capability statement
- [ ] Frontmatter contains only recognized fields
- [ ] File is named exactly `SKILL.md` (case-sensitive)
- [ ] Placed in a valid discovery path
- [ ] Body has no placeholder tokens (`<TODO>`, `FIXME`, `...`)
- [ ] Trigger phrases are specific enough for an LLM to match

---

## Example: minimal valid skill

```
.git-fresh/SKILL.md
```

```markdown
---
name: git-fresh
description: Stash uncommitted changes, pull latest, and reapply — fast context refresh before starting work.
---

## What I do
- Stash all uncommitted changes (including untracked)
- Pull latest from the current branch
- Reapply the stash, reporting any conflicts

## When to use me
Use this when the user says "git fresh", "refresh my branch", or "pull and reapply".

## How I work
1. `git stash push -u -m "auto-fresh"`
2. `git pull --rebase`
3. `git stash pop`
4. Report result — clean apply or list conflicts
```

---

## Anti-patterns

- **Vague description**: "Helps with git tasks" — too broad, will never be selected deliberately.
- **Missing triggers**: No "When to use me" section — the agent has no signal to load it.
- **Kitchen-sink scope**: A single skill covering git, Docker, and CI — split into focused skills.
- **Commenting out sections**: Useless to an LLM. Delete what you don't need.
- **Fabricated frontmatter fields**: `author`, `version`, `tags` are silently ignored. Don't add them.
