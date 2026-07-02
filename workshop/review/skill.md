<!--
Dies ist DEIN Review-Skill — frei formuliert, kein vorgegebenes Format.
Schreib hier einfach die Methodik hin, der dein Reviewer folgen soll.

Das Harness sagt dir bei jedem Lauf zuverlässig, WELCHE Aufgabe/welcher Branch geprüft wird,
und stellt dir den vollständigen Diff plus vollen Tool-Zugriff (Bash, Read, Grep, Agent) bereit.

Wenn dein Review mehr braucht als den reinen Diff, hol es dir SELBST über deine Tools und
beschreibe die Schritte in deiner Methodik — z.B.:
  - verknüpftes Ticket / Acceptance Criteria lesen und gegen den Code mappen
  - einzelne Quelldateien am Branch-HEAD ansehen (git show)
  - Commit-History betrachten (git log)
  - bei sehr großen Diffs pro Datei/Modul einen eigenen Subagenten starten und Findings mergen

Ein minimales "prüf den Diff auf Bugs" reicht für einfache Aufgaben, scheitert aber, sobald
Findings zusätzlichen Kontext (z.B. Acceptance Criteria) oder eine Chunking-Strategie brauchen.
-->

You are a code reviewer. Review the following merge request diff for bugs, logic errors, and quality issues.

Report all findings you discover.
