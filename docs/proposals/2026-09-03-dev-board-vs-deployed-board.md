# Zwei Boards, ein Merge-Modus: wie wir wieder schneller werden

**Status:** Vorschlag
**Datum:** 2026-09-03
**Anlass:** Die Arbeit am Board ist langsamer geworden. Die Quality Gates laufen minutenlang, weil
die volle Suite auf einer Maschine läuft, die bereits unter Last steht. Der Test-Impact-Plugin
hat das Gate verengt, aber der Modus, in dem das Board die Produktivität *erhöht*, ist noch nicht
zurück.
**Inspiration:** Steve Yegge, [The Shape of Things to Come](https://yegge.ai/essays/the-shape-of-things-to-come/)
(Part 1, "The Continuous Thunderdome").

## 1. Diagnose: woran es wirklich hängt

Vier Dinge, gemessen am 2026-09-03, nicht vermutet:

| Befund | Messung |
|---|---|
| **Die Maschine ist der Engpass, nicht die Tests.** | `fleet status`: 1,5 GB von 28 GB nutzbar, Kernel-Pool 12,7 GB (`mssecflt.sys`-Leak), 22 GB über physisches RAM committed. Jedes Gate-Ergebnis unter dieser Last ist Rauschen (#1006 und #994 haben genau das festgestellt: die Suites haben Maschinenlast getestet, nicht Code). |
| **Das Board entwickelt sich selbst im selben Prozess, der es betreibt.** | `pnpm dev` = `tsx watch` auf dem Main-Checkout. Jeder Merge auf master lädt den Server neu, der gerade den Merge fährt. Ein roter master ist ein potenziell kaputtes Board, also stoppt alle Arbeit. Daher darf master nie länger rot sein, daher muss jedes Gate vollständig sein, daher dauert es. |
| **Der Harness frisst die Produktarbeit.** | 261 Nicht-Merge-Commits seit 2026-08-25; 158 davon (61 %) drehen sich um Gate, Impact-Map, Guards, Ratchets, Typecheck, Hooks, Merge-Pfad. 11 sind reine `chore: rebuild test-impact map`. Yegge budgetiert 20–25 % Harness-Overhead. |
| **Der Backlog ist leer.** | 7 offene Tickets, `objective.md` sagt "DRAIN, DO NOT REFILL". Ohne Producer-Seite kann keine Consumer-Seite Durchsatz erzeugen. |

Dazu die Kosten der Absicherung selbst: 171 `@gate:always-run`-Guard-Suites und 31 Ratchet-Tests.
Jeder Ratchet ist eine Dauersteuer auf jeden Merge, und ihre Zahl wächst mit jedem Ticket, das
"eine Regel erzwingt".

Der Verdacht des Anlasses stimmt also: **das Trennen von Entwicklungs-Board und betriebenem Board
ist der eine Schritt, der die anderen erst erlaubt.** Solange das Board sich selbst hostet, ist ein
rotes Gate ein Betriebsausfall, und dann ist jede Gate-Verengung ein Risiko, das man mit noch mehr
Guards absichern will. Genau diese Spirale zeigt der Commit-Mix.

## 2. Was aus dem Essay übertragbar ist, und was nicht

Yegges Muster, gegen unseren Stand gehalten:

| Yegge | Bei uns | Lücke |
|---|---|---|
| **Producer/Consumer-Balance** (Crew entwirft, Fleet baut, Crew reviewt; ~700 Beads Vorrat) | Conductor + Builder + Auto-Review sind da. | Es gibt keine stehende Producer-Rolle. Backlog wird gedrained, nicht gefüllt. |
| **Thunderdome CI/CD**: keine Bisektion, auf main landen, dann per Schwarm diagnostizieren | Per-Merge-Gate, das bei jeder Base-Bewegung verworfen und neu gefahren wird (#986: ein 10-Minuten-Gate verworfen, weil ein `docs:`-Commit und ein Map-Rebuild die Base bewegten). | Wir zahlen exakt den Bisektions-Preis, den er abschafft. |
| **Crons watch, models act** | In-Process-Monitor, Background-Sweeps, Reconciler. | Weitgehend vorhanden. |
| **Drawbridge** (Deploy-Beobachter) und **Gargoyle** (SRE) als stehende Rollen | Sentinel-Skill, von Hand angestoßen. | Es gibt nichts zu deployen, weil Dev = Prod. |
| **Wissensstapel** brain / doc / beads / remember / skills | CONTINUE.md / docs / Tickets / Memory / Skills. | Deckungsgleich. CLAUDE.md ist unser `bd remember`, mit 400+ Zeilen aber teuer pro Session. |
| **Kein menschliches Code-Review** | `auto_review` ist da. | Keine. |
| **Token-Vorrat via Account-Rotation** | Auth-Rotation-Ring. | Quota heute bei 100 % auf einem Profil. Kein Struktur-, ein Kapazitätsproblem. |
| **20–25 % Harness-Budget** | Nicht gemessen, faktisch 61 %. | Das Budget existiert nicht als Regel. |

**Nicht übernehmen:** 13 Max-Accounts (ToS-Risiko, wir haben den Ring), Sandboxing abschaffen (der
Fremd-Repo-Schreibschutz hat #959 real verhindert), MCP abschaffen (das Board ist MCP-first, und das
ist seine Stärke gegenüber einem Emacs-Harness), 175 Commits pro Tag als Ziel. Sein Punkt ist nicht
die Zahl, sondern dass **der Merge-Pfad nie der Engpass sein darf**.

## 3. Der Vorschlag, in Reihenfolge

### A. Stabiles Board und Entwicklungs-Board trennen (der Hebel)

**Zielbild:**

| | Stabiles Board | Entwicklungs-Board |
|---|---|---|
| Checkout | `C:\projects\andrena\agentic-kanban-stable`, ausgecheckt auf Tag `stable` | `C:\projects\andrena\agentic-kanban` (heute) |
| Prozess | gebautes Artefakt: `pnpm build` + `pnpm start` (`dist/`), **kein `tsx watch`** | `pnpm dev` wie heute |
| Ports | 3001 / 5173 (die heutigen, damit MCP-Configs, Skills, Hooks unverändert bleiben) | 3101 / 5273 |
| DB | die heutige `kanban.db`, per `KANBAN_DB_URL` gepinnt | eigene DB: Snapshot oder leer mit Fixture-Projekten aus `exp/` |
| Registrierte Projekte | **alle**, inklusive `agentic-kanban` selbst | nur Fixtures, nie den eigenen Checkout |
| Darf rot sein? | nie | **so lange wie nötig** |

Das stabile Board treibt die Entwicklung des Boards. Builder arbeiten in Worktrees des
Dev-Checkouts, das Gate läuft dort, aber **kein Merge kann mehr den Server treffen, der den Merge
fährt.** Ein roter master kostet dann nichts außer der nächsten Promotion.

**Promotion (Yegges Drawbridge):** ein `promote`-Skript, das

1. prüft, dass der letzte nächtliche Voll-Sweep auf master grün war,
2. `stable-YYYYMMDD` taggt,
3. im stabilen Checkout auf den Tag fast-forwardet, baut, Migrationen fährt, neu startet,
4. den Smoke-Check (`/health`, `list_projects`, ein `get_board_status`) fährt und bei Fehler auf den
   vorherigen Tag zurückgeht.

Getaktet, nicht pro Merge: einmal am Tag, im Leerlauf, oder von Hand bei Bedarf. Das ist der eine
Zeitpunkt, an dem die volle Suite etwas entscheidet.

**Was bereits passt:** `KANBAN_DB_URL` ist registriert, die Worktree-Port-Konvention existiert,
`KANBAN_MAIN_CHECKOUT` erlaubt den Hooks, den Main-Checkout zu finden, und der stabile Checkout ist
für den Fremd-Repo-Guard ein fremdes Repo, also für Builder unschreibbar. Die Regel "nur ein Board
registriert `agentic-kanban`" verhindert die Branch-Holder-Kollision (#110).

**Was zu klären ist:** ob `pnpm start` aus `dist/` mit Bundled-Skills-Verzeichnis und Migrations-Dir
sauber läuft (die npm-Publish-Pipeline behauptet es), und wie die MCP-Konfigurationen in `~/.claude*`
auf das stabile Board zeigen (Port unverändert, also vermutlich gar nicht). Aufwand: ein Tag,
überwiegend Betrieb und Doku.

### B. Merge-Modus des Dev-Boards: landen, dann heilen

Sobald A steht, ist das Per-Merge-Gate nicht mehr die Verteidigung des Betriebs, sondern nur noch
Hygiene. Dann gilt Thunderdome-light:

- **Posture `iterate` bleibt** (Typecheck warm ~10 s, Always-Run-Guards, Impact-Selektion,
  120 s Budget). Das ist gebaut (#956, #982–#984).
- **Roter master blockiert keinen Merge.** `redBasePolicy: allow-file-debt-ticket` existiert
  in Decision 017; einschalten. Die nächtliche Voll-Suite erzeugt bei Rot **ein** `heal`-Ticket mit
  der Fehlerliste, das der Monitor mit höchster Priorität und außerhalb des WIP-Limits startet.
  Ein Agent diagnostiziert die Liste, statt dass N Gates dieselben Suites erneut fahren.
- **Verworfene Gates neu bewerten (#979/#986).** Beide messbaren Discards waren ein
  `docs:`-Commit und ein Map-Rebuild. Regel: bewegt sich die Base nur durch Commits, deren Dateien
  weder im Branch-Diff noch in dessen Impact-Selektion vorkommen, wird das Gate **nicht** verworfen.
  Alles andere fängt die Nacht.
- **Map-Rebuild-Commits von master nehmen.** 11 von 261 Commits, und sie bewegen die Base. Entweder
  als gitignoriertes Artefakt unter `.test-impact/` oder einmal täglich vor der Promotion committen.
- **Base-Health-Sweep nur per Posture, nachts, ein Projekt nach dem anderen.** Laut
  `2026-09-01-verification-cadence.md` gebaut; prüfen, dass kein Projekt mehr die
  30-Minuten-Konstante trifft.

### C. Kapazität als Gate-Signal, nicht als Fußnote

Der `MEMORY HOLD` in `objective.md` ist von Hand geschrieben. Das gehört in
`resolveMonitorTunables`: WIP-Limit und Gate-Start lesen `fleet gate`, und unter Schwelle startet
nichts, statt dass ein Gate 780 von 783 Tests an Fork-Timeouts verliert und als "rot" zählt.
Vorher, außerhalb des Boards: **Reboot und IT-Ticket für `mssecflt.sys`.** Kein Vorschlag hier
hilft bei 1,5 GB nutzbarem RAM.

### D. Producer-Seite: den Backlog bewusst füllen

Yegges Gleichgewicht braucht Vorrat. Nach A den `FOCUS POLICY`-Block umstellen: `BACKLOG_FLOOR`
auf 15 gate-große Tickets, gruppiert über `coupled_with` (#661), Refill über
`backlog-refill` + `ticket-enhancer`. Eine wöchentliche Planungssitzung (die Crew-Rolle) erzeugt
Tickets aus `BACKLOG.md`, den Proposals und den offenen Punkten in `CONTINUE.md`. Ohne das läuft
das stabile Board mit drei Buildern gegen sieben Tickets und ist nach einem Tag wieder leer.

### E. Harness-Budget als Regel

Ein Bullseye-Gewicht statt Bauchgefühl: **höchstens ein Builder von drei auf Harness-Tickets**
(Gate, Guards, Ratchets, Impact, Monitor); die anderen auf Produkt (UX, Features, Bugfixes aus
Nutzersicht). Dazu ein Audit der 171 Always-Run-Suites und 31 Ratchets: zusammenlegen, was dieselbe
Eigenschaft prüft, streichen, was seit Einführung nie rot war. Jeder Guard, der bleibt, ist ein
bewusst gezahlter Preis pro Merge.

## 4. Reihenfolge und was wir dafür bekommen

1. **Reboot** (ohne ihn ist jede Messung Rauschen).
2. **A**: stabiles Board aufsetzen, `agentic-kanban` dort registrieren, Dev-Board auf eigene DB und
   Ports. Ab hier darf master rot sein.
3. **B**: `allow-file-debt-ticket` + `heal`-Ticket + Discard-Regel + Map-Commits von master.
4. **D**: Backlog auf 15, Refill wieder an.
5. **C** und **E** als stehende Regeln, C im Code, E im Bullseye.

Erwartung: das Gate pro Merge fällt auf Typecheck + Guards + Selektion (Minuten, nicht
Zehn-Minuten), Discards verschwinden fast vollständig, und der Harness-Anteil sinkt, weil ein
rotes Gate kein Ausfall mehr ist, den man mit dem nächsten Guard verhindern muss.

## 5. Bewusst nicht vorgeschlagen

- **Merge-Queue mit Batching über 20 Commits.** Bei drei Buildern gibt es keine Schlange zu
  batchen; das Problem ist die Gate-Dauer, nicht die Warteschlange.
- **Ein zweites Repo für das stabile Board.** Ein zweiter Checkout desselben Repos reicht und hält
  Tags, Historie und Hooks an einem Ort.
- **Gate ganz abschaffen.** Typecheck und Guards kosten unter 30 s warm und haben in dieser Woche
  echte Fehler gefangen (fehlende `sessionId` in #1002, die zwei roten Guards in #991).
