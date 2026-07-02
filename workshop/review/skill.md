<!--
So erweiterst du dieses Review-Skill (optional):
Setze GANZ OBEN in dieser Datei ein YAML-Frontmatter zwischen zwei Zeilen aus je drei
Bindestrichen. Damit deklarierst du, welchen Kontext dein Review über den Diff hinaus braucht.
Das Harness stellt NUR bereit, was du hier deklarierst — es fetcht/chunkt nichts von selbst.

Unterstützte Schlüssel:
  inputs.diff:     full | per-file | none        (Default: full)
  inputs.issue:    true  -> liest workshop/review/issue-aufgabe{N}.md (Acceptance Criteria)
  inputs.files:    Liste von Globs, z.B. ["packages/server/src/**"]  (Quelldateien am Branch-HEAD)
  inputs.git-log:  true | false                  (Commit-Messages des Branches)
  inputs.manifest: true | false                  (Datei-Manifest + Diff-Stat)
  strategy:        Freitext-Hinweis an den Reviewer (z.B. Chunking-Strategie bei großen Diffs)

Beispiel-Frontmatter (Ticket-Aufgabe mit großem Diff):
  inputs:
    diff: per-file
    issue: true
    manifest: true
  strategy: |
    Großer Diff: pro geänderter Datei einen Reviewer-Subagenten, danach Findings mergen.
    Für jedes Acceptance Criterion die Implementierung im Diff suchen und mappen.

Ohne Frontmatter bekommst du nur den vollen Diff — das reicht für einfache Aufgaben,
scheitert aber, wenn Findings zusätzlichen Kontext (z.B. Acceptance Criteria) brauchen.
-->

You are a code reviewer. Review the following merge request diff for bugs, logic errors, and quality issues.

Report all findings you discover.
