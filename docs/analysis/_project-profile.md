# Project Profile — agentic-kanban

**The portable interface between the safety-net skills/pipeline and *this* target**
(`C:\projects\andrena\agentic-kanban`). Every hardwired stack/location a skill or tool would otherwise assume is
declared here instead, so the same skills analyse any stack. The skills read the JSON block
below; the `.mjs` pipeline reads it via the plugin's `tools/lib/profile.mjs`.

**Convention:** the loader looks for `<docs_root>/_project-profile.md` (this file), falling
back to `<target-repo>/.safety-net.md`, then to built-in defaults (which reproduce the
plugin's own TS demo repo). The fenced ```json block is the machine-read source of truth; the
prose around it is for the agent. Explicit `COVERAGE_*` env (set by the board's plugin
scripts) still wins over any field here.

Fill in every `TODO:` marker for this target before running the pipeline. Examples in the
comments show a Kotlin/Gradle target; the full field reference lives in the plugin repo's own
`docs/analysis/_project-profile.md`.

```json
{
  "id": "agentic-kanban",
  "title": "agentic-kanban",

  "language": "TODO: ts|js|py|ruby|go|java|kotlin|other",

  "source_roots": ["TODO: e.g. src  — Kotlin/Gradle: src/main/kotlin"],
  "source_ext": ["TODO: e.g. ts — Kotlin: kt (extensions without the dot)"],

  "docs_root": "docs/analysis",

  "app_url": "TODO: base URL of a safe running instance, or remove if none",
  "reset_endpoint": null,

  "test": {
    "int": {
      "cmd": "TODO: integration-test command — Kotlin/Gradle on Windows: gradlew.bat test",
      "dir": "TODO: test root relative to repo — Kotlin: src/test/kotlin",
      "file_re": "TODO: test filename regex — Kotlin: .*Test\\.kt$",
      "annotation": "magic-comment",
      "runner": "TODO: e.g. JUnit 5 via Gradle"
    }
  },

  "annotation_channel": "magic-comment",

  "pipeline": {
    "modules": "board plugin script: modules",
    "coverage": "board plugin script: coverage",
    "coverage_check": "board plugin script: coverage-check"
  },

  "integrations": [],

  "capabilities": {
    "hasReset": false, "hasSeed": false, "hasAuth": false,
    "secondOracle": "prd", "safeEnv": true
  }
}
```

## Notes for non-JS stacks (e.g. Kotlin/Gradle)

- The deterministic modules engine parses **JS/TS** import graphs natively only. For
  `language: "kotlin"` (or java/py/go/ruby), set `source_ext` (e.g. `["kt"]`) so the file scan
  finds sources; module identification then falls back to the `module-identification` skill's
  agent-driven seam-finding over `source_roots` (package structure), or run the modules script
  with `--engine code-metrics` if that skill is available.
- `test.int.cmd` is the target's own runner invocation (`gradlew.bat test` on Windows,
  `./gradlew test` on POSIX), not an npm script. `annotation: "magic-comment"` means tests
  declare `// @covers <requirement-id>` comments — that convention is language-agnostic.
- Everything downstream (requirement-extraction, functional-coverage, the
  `module.verb.object` ID convention, the navigator) is language-agnostic once
  `source_roots`, `source_ext`, and `test.*` are correct.
