# Raw: KI-gestützte Softwareentwicklung — Vom Hype zur Realität

> Unpublished blog article by Peter Wegner about building the Coding-Aider
> JetBrains plugin (2024 era). Extracted verbatim from
> `AI_Tooling_blog_article_german_Peter_Wegner-chs.docx`. German original;
> see [`coding-aider-blog-article-gist.md`](./coding-aider-blog-article-gist.md)
> for an English-language summary distilled for talk material.

---

## KI-gestützte Softwareentwicklung: Vom Hype zur Realität

Es gibt eine starke Diskrepanz zwischen dem Hype, der um KI-gestützten Tools im Entwickleralltag gemacht wird und, was viele von uns wirklich erleben. . Manche behaupten, dass wir Entwickler in naher Zukunft nicht mehr gebraucht werden und alle mit etwas “Prompting” selbst zu Entwicklern werden können. 

So weit so, je nach persönlichem Blickwinkel, euphorisierend oder dramatisch. Dem steht allerdings entgegen, dass die meisten Fortschritte, die wir heute im Bereich KI-Coding kennen, bestenfalls geeignet sind, um mit einem Prompt die nächste Todo-Listen-Implementierung zu liefern. Bei nicht-trivialen Anwendungen brechen sie zusammen.  Brauchbare Verbesserungen existierender Entwicklerwerkzeuge gibt es zwar, aber bislang bleiben sie weit hinter dem zurück, was uns versprochen wird.

Welchen Schluss ziehen wir also daraus – zu viel Lärm um zu wenig und Haken dran an das Thema KI-gestützte Entwicklung?

Das wäre meiner Ansicht nach ein Fehler. Vielleicht denkst du bereits, an vorderster Front unterwegs zu sein, weil du wie die meisten Entwickler ChatGPT und Github CoPilot verwendest. Sogar dann wirst du, vielleicht mit Überraschung, feststellen dass sich seit der Einführung von ChatGPT Ende 2022 und der Einführung von Github Copilot 2023 auch an anderen Stellen Fortschritte mit deutlichem Mehrwert für uns Entwickler abgezeichnet haben. Es lohnt sich, hier intensiver und über den Tellerrand hinaus hinzusehen. Dabei geht es mir nicht darum, wie unsere Welt in fünf oder 10 Jahren aussehen wird. Mein Thema ist die Frage, was bereits heute, sozusagen auf dem Tisch und in greifbarer Nähe steht.

Nützlich, aber nicht perfekt

Eins vorweg, um nicht wie der nächste Hype-Prophet zu klingen: Der derzeitige Hype geht überwiegend auf aktuelle Sprachmodelle zurück, die alles andere als perfekt sind und häufiger Fehler machen als man denkt und vielleicht noch wichtiger, als uns lieb ist. Auch eher philosophische Diskussionen, wie die über die “Intelligenz” der Systeme oder “echtem” Verständnis, sind sicherlich wichtig. Allerdings polarisieren diese Diskussionen stark und lenken davon ab, welche bereits sinnvollen Einsatzzwecke es für Sprachmodellen gibt – oder eben (noch) nicht. Aktuelle Modelle scheitern regelmäßig daran,

triviale Probleme wie das Zählen von Buchstaben in Wörtern zu lösen, ohne dass man ihnen den Hinweis gibt, das Wort zuerst zu buchstabieren oder

einzugestehen, dass eine Bibliothek eine benötigte Funktion nicht hat oder

allgemein einzugestehen, dass sie die Antwort auf eine Frage nicht kennen und nicht zuletzt

irrelevante Informationen herauszufiltern, die für die Lösung einer Aufgabe nicht benötigt werden.

All diese Schwächen und Fehler, so überraschend und frustrierend sie auch sind, ändern eins nicht: Aktuelle Modelle, besonders die Closed-Source Modelle von Anthropic und OpenAI, sind enorm nützlich, wenn man ihre Schwächen kennt und damit umgehen kann.

Menschen brauchen Feedback - KI auch

Uns ist oft gar nicht bewusst, wie vielfältig die Wege sind, über die wir Feedback erhalten, ob explizit oder implizit. Ohne ständige Rückmeldungen zu dem, was unsere Sinne über unsere Umgebung wahrnehmen, wären wir hilflos und kaum überlebensfähig.Weil wir uns das selten bewusst machen, erwarten wir von Modellen, die unsere Intelligenz nachahmen sollen, dann auch, dass sie ohne dieses Feedback auszukommen haben. Im Umfeld der Large Language Models (LLMs) hat es sich leider etabliert, den Einfluss fundamental zu unterschätzen, den der jeweilige Kontext hat. „Kontext“ umfasst alles, was dem Modell nach dem Training, d.h. zur Inferenz-Zeit, gegeben wird, um Aufgaben zu lösen. 

Die Community rund um agentisches Programmieren hat das in den letzten Monaten mittlerweile zunehmend erkannt. Aus dem anfänglich populären Begriff „Prompt Engineering“ wurde mittlerweile „Context Engineering“. Bei ersterem stehen die geschickte Wortwahl bei der Formulierung der Anfrage, die Verwendung von Tipps und Schemata an LLMs wie „Think step by step“, „be as critical as possible“ und teilweise obskur wirkende Techniken, wie emotionale Manipulationstechniken, im Vordergrund. Context Engineering ergänzt diese leider immer noch relevanten Techniken fürs Prompting durch einen ganzheitlicheren Blick. Welche Wissensquellen stelle ich meinem Modell zu Verfügung? Welche Tools kann mein LLM bei Bedarf einsetzen? Wie kann mein System sich Entscheidungen kurz und langfristig merken und wie schaffe ich es mit den immer noch eher begrenzten Kontextlängen der Modelle bestmögliche Ergebnisse zu erzielen?

In der Sozialpsychologie und bezogen auf Menschen nennt man dieses Phänomen den “Fundamentalen Attributionsfehler” (https://de.wikipedia.org/wiki/Attributionsfehler). Wir unterschätzen bei Menschen gerne den Einfluss situationsspezifischer Faktoren, wie der Stimmung und den Kontext einer Handlung. Stattdessen begründen wir Verhalten bevorzugt mit dispositionalen, also stabileren Faktoren, wie der Persönlichkeit oder der Erziehung. 

Ohne dass wir es merken, passiert uns mit Sprachmodellen etwas Vergleichbares. Es frustriert und beruhigt uns zugleich, dass unsere Intelligenz weiterhin unerreicht und unsere Arbeit relevant bleibt, während wir unseren Sprachmodellen fragmentarische Informationen geben und uns mit mehr oder weniger undurchdachten Fragen über deren Schwächen und Unzulänglichkeiten lustig machen.

Konkret auf den Entwickler-Alltag bezogen äußert sich das in vielen Situationen. Ein etwas technisches, aber auch typisches Beispiel: 

Ich möchte in einer Spring Boot Anwendung fehlerhafte javax.persistence.* Imports durch ein LLM korrigieren lassen, enthalte dem Modell die wirklich relevanten Informationen jedoch vor, z.B. , dass es sich um ein Spring Boot 3 Projekt handelt (in Spring Boot 3 wurden viele sehr oft verwendete Annotationen auf Jakarta-Pakete umgestellt) und ich Gradle und nicht Maven als Build-Tool verwende. 

Natürlich wäre es schön, wenn das Modell “intelligent” genug wäre, die relevanten Informationen ohne unser Zutun zu ermitteln und daraus Lösungen abzuleiten, aber so weit sind unsere Werkzeuge oft noch nicht. Fast schon banale Dinge scheinen wir im Umgang mit KI-Modellen auszublenden, vielleicht gerade wegen des Hypes und der zahlreichen Marketing-Versprechen:

LLMs sind keine Compiler - wenn wir Compiler-Fehler im Code sehen, ist es meistens, weil der Compiler oder die IDE uns warnt => Diese Information ist extrem hilfreicher Kontext

Code kann ausgeführt werden => Konsolenausgabe und Fehlermeldungen sind sehr hilfreicher Kontext

Code kann auf verschiedenen Abstraktionsebenen getestet werden => Diese Information ist extrem hilfreicher Kontext, gerade wenn Tests fehlschlagen

Eine explizite Kontextauswahl ist derzeit der Schlüssel zum Erfolg, selbst für die besten Modelle. Denn bislang gibt es keine magische Lösung für den

unendlichen Kontext oder die

intelligente Kontextauswahl (z.B. Retrieval Augmented Generation auf der Codebasis und zugehöriger Dokumentation), die für größere Codebasen unter allen Umständen funktioniert.

Aktuelle Werkzeuge

Viele Entwickler, die ich kenne, nutzen webbasierte Chat-Interfaces für Claude und ChatGPT. Nun ist es hilfreich, Code aus Chat-Interfaces zu kopieren und einzufügen, egal ob aus dem Browser oder innerhalb der Entwicklungsumgebung. Es fühlt sich aber nicht nach der Meisterschaft an, die viele Profis anstreben. Die meisten ausgereifteren KI-gestützten Tools sind auf VSCode ausgerichtet (im JavaScript- oder Python-Ökosystem) und hier findet ein regelrechtes Wettrennen statt. Aktuell angeführt wird das Rennen unter anderem von

Cursor (kommerziell)

Windsurf (kommerziell)

Cline und dessen derivate Roo Code und Kilo Code

CLI Anwendungen wie Claude Code, Codex CLI oder Gemini CLI

JetBrains IDEs wie IntelliJ, Rider oder Webstorm sind sehr beliebt bei Entwicklern, die Business-Anwendungen mit stark typisierten Sprachen wie Java, C# oder Typescript entwickeln. Sie besitzen oft viele integrierte Funktionen für Refactorings, Code-Generierung und Navigation, die kostenlose und Open-Source Alternativen nicht von Haus aus bieten. Trotz der hohen Lizenzgebühren für diese Werkzeuge ist die Wahl oft einfach, da sich besseres Werkzeug schnell auszahlt, besonders, wenn man es täglich nutzt. Meiner Ansicht nach hinken die meisten KI-Tools für JetBrains IDEs aber deutlich hinterher und haben mehrere Einschränkungen im Vergleich zu VSCode-Lösungen. 

Konkrete Lücken

Hier ein paar Beispiele meiner Ansicht nach wesentlicher Features, die ich an den meisten Plugins für Jetbrains IDEs vermisse:

Multi-File-Edit via Chat ohne Copy und Paste

Kontextauswahl für Inline-Edit im Code

einfache Kontextauswahl

elegante Lösungen zur Vermeidung von Antworten wie “Rest of the code remains as before”

Abmilderung von Knowledge-Cutoff-Effekten bei der Arbeit mit neuen oder weniger bekannten Bibliotheken

effiziente Feedback-Loops für Compile-Fehler und fehlschlagende Tests

Gleichzeitig fällt auf, dass verbreitete und bekannte Plugins trotz ihrer Verbreitung und Bekanntheit eine geringe Reife besitzen und aus diversen Gründen im JetBrains Plugin Marketplace schlechte Bewertungen bekommen:

Continue 2,8/5 Sterne

GitHub CoPilot 2.6/5 Sterne

JetBrains AI Assistant 2/5 Sterne

Besonders unterscheidet sich der Funktionsumfang bei Plugins wie GitHub CoPilot, die für mehrere IDEs verfügbar sind, teilweise dramatisch zwischen den einzelnen IDEs. Einer der zahlreichen Reviewer beschreibt seinen Frust mit GitHub CoPilot für JetBrains IDEs dabei passend so: This plugin being so far behind is one of the main reason's I've moved over to VS Code. JetBrains improves the IDE with vital fixes (especially lately with TypeScript) and I update to the EAP / Beta, but this doesn't work anymore... This might be a strategy, since both Copilot and VS Code are owned by Microsoft. @Jetbrains this is something you should be ensuring is compatible with your latest versions or you will lose customers. Its ridiculous how far behind this plugin is all the time.

Eine Alternative: Aider

Natürlich muss eine Entwicklungsumgebung nicht für jeden Einsatzzweck ausgelegt sein. Außerdem sind wir Entwickler daran gewöhnt,  für unterschiedliche Probleme auch verschiedene  Werkzeuge zu finden, falls unser Schweizer Taschenmesser nicht ausreicht. Eine solche Lösung kann zum Beispiel eine separate Terminal-Anwendung wie Aider sein. (https://github.com/Aider-AI/aider)

Mit seinem Terminal basiertem Chat-Interface können Entwickler wie gewohnt prompten,  die Nutzererfahrung erinnert etwas an Pair Programming, bei dem wir Menschen bei Bedarf auch mal in die Driver Rolle wechseln können. Aider verfügt dabei über ein paar nette Kniffe, um die Stärken von LLMs zu nutzen, ohne dabei Entwickler ersetzen zu wollen. Mit Aiders Repo-Map beispielsweise erhält das Modell zwar eine gute Übersicht über die Projektstruktur in einem Git-Repository . Den Kontext jedoch wählt überwiegend der Entwickler manuell aus. Gleichzeitig automatisiert Aider weniger kritische, aber sehr nützliche Schritte, wie die automatische Versionierung von Änderungen mit git commits, oder das sehr wichtige automatische Einweben von geänderten Codefragmenten in bereits existierende Dateien. Die Verwendung passender Diff-Formate erreicht gleich dreierlei: die Token-Kosten werden reduziert, die Entwicklererfahrung durch schnellere Bearbeitung verbessert und darüber hinaus Fehler vermieden, die bei der Bearbeitung längerer Dateien auftreten können. Für die oben erwähnten Feedback-Schleifen gibt es ein paar Recovery-Mechanismen, automatisch ohne Nutzerzutun einfache Probleme beheben können. Das gilt beispielsweise für nicht anwendbare Codeänderungen durch das LLM oder fehlschlagendes Linting nach Änderungen.

Charmant an Aider ist nicht zuletzt die Möglichkeit, beliebige Sprachmodelle anzubinden, egal ob lokal oder aus der Cloud. Dazu kommt,  dass dieses Open-Source-Projekt zu großen Teilen mit sich selbst geschrieben wird und der Hauptentwickler bei der Veröffentlichung neuer Modelle innerhalb weniger Stunden und Tage Updates zu deren Unterstützung veröffentlicht, mitsamt aussagekräftiger Benchmarks. Die knapp 23k Sterne auf Github sind meiner Meinung nach vollkommen berechtigt und zeigen die bemerkenswerte Leistung, die einzelne fähige Entwickler mithilfe von KI-Tools erzielen können. Letztlich wird Aiders Benchmark von State of the Art LLM Anbietern wie https://api-docs.deepseek.com/news/news0905#code-capabilities zitiert und in akademischen Forschungsarbeiten wie https://sakana.ai/ai-scientist/ als Komponente verwendet.

Was fehlt Aider?

Trotz all dieser Stärken ist auch Aider leider nicht perfekt. Die manuelle Kontextauswahl ist mühsam, wenn Dateien häufig geändert werden müssen. Einen Chat-Verlauf zu verwenden ist zwar intuitiv und oft nützlich, andererseits kann aber genau dieser Chat-Verlauf auch zu Problemen führen. Besonders dann, wenn das Modell nicht auf Anhieb relevante Antworten und funktionierende Lösungen liefern kann, weil das zu Fehler-Loops führt. Ähnlich wie in der Zusammenarbeit zwischen Menschen hilft es in diesen Situationen, Abstand zu den bisherigen Ansätzen zu gewinnen und das Problem mit neuem Kontext aus einer anderen Perspektive zu betrachten. 

Die größte Schwäche bei Aider, wenn man es für agentisches Programmieren verwenden will, liegt meiner Meinung nach in der fehlenden automatischen Fortschrittsverfolgung für komplexe Aufgaben. Durch geschicktes Prompting können mit Aider auch sehr komplexe Aufgaben überwiegend automatisch erledigt werden, nur in der Regel nicht innerhalb eines Prompts. Hier müssen wir Entwickler selbst kreativ werden, um das Potential aktueller LLMs zu nutzen.

Zurück in die Entwicklungsumgebung - das Coding Aider Plugin

Aiders Fähigkeiten hatten mich vor knapp einem Jahr auf eine Idee gebracht. Warum sollte ich nicht einfach die Stärken von Aider und dessen sehr aktivem Entwicklungsprozess nutzen und mithilfe eines Plugins für die Entwicklungsumgebung besser in die gewohnte Arbeitsweise von Entwicklern integrieren? Damit ließe sich vor allem die Entwicklerfreundlichkeit erhöhen und die Zugriffsmöglichkeit auf gängige Aktionen beschleunigen. Gleichzeitig könnte ich von Aiders bereits vorhandenen Funktionen profitieren. Glücklicherweise liefert Aider auch einfache Skripting Möglichkeiten, so lässt sich Aider zum Beispiel mit Befehlen wie aider --sonnet -m "write a poem about love and save it in a txt file" starten, um einmalige Aktionen auszuführen.

Initiale Phase - Die Grundlagen schaffen

Meine erste Coding-Session begann ich mit einem Gradle-Projekt, das initial mithilfe des Jetbrains Plugin Projekt-Template (https://plugins.jetbrains.com/docs/intellij/developing-plugins.html) angelegten worden war. Diese Session sollte für den weiteren Entwicklungsprozess bezeichnend werden. Ohne vorherige Erfahrung in der Plugin-Entwicklung, aber mit soliden Kotlin- und Gradle-Kenntnissen im Gepäck, startete ich mit einem einfachen Prompt mit build.gradle im Kontext an Aider:

create an action in the project view context menu that will open a dialog with a text field that will be used as the message argument for a cli application named aider

Durch die build.gradle Datei im Kontext hat das Modell ausreichend Informationen, um zu wissen, dass es sich um ein Kotlin Gradle-Projekt für ein IDE-Plugin für IntelliJ handelt. Außerdem weiß es,  was mit action oder project view gemeint ist und welche UI Bibliotheken (Swing) in Frage kommen.Gleichzeitig macht sich hier auch gleich eine der vielleicht überraschenden Fähigkeiten von LLMs und Aider bemerkbar. Üblicherweise registrieren Plugins ihre Aktionen in einer plugin.xml, um sie in bestehende IDE Menüs hinzuzufügen. Auch wenn diese Datei nicht Teil des Kontexts ist, kann das Sprachmodell den Nutzer darauf hinweisen, dass auch hier Änderungen notwendig sind. Nach erhaltener Bestätigung kann es den Kontext selbstständig erweitern, um auch diese Änderungen zu implementieren. Dieses leicht agentische Verhalten, bei dem das Modell Vorschläge für mögliche Aktionen macht, ist ein simples Beispiel dafür, inwieweit und warum AI-Coding-Tools  zu verwenden mit Pair-Programming mit einem kompetenten Entwickler vergleichbar sein kann. Wenige Sekunden später hatte ich ein gutes Fundament, um den generierten Code so anzupassen, dass mein Dialog Aider auch mit den korrekten Startparametern, in etwa aider -m "{prompt}" starten würde. Mit dem passenden Gradle Task gradle buildPlugin war die erste Version meines Plugins bereit zur Verwendung – natürlich direkt in der IDE in der ich gestartet hatte.

Die Reise beginnt

Die nächsten Schritte bestanden darin, die ausgewählten Dateien im Project View als Kontext für die Action zu verwenden und das Feedback durch Anzeige der Aider-Ausgabe in einem Dialog zu verbessern. Prompts wie:

list all files in the dialog and add a toggle to distinguish files that are provided to the --file argument and those that are read only and should be provided to a --read parameter when calling the aider command

waren meist gut genug, besonders wenn ich die richtigen Dateien als Kontext verwendete, um viele wichtige Funktionen zu implementieren. Ein komplexeres Beispiel war die Implementierung einer Code-Completion-Funktion innerhalb des Dialogs:

i want to utilize intellijs rich code completion features within my message input field. the class names of classes contained in the files of the context should be suggested. the field should still be multilined and bascially behave like a code editor that i can write arbitrary text in and also get suggestions when presssing ctrl + spaceutilize the intellij completion contributor api

Von einfachen Prompts zu Plänen

Tatsächlich reichen derart umfangreiche und detaillierte Prompts wie dieser selbst mit gutem Kontext oft nicht aus, um komplexe Funktionen korrekt zu implementieren. Diese Einsicht brachte mich zu einer meiner bisher nützlichsten Funktionen: Dem structured mode, bei dem das LLM aufgefordert wird, einen Plan und eine Checkliste für die Anfrage in Markdown-Dateien zu erstellen. In der Praxis wird damit aus obigem Prompt ein ausgefallener Plan. Diese Verfeinerung von Nutzer-Prompts wird gerne als Prompt-Augmentation bezeichnet und findet mittlerweile in vielen AI-Coding Assistenten Einsatz. In meiner Variante sieht das Ergebnis dieser Verfeinerung dann zum Beispiel so aus:

[Coding Aider Plan]# Improve AiderInputDialog Message Input## Feature DescriptionEnhance the message input area in the AiderInputDialog with rich IDE editor-like features, focusing on code completion and syntax highlighting. The implementation will use IntelliJ's native components to provide filename suggestions from the context view when the user presses Ctrl + Space.## Implementation Overview1. Replace JTextArea with EditorTextField2. Implement basic code completion for filenames3. Configure syntax highlighting4. Enhance code completion with more context-aware suggestions## Detailed Steps1. Replace JTextArea with EditorTextField   - Import necessary IntelliJ Platform SDK classes   - Create an EditorTextField with appropriate settings   - Configure the EditorTextField to use a suitable file type (e.g., PlainTextFileType)2. Basic Code Completion for Filenames   - Implement a custom CompletionContributor for filenames   - Set up completion to trigger on Ctrl + Space   - Populate the completion suggestions with filenames from the context view3. Syntax Highlighting   - Use IntelliJ's built-in syntax highlighting capabilities   - Configure the EditorTextField to use an appropriate language (e.g., PlainTextLanguage)4. Enhanced Code Completion   - Extend the CompletionContributor to include more context-aware suggestions (e.g., Aider commands, common coding patterns)   - Implement intelligent suggestion filtering based on the current input context## References- [Checklist](improve_aiderinputdialog_message_input_checklist.md)## Notes- Ensure backwards compatibility with existing AiderInputDialog functionality- Leverage IntelliJ's built-in components and APIs for better integration and performance- Maintain a clean and intuitive user interface

Spannend ist vor allem die zugehörige Checkliste. Bessere LLMs sind damit in der Lage, anhand der Checkliste Fortschritte zu tracken und geschickte nächste Schritte zu identifizieren und mit diesen fortzufahren. Das muss nicht immer ein einzelner Schritt sein und auch nicht immer der nächste in der Reihe. Wie für AI-Coding-Tools üblich, trifft hier einfach das LLM die Entscheidung, womit es weitergeht.

[Coding Aider Plan - Checklist]# Improve AiderInputDialog Message Input - Implementation ChecklistReference: [Improve AiderInputDialog Message Input Plan](improve_aiderinputdialog_message_input.md)## 1. Replace JTextArea with EditorTextField- [x] Import necessary IntelliJ Platform SDK classes- [x] Create EditorTextField in AiderInputDialog- [x] Configure EditorTextField with appropriate settings- [x] Set up EditorTextField to use PlainTextFileType- [x] Update layout to accommodate EditorTextField## 2. Basic Code Completion for Filenames- [x] Create a custom CompletionContributor for filenames- [x] Implement a method to get filenames from the context view- [x] Register the CompletionContributor- [x] Use CompletionContributor to provide filename suggestions in the AiderInputDialog- [x] Set up completion to trigger on Ctrl + Space  - [x] programmatically trigger completion popup- [ ] Test basic filename completion functionality## 3. Syntax Highlighting- [ ] Support syntax highlighting with various input types## 4. Enhanced Code Completion- [ ] Extend CompletionContributor to include Aider commands- [ ] Implement context-aware suggestion filtering- [ ] Add common coding patterns to completion suggestions- [ ] Test enhanced code completion functionality## 5. Final Testing and Refinement- [ ] Perform thorough testing of all new features- [ ] Ensure backwards compatibility with existing functionality- [ ] Optimize performance for large projects- [ ] Update user documentation- [ ] Gather user feedback and make necessary adjustments

Wie man an der Checkliste sieht, wurde diese nie vollständig abgearbeitet, weil mir die Grundfunktionalität letztlich reichte. Alle generierten Pläne sind im Git-Repository des Plugins unter .coding-aider-plans oder .coding-aider-plans-finished zu finden.

Persönliche Highlights

Die Entwicklung des Plugins war für mich eine besonders lehrreiche Erfahrung, vor allem, weil ich das Plugin für seine eigene Weiterentwicklung nutzen konnte. Diese unmittelbaren Feedback-Loops waren unschätzbar wertvoll - nichts ist aufschlussreicher, als die eigenen Werkzeuge im praktischen Einsatz zu erleben und direkt zu erkennen, wo Verbesserungen nötig sind.

Besonders interessant war zu beobachten, wie sich das Plugin durch “Pain-driven Development” weiterentwickelte. Jeder Schmerzpunkt in der täglichen Nutzung führte organisch zu neuen Features. Als ich beispielsweise feststellte, wie umständlich das Aider-Setup unter Windows war, implementierte ich kurzerhand Docker-Support. Die zeitaufwändige Prompt-Eingabe führte zu einer ganzen Reihe von Verbesserungen: Ich integrierte eine Prompt-History, fügte einen Redo-Button hinzu und implementierte Autocompletion im Prompt-Eingabefeld. Der strukturierte Modus, den ich bereits beschrieben habe, entstand ebenfalls aus diesem direkten Feedback-Loop.

Ein weiterer interessanter Aspekt war die Verbesserung der Übersichtlichkeit. Ich ärgerte mich über den anfangs schlechten Überblick über die von der KI vorgenommenen Änderungen. Das führte zur Entwicklung eines verbesserten Output-Viewers für Markdown und zur automatischen Öffnung einer Git-Vergleichsansicht nach jedem Aider-Commit. Diese Features entstanden nicht aus theoretischen Überlegungen, die ich vorher angestellt hatte, denn das hatte ich gar nicht. Sie sind das Resultat konkreter Bedürfnisse während der Entwicklung.

Bei manchen Features war ich selbst überrascht, wie stark sich die Zeit für die Implementierung verkürzte, weil ich das Plugin nutzte. Es fühlte sich oft an, als hätte ich einen erfahrenen Entwicklungspartner an meiner Seite, der nicht nur bei der Implementierung half, sondern auch proaktiv Verbesserungsvorschläge einbrachte. Diese Erfahrung bestärkte mich in der Überzeugung, dass KI-Tools, richtig eingesetzt, tatsächlich zu einer deutlichen Produktivitätssteigerung führen können – nicht dadurch, dass sie uns Entwickler ersetzen. Sondern weil sie unsere eigenen Fähigkeiten sinnvoll ergänzen.

Die Reise geht weiter

Meine Reise hatte Höhen und Tiefen. Features, die trivial erschienen, etwa eine schöne Markdown-Output-Ansicht, erwiesen sich als so komplex, dass meine beste Option darin bestand, eines eigenen Markdown-Viewers zu implementieren zu lassen.

Seit meinem Start mit der Entwicklung Mitt/Ende 2024 hat sich die Toollandschaft dramatisch verändert. Wie zu erwarten ist aber auch die Entwicklung der Sprachmodelle nicht stehen geblieben. Mittlerweile gibt es eine breite Auswahl an KI-Entwicklerwerkzeugen, die angereichert um nützliche Tools und MCP Server, sowie geschickte Delegation mit Subagenten erfahrene Entwickler um ein Vielfaches produktiver machen können.

Bis Ende 2024 lag große Aufmerksamkeit und Innovationskraft vor allem bei kommerziellen Visual Studio Code Forks wie Windsurf oder Cursor, die dadurch auch für große LLM-Schmieden wie Anthropic oder OpenAI in den Fokus rückten. Deren schnell gestiegene Nutzerzahlen und Marktwerte zeigten, welche Potentiale in den bereits verfügbaren Modellen steckt, wenn man sie in die richtigen Systeme einbindet. 

Aktuell hat sich der Fokus vor allem auf Kommandozeilen (CLI) Anwendungen verlagert. Oft sind diese auch mit den vorhandenen Subscription Modellen der Anbieter nutzbar, was für Power User ein echtes Schnäppchen sein kann. Durch die gedeckelten Kosten (z.b. 200$/Monat pro Entwickler bei Anthropic) wird vollagentisches Coding attraktiv und „erschwinglich“. Hier ist das System nach anfänglicher Anforderungsklärung so lange autonom tätig bis es meint, die Aufgabe gelöst zu haben. Dabei können je nach Einstellung beliebige Terminalbefehle ausgeführt, Schnittstellen angesprochen und Dateien gelesen, bearbeitet oder erstellt werden.  Sei es Anthropics Claude Code, OpenAIs Codex CLI oder Googles Gemini CLI, die Auswahl war nie größer. Es vergeht keine Woche in der nicht mindestens eine neue AI-IDE, eine neue Coding CLI-Anwendung oder ein neuer Cloud-Dienst für agentisches Coding entsteht.

Als ich meinen Plan-basierten strukturierten Modus in mein Plugin eingebaut hatte, gab es ein paar vereinzelte Produkte die ähnliche Funktionalitäten anboten. Mittlerweile gehört es praktisch zum Standard, das in einem initialen Plan-Modus Anforderungen besprochen und verfeinert werden können und die Modelle Checklisten zur Fortschrittskontrolle nutzen dürfen. Amazons Kiro Code hat diesen Specification-Driven-Development Ansatz gleich zum Kernfeature ihres Assistenten gemacht. 



Mein Fazit und was für die breite Adoption fehlt?

Aktuelle LLMs machen unvorhersehbare Fehler. Wenn wir sie dennoch verwenden wollen, müssen wir unsere Coding-Gewohnheiten überdenken. Die meisten Entwickler, die ich kenne, schreiben lieber selbst Code, anstatt KI-generierten Code zu reviewen. Das hängt zu großen Teilen vermutlich auch damit zusammen, dass wir tendenziell lieber Neues schaffen, als Bestehendes zu reparieren. Man spricht auch von Builder und Mender Mentalitäten. Gleichzeitig erlaubt die Nutzung von KI-Tools eine ganz neue Art zu iterieren und Ideen auszuprobieren. Ein typischer Java oder C# Entwickler wird heutzutage auch nicht mehr Assembly Code schreiben wollen, auch wenn sich damit sicher das ein oder andere Prozent Performanz oder Speicheroptimierung erreichen ließe. Am Ende schreiben wir Software eben nicht als Selbstzweck und weil uns das Schreiben und Korrigieren von Quelltext so viel Freude bereitet. Letztlich zählt, welche Probleme sie löst, Möglichkeiten sie schafft und wie sie uns hilft unsere Ideen zu realisieren. 

Um Spaß und Erfolg mit AI-Coding zu haben, lohnt es sich deshalb einen Schritt zurückzugehen und den Blick auf das größere Ganze zu werfen. Ist es wichtig, dass ein Feature in meinem System immer genau so implementiert ist, wie ich es selbst hätte? Dann lohnt es sich diese Erwartung vorher genau zu spezifizieren und sich auf etwas Frust und Lernprozess einzustellen. Oft ist mein Weg nicht der einzig richtige und selten, der den auch ein Sprachmodell exakt befolgen wird, wenn ich ihn nicht genau so exakt beschreibe. Bin ich allerdings mehr am Komplettpaket meiner Software interessiert und daran, dass meine Module gut geschnitten und austauschbar bleiben, dann kann es auch völlig ok sein, übergangsweise eine Variante zu behalten, von der ich weiß, dass ich sie womöglich in den nächsten zwei Jahren nochmal neu schreiben lassen werde. Wie ändert sich meine Perspektive, wenn ich weiß, dass das ggf. nur ein einzelner Prompt und 5 Minuten meiner Arbeit erfordern wird und ich heute noch nicht weiß, wie und ob die Änderung notwendig sein wird? Deshalb wird es wichtiger als jemals zuvor technische Schulden stärker zu unterscheiden. 

Handelt es sich bei einer fraglichen Stelle in KI-generierten Code um einen Schönheitsfehler oder verhält es sich eher wie mit einem Fäulnisbefall, der sich ausbreitet, wenn nicht sofort gegengearbeitet wird? Öffnet ein Versäumnis des LLMs Tür und Tor für SQL Injection, Datendiebstahl oder sonstige geschäftskritische Vorfälle, oder hat sich mein state of the art LLM einfach nur an Standards gehalten, die letztes Jahr noch aktuell waren und heute als überholt gelten (z.b. keine Verwendung von Primärkonstruktoren in C#, *ngIf statt @if in angular, uvm.) und eher aus Konsistenzgründen zu vermeiden sind? Natürlich wollen wir beide Arten von Problemen vermeiden, sollten uns aber weniger in Diskussionen über Schönheitsfehler verlieren. Diese lassen sich im Übrigen auch immer besser durch Regelsätze im Systemprompt (z.b. als agents.md) reduzieren (siehe z.b. angular llm agent weblink) und durch die Eigenart von LLMs bestehende Muster fortzusetzen. Werden gute Muster im vorhandenen Code vorgegeben, reduziert das auch diese Diskrepanz zwischen erwarteter Lösung und KI-generierter. Die zahlreichen Berichte über Vibe-Coding Anwendungen mit kritischen Sicherheitsvorfällen und Datenverlust (hier links) zeigt allerdings auch, dass blindes Vertrauen im Hinblick auf KI-generierten Code ebenso wenig angebracht sind. Mein Appell ist vor allem, gesunden Pragmatismus bei der Bewertung von KI-Code anzuwenden. Wenn die penible Korrektur und Diskussion von Schönheitsfehlern wesentlich mehr Zeit in Anspruch nimmt als die eigentliche Implementierung, dann verpufft der Vorteil von GenAI für die Softwareentwicklung vermutlich sehr schnell und frustriert mehr als der Einsatz dieser Werkzeuge hilft. Hier einen guten Mittelweg zu finden bleibt auch weiterhin eine Herausforderung der nächsten Monate und Jahre.

Gleichzeitig braucht es eine bessere Tool-Integration, die bewährte Feedback-Schleifen und XP-Praktiken nutzt. Damit lassen sich die oben angedeuteten Probleme teilweise reduzieren. Automatisierte Tests auf verschiedenen Ebenen sind so wichtig wie eh und je, um das notwendige Sicherheitsnetz zu haben, damit LLMs nicht beiläufig fatale Fehler einbauen können. Gleichzeitig könnten wir die Entwicklung auch in komplexen Codebasen und für größere Features enorm beschleunigen, wenn wir den Modellen eine Chance geben, Features in kleinen Schritten zu implementieren.

Lokal auf Entwicklerrechnern betreibbare LLMs sind Stand Mitte 2025 leider noch nicht leistungsfähig genug, um damit Tools wie Aider derart anzutreiben, dass sie in größeren Projekten vergleichbaren Mehrwert liefern können wie die aktuellen Modelle von Anthropic, Google oder OpenAI. Allerding hat es auch in diesem Bereich enorme Fortschritte gegeben, zum Beispiel in Form von qwen2.5-coder:32b. Das kann trotz seiner deutlich geringeren Größe mit OpenAI Modellen mithalten und übertrifft diese teilweise in den Aider Benchmarks sogar. Die konkreten Fähigkeiten dieser kleinen Modelle bleiben in der Praxis leider oft hinter dem, was gängige Benchmarks andeuten.

Letztlich geht es hier vor allem auch darum, Bedenken bezüglich der Compliance und des Datenschutzes aus der Welt zu schaffen. Firmen vertrauen Cloud-Anbietern wie Azure oder AWS einerseits ausreichend, um ihren Code auf deren Servern zu speichern und ihre Dienste zu betreiben. Wenn es allerdings um die Verwendung von KI-Technologien geht, ist unser Misstrauen deutlich höher und wir fürchten, dass unsere Daten zu Trainingszwecken verwendet werden. Selbst SOC-2 Type 2 Compliance-Nachweise von Anthropic und OpenAI ändern wenig an der Sorge, dass Daten zum Training verwendet werden könnten. Gleichzeitig gibt es weiterhin viel Unsicherheit, welche Gefahren und Risiken bei der Verwendung von KI-Tools bezüglich Rechtsverletzungen bestehen. Damit bleibt für den Moment GitHub CoPilot und dessen Contractual protection für Firmen, die auf Nummer sicher gehen wollen ein attraktives Angebot, da hier GitHub bzw. Microsoft für Rechtsverletzungen durch generierten Code einstehen. Die spannende Frage ist: Wie lange können sich Unternehmen diese Zurückhaltung noch leisten? Die potenziellen Produktivitätsgewinne durch fortschrittlichere Tools sind erheblich. Die KI-gestützte Entwicklung steht noch am Anfang, aber die Richtung ist klar: 

Das Ziel besteht nicht darin, Entwickler zu ersetzen. Vielmehr können KI-Tools eine wertvolle Unterstützung für souveräne Entwickler sein, die - ganz im Sinne des Software Craftings - gerne noch effizienter werden möchten und dabei ihrem eigenen Qualitätsanspruch selbstverständlich treu bleiben.

Und dieser Ansatz ist es meiner Meinung nach wert, ausprobiert zu werden.