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

## 6. Profile und Quota: ein Kader pro Projekt, mit Rollen

### Was heute da ist, und warum es das Szenario nicht abdeckt

Drei Mechanismen tragen je ein Stück, keiner alles:

| Mechanismus | Kann | Kann nicht |
|---|---|---|
| **Strategy Bullseye, Provider Policy** (`fill` / `throttle` / `fallback-only`, `headroomPct`, `quotaProviderId`) | Prioritätsliste pro Projekt; Quota-Gating gegen eine Tampermonkey-`/api/usage`-Quelle | Die Quelle ist an ein lokales Browser-Tool gebunden und faktisch nicht befüllt. Ohne Telemetrie degradiert die Auswahl zur statischen Reihenfolge. Ein "verboten" gibt es nicht; eine explizite Workspace-Wahl steht über der Policy. |
| **Auth-Rotation-Ring** (`claude-subscription-ring`, `codex-license-ring`) | Reaktiv: erkennt den Usage-Limit-Text im Output, stempelt einen Cooldown, rotiert weiter, schreibt die Bullseye-Policy um (#973) | Wählt erst, wenn die Quota schon weg ist. Kennt keine Rollen. Rotiert global, nicht pro Projekt. |
| **Profil-Allowlist** (`allowed_profiles_<projectId>`, `profile-allowlist.ts`) | Harte Schranke, als Letztes angewandt, cooldown-bewusst, hält statt zu borgen, fail-closed bei Unlesbarkeit; verweigert Remote-Platzierung für eingeschränkte Projekte (#651) | Eine flache Liste. Kein "Reserve nur im Notfall", kein globales Verbot, keine Quota-Sicht, keine Worker-Attestierung. |

Das Fünf-Profile-Szenario braucht genau die drei fehlenden Dinge: **Rollen**, **eine vorausschauende
Quota-Quelle**, und **eine Worker-Seite, die dasselbe Vokabular spricht**.

### Zielmodell: der Profilkader

Ein **globaler Kader** aller bekannten Profile mit je einer Rolle, und pro Projekt eine optionale
Einschränkung darauf. Beides in Settings → Agent, beides als eine Preference.

```
roster (global)                          roster_<projectId> (Überschreibung, optional)
  claude:anth        pool                   kunde-x:  claude:kunde-x  pool   (nur dieses)
  claude:team5x      pool
  claude:team5x_2    pool
  claude:privat      reserve
  claude:training    forbidden   <- global forbidden bleibt forbidden, auch pro Projekt
```

Die drei Rollen:

| Rolle | Bedeutung | Auswahl |
|---|---|---|
| `pool` | Standardvorrat. Wird bis zur Quota-Schwelle genutzt. | Nach **verbleibendem Headroom im 5-h-Fenster** sortiert, nicht nach Listenreihenfolge. Über der Schwelle (Vorschlag 90 %, konfigurierbar) gilt das Profil als erschöpft. |
| `reserve` | Notfall. | Nur, wenn **jedes** `pool`-Profil erschöpft oder im Cooldown ist, **und** der Griff zur Reserve erlaubt ist: Projekt-Flag `reserve_allowed_<projectId>`, Ticket-Tag `reserve:ok`, oder ein expliziter Operator-Start. Jeder Reserve-Start wird protokolliert und im Monitor-View als Warnung gezeigt. |
| `forbidden` | Darf diese Arbeit nie sehen. | Nie. Auch eine explizite Workspace-Wahl, ein Ring-Rewrite und ein `--profile` per CLI werden abgewiesen, nicht geklemmt. Ein globales `forbidden` kann pro Projekt nicht aufgehoben werden. |

Fehlt alles, gilt "unrestricted, alle `pool`", also das heutige Verhalten. Ein Projekt mit
Kader-Überschreibung sieht **nur** die dort genannten Profile: das Kundenprojekt bekommt
`claude:kunde-x pool` und sonst nichts, und wenn das erschöpft ist, **hält** es (das ist die
Allowlist-Semantik von heute, unverändert).

Das ersetzt keine Bullseye. Die Bullseye bleibt die *Präferenz* (welcher Provider, welches Modell,
welche Gewichtung), der Kader ist *Erlaubnis plus Budget*. Technisch ist der Kader die heutige
Allowlist mit Rollen statt bloßer Reihenfolge; `profile-allowlist.ts` bleibt der Ort, die
`fallback-only`-Policies der Bullseye werden auf `reserve` abgebildet, und `quotaProviderId`
entfällt zugunsten der Quelle unten.

### Die Quota-Quelle: vorausschauend, aus dem eigenen Token, gedrosselt

Die verlässliche Quelle ist der OAuth-Usage-Endpoint, pro Profil mit dessen eigenem Token gelesen.
`claude-pick/fleet/lib/usage.mjs` tut das bereits und hat die Fallen hinter sich: der Endpoint
gibt leicht 429, also **ein Profil pro Tick, Round-Robin, nie ein Burst**, TTL nach Nähe zur
Kappe, jede Anfrage geloggt. Der Vorschlag ist, diese Logik als `QuotaUsageProvider`-Implementierung
ins Board zu holen (das Interface existiert in `quota-usage.service.ts`) und den Tampermonkey-Pfad
zu ersetzen. Ergebnis pro Profil: Prozent im 5-h- und im 7-Tage-Fenster, Reset-Zeitpunkt, Alter
der Messung.

Alt ist besser als falsch: ist die Messung älter als ein Reset-Fenster, zählt das Profil als
"unbekannt" und wird hinter den `pool`-Profilen mit frischer Messung einsortiert, nicht als
erschöpft und nicht als leer.

### Lokal und remote sind verschieden, und das ist richtig so

Der Board-Host kennt seine Profile und ihre Tokens. Ein Worker kennt **seine**, und das Board
sendet bewusst keine Credentials (Decision 012, `REMOTE_SPEC_ENV_ALLOWLIST`). Heute folgt daraus
#651: ein eingeschränktes Projekt geht nie remote. Der Kader macht daraus eine Verhandlung:

1. **Attestierung im `hello`.** Der Worker deklariert neben `--providers` und `--labels` auch
   `--profiles anth,team5x`: die Profilnamen, unter denen er sich lokal authentifizieren kann.
   Namen, keine Secrets. Das Board speichert sie am Worker-Datensatz wie heute `providers`.
2. **Quota im Heartbeat.** Der Worker liest den Usage-Endpoint für seine eigenen Profile (dieselbe
   gedrosselte Logik) und schickt die Prozentwerte mit. Damit hat das Board eine Quota-Sicht auf
   Profile, deren Token es nie besitzt.
3. **Platzierung = Schnittmenge.** `resolveWorkerPlacement` schneidet den Projektkader mit den
   attestierten Profilen des Workers und wählt nach Rolle und Headroom wie lokal. Leer und
   `worker_dispatch_strict`: halten, mit dem Kader als Grund. Leer und nicht strict: Host, wie heute.
4. **Der Spec trägt den Profilnamen, der Worker löst ihn auf.** Kennt der Worker den Namen nicht
   (Attestierung veraltet), lehnt er den Assign ab, und das Board platziert neu. Kein stiller
   Fallback auf "irgendein Login" auf dem Worker.

Ein Profil kann auf zwei Maschinen liegen (dieselbe Subscription zweimal eingeloggt). Dann ist der
Name der Schlüssel, und die Quota des Namens ist dieselbe, die beide Leser sehen, weil der Endpoint
pro Account antwortet, nicht pro Maschine. Das ist der Grund, Profile beim Namen zu führen und
nicht nach Config-Verzeichnis.

`forbidden` gilt remote genauso: ein Worker, der nur `training` attestiert, bekommt von einem
Projekt, dem `training` verboten ist, nichts, egal was `--providers` sagt.

### Was das für das Szenario heißt

| Projekt | Kader | Verhalten |
|---|---|---|
| agentic-kanban (Dev) | global: 3 × `pool`, 1 × `reserve`, 1 × `forbidden` | Startet auf dem Pool-Profil mit dem meisten Headroom; rotiert vorausschauend statt nach dem Limit-Text; greift zur Reserve nur mit Flag; sieht `training` nie. |
| Kundenprojekt | `roster_<id>` = `claude:kunde-x pool` | Läuft ausschließlich dort. Erschöpft heißt halten, Remote nur zu einem Worker, der `kunde-x` attestiert. |

### Schritte, in Reihenfolge, jeder für sich landbar

1. **Quota-Quelle**: die Logik aus `usage.mjs` als `OAuthQuotaProvider` ins Board, gedrosselt, mit
   Alter der Messung im DTO. Ersetzt den Tampermonkey-Pfad. Sichtbar im Monitor-View pro Profil.
   (Für sich nützlich: Sentinel und Objective sehen endlich Quota.)
2. **Rollen im Kader**: `allowed_profiles` bekommt pro Eintrag eine Rolle, plus die globale
   Variante mit `forbidden`. Resolver bleibt `profile-allowlist.ts`, erweitert um
   Headroom-Sortierung und Reserve-Regel. Ratchet-Test analog zu `risk-posture-raw-read-ratchet`:
   kein Lesen des Kader-Prefs außerhalb des Resolvers.
3. **Vorausschauende Rotation**: der Ring stempelt weiter Cooldowns reaktiv, aber die Auswahl vor
   dem Start fragt zuerst den Kader mit Quota. Der Limit-Text wird zum Backstop.
4. **Worker-Attestierung**: `--profiles` im hello, Quota im Heartbeat, Platzierung als Schnittmenge.
   Hebt #651 von "nie" auf "nur zu einem Worker, der es beweisen kann".
5. **UI**: eine Kader-Tabelle in Settings → Agent (global) und im Projekt, mit Rolle, Headroom,
   Reset-Zeit, letzter Messung.

Schritt 1 und 2 sind das Szenario; 3 und 4 sind Durchsatz und Fleet-Verträglichkeit.
