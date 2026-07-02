<!--
Dies ist DEIN Review-Skill — frei formuliert, kein vorgegebenes Format.
Schreib hier einfach die Methodik hin, der dein Reviewer folgen soll.

Das Harness übergibt deinem Reviewer bei jedem Lauf einen festen AUFGABEN-ANKER
und vollen Tool-Zugriff (Bash, Read, Grep, Agent):

  === AUFGABEN-ANKER ===
  - Aufgabe: <NR>
  - Branch:  origin/aufgabe<NR>   —   Basis: origin/master
  - Diff selbst ziehen:  git diff origin/master...origin/aufgabe<NR>
  - Voller Tool-Zugriff (Bash / Read / Grep / Agent)
  - Guard: KEINE Referenzdateien lesen (gold-standard-*, benchmark-result-*)

Das Harness kaut dir den Diff NICHT vor — es nennt nur Branch und Basis. Den Diff-Inhalt
und jeden weiteren Kontext (Quelldateien, History, Ticket/Acceptance Criteria) musst du dir
SELBST über deine Tools holen; bei großen Diffs pro Datei/Modul (ggf. eigener Subagent).
Ein minimales "prüf den mitgelieferten Diff" reicht dann NICHT mehr.
-->

You are a code reviewer. Review the following merge request diff for bugs, logic errors, and quality issues.

Report all findings you discover.
