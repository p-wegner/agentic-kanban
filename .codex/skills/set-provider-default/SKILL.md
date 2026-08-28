---
name: set-provider-default
description: Set the board's default agent provider+profile (and optional model) in ONE place, atomically, across every consumer that can drift — the Strategy Bullseye, the Settings provider/claude_profile mirror, and the provider-scoped default_model_<provider> — then verify they agree. Use whenever the user says "set the provider default", "switch the board to claude/codex/copilot", "use profile X", "make anth the default", or after a provider stall where the sources drifted out of sync.
---

# set-provider-default

**Why this exists.** "Provider default" used to live in four independent places that silently drifted, causing a multi-cycle board stall (objective.md said `claude:anth`, the Bullseye said `codex`, and a stale global `default_model=gpt-5.5` codex id was passed to `claude.exe`, killing every launch). This skill makes the **Strategy Bullseye pref (`board_strategy_<projectId>`) the single source of truth** and locks the outliers to it — one command, nothing drifts.

> **The global `default_model` key was retired (#902).** It is no longer on the settings whitelist — model is now ONLY provider-scoped (`default_model_claude` / `default_model_codex` / `default_model_pi`), making a cross-provider model id structurally unrepresentable. This skill writes the SCOPED key for the chosen provider (copilot has none — it takes no model input).

> **Per-project provider is now a first-class UI control (#925).** For just *one* project's provider, a human can use Settings → Agent → **"Provider for this project"** — it writes the same single `fill` policy onto that project's Bullseye (`PROVIDER_DEFAULT_POLICY_ID`), never the global pref, so it can't trip the divergence guard and needs no reconciliation. **This skill is still the way to set the GLOBAL default** (the cross-cutting sinks below: the `provider`/`claude_profile` settings mirror used by butler/review/UI, and the provider-scoped `default_model_<provider>`), and the way to change a provider default programmatically/headlessly. When a human asks "switch *this* project's provider", point them at the UI control; when they ask to change the board-wide default or you must do it from a script, run this skill.

## The four sources and how they relate

| # | Source (key/file) | Consumer | SoT role |
|---|---|---|---|
| 1 | `board_strategy_<projectId>` (Bullseye pref) | `selectProviderFromStrategy` → **POST /api/workspaces default**, `resolveMonitorTunables` (deterministic monitor), and **auto-regenerates `objective.md`** via `writeStrategyObjective` | **AUTHORITATIVE** — set this |
| 2 | `provider` + `claude_profile` settings prefs | Butler, auto-review/manual-review sessions, Settings UI display | **mirror** — this skill keeps it == #1's fill policy |
| 3 | `default_model_<provider>` setting (provider-scoped; claude/codex/pi only) | model arg to that provider's binary (`resolveEffectiveModel`, #902) | **scope/clear** — the CHOSEN provider's slot is cleared unless a model valid for it is given; other providers' slots are left untouched |
| 4 | `objective.md` PROVIDER POLICY block (between `STRATEGY_BULLSEYE_GENERATED_*` markers) | the Conductor agent (prose) | **derived** — regenerated automatically when #1 is written; never hand-edit the generated block |

> The hand-authored `## FOCUS POLICY` block in `objective.md` lives OUTSIDE the markers and is NOT touched by a Bullseye write — only the generated block between the markers is regenerated. Edit FOCUS POLICY by hand; edit everything provider-related through this skill.

## Inputs
- **provider** (required): `claude` | `codex` | `copilot`
- **profile** (required for claude/codex): the profile name (e.g. `anth`, `ki14`). For copilot use `default`.
- **model** (optional): a model id VALID FOR THE CHOSEN PROVIDER. Omit to clear that provider's `default_model_<provider>` slot (recommended). Ignored for copilot (no scoped model key exists).

## Procedure

All writes go through `PUT /api/preferences/settings` via **curl (Bash)** — never `Invoke-RestMethod -Method Put` (the PS body round-trip silently no-ops; see CLAUDE.md). Run from the **main checkout** (where the server's DB lives). Only whitelisted keys (`SETTINGS_KEYS` — the typed `SETTINGS_REGISTRY`, see `packages/server/CLAUDE.md` "Adding settings keys") may appear in the patch; an unknown key makes the whole PUT return 422 with `droppedKeys`/`error` even when the other keys would otherwise apply.

### 1. Resolve the active project id
```bash
PID=$(curl -s http://127.0.0.1:3001/api/preferences/active-project | python -c "import sys,json;print(json.load(sys.stdin).get('projectId',''))")
echo "active project: $PID"
```
(Fall back to the project whose `repoPath` is the cwd via `GET /api/projects` if the active-project pref is unset.)

### 2. Build the new settings patch (Bullseye + mirror + model scope) and PUT it
Set the shell vars, then run. This reads the existing Bullseye JSON, replaces `providerPolicies` with a single `fill` policy for the chosen provider/profile, aligns each segment's `provider` hint, mirrors `provider`/`<x>_profile`, and scopes the CHOSEN provider's `default_model_<provider>` slot (claude/codex/pi only — copilot has none).

```bash
PROVIDER=claude     # claude | codex | copilot
PROFILE=anth        # profile name (ignored for copilot)
MODEL=""            # "" to clear; or a model id valid for $PROVIDER

curl -s http://127.0.0.1:3001/api/preferences/settings | PID="$PID" PROVIDER="$PROVIDER" PROFILE="$PROFILE" MODEL="$MODEL" python -c '
import sys, json, os
s = json.load(sys.stdin)
pid, provider, profile, model = os.environ["PID"], os.environ["PROVIDER"], os.environ["PROFILE"], os.environ["MODEL"]
key = f"board_strategy_{pid}"
cfg = json.loads(s.get(key) or "{}")

# 1. AUTHORITATIVE: single fill policy for the chosen provider/profile.
cfg["providerPolicies"] = [{
    "id": f"policy-{provider}-{profile or provider}",
    "provider": provider,
    "profileName": "" if provider == "copilot" else profile,
    "mode": "fill",
    "headroomPct": 0,
    "quotaProviderId": "",
    "notes": f"Primary harness - all new workspaces launch on {provider}:{profile}. Single source of truth (set-provider-default skill).",
}]
# Align per-segment provider hints (kept consistent so the generated weights block is not misleading).
for seg in cfg.get("segments", []):
    if seg.get("provider"):  # leave excluded/blank segments (e.g. Feature) blank
        seg["provider"] = provider

patch = {key: json.dumps(cfg)}                      # #1 Bullseye (regenerates objective.md)
patch["provider"] = provider                        # #2 mirror
if provider == "claude":   patch["claude_profile"]  = profile
elif provider == "codex":  patch["codex_profile"]   = profile
elif provider == "copilot":patch["copilot_profile"] = profile or "default"
# #3 scope/clear — provider-scoped model key only (#902); copilot has no model slot.
if provider in ("claude", "codex", "pi"):
    patch[f"default_model_{provider}"] = model

print(json.dumps(patch))
' > /tmp/provider-patch.json

curl -s -X PUT http://127.0.0.1:3001/api/preferences/settings \
  -H "Content-Type: application/json" --data @/tmp/provider-patch.json
echo ""   # expect {"ok":true}
```

> Writing the `board_strategy_*` key triggers `writeStrategyObjective` + (default-on) a commit of `objective.md`. That is intended — it keeps the generated block consistent and the tree clean. Confirm the tree is clean afterward (step 4); if `auto_commit_strategy_objective` is `false`, commit `objective.md` yourself.

### 3. (Conductor/dev-board only) confirm objective.md regenerated to agree
```bash
sed -n '/STRATEGY_BULLSEYE_GENERATED_START/,/STRATEGY_BULLSEYE_GENERATED_END/p' scripts/board-monitor/objective.md | grep -aiE "FILL|provider"
```
The generated PROVIDER POLICY should now name your provider/profile as FILL. (For non-Conductor projects `objective.md` is unused — skip.)

### 4. VERIFY all sources agree
```bash
curl -s http://127.0.0.1:3001/api/preferences/settings | PID="$PID" python -c '
import sys, json, os
s = json.load(sys.stdin); pid = os.environ["PID"]
cfg = json.loads(s.get(f"board_strategy_{pid}") or "{}")
fill = next((p for p in cfg.get("providerPolicies", []) if p.get("mode") == "fill"), None)
print("Bullseye fill   :", (fill or {}).get("provider"), (fill or {}).get("profileName"))
print("Settings provider:", s.get("provider"), "/ claude_profile:", s.get("claude_profile"), "/ codex_profile:", s.get("codex_profile"))
print("default_model_claude:", repr(s.get("default_model_claude")), "/ default_model_codex:", repr(s.get("default_model_codex")), "/ default_model_pi:", repr(s.get("default_model_pi")))
ok = fill and fill.get("provider") == s.get("provider")
print("CONSISTENT      :", "YES" if ok else "NO — investigate")
'
git status --short   # expect clean (objective.md auto-committed)
```

Report the verify block to the user. If `CONSISTENT: NO`, do not leave it — re-run step 2.

## Notes & guardrails
- **Already-launched workspaces** keep their baked-in provider — this only changes the DEFAULT for NEW launches. To switch a running builder, DELETE+recreate it (the Conductor does this next cycle; or use the board's workspace endpoints — never hand-edit).
- **Never** set a `default_model_<provider>` slot to a model id from a DIFFERENT provider (the original #696 stall) — the provider-scoped keys (#902) make this structurally impossible if you only ever write the chosen provider's own slot, which is what step 2 does. When in doubt, leave the model input empty.
- **Don't** flip `claude_profile` to `mock` here — that's the stand-down switch, handled separately.
- **Project-specific** skill — lives only in `.claude/skills/`; do NOT add to `builtin-skills.ts`.
- The code-level fix (collapse #2/#3 so they can't exist independently of #1) is tracked on the board; this skill is the single entry point until it lands.
