# Zusammenfassung  
Die **Codex CLI** bietet zwei Haupt-Anmeldeverfahren: die ChatGPT-OAuth-Anmeldung (Standard) und die Anmeldung per API-Schlüssel【27†L685-L693】【12†L2404-L2413】. Bei ChatGPT-Login speichert der CLI-Treiber Token in einer lokalen Datei (`~/.codex/auth.json`) oder im OS-Schlüsselbund【27†L754-L763】. Für automatisierte Abläufe empfiehlt OpenAI den API-Schlüssel (Environment-Variable `OPENAI_API_KEY`)【27†L699-L707】. Um zwischen mehreren ChatGPT-Plus-Konten zu wechseln, müssen Sie im Wesentlichen verschiedene `auth.json`-Dateien verwalten oder separate Codex-Profile (über unterschiedliche `CODEX_HOME`-Verzeichnisse) nutzen【21†L95-L100】【22†L14-L22】. Tools wie **codex-auth** oder **codex-profiles** automatisieren dies, indem sie benannte Schnappschüsse der `auth.json` anlegen【21†L95-L100】【22†L14-L22】. Sicherheit ist kritisch: Die Datei `auth.json` enthält sensible Tokens und muss mit starken Dateiberechtigungen (z.B. `0600`) gesichert werden【9†L297-L304】【27†L781-L783】. Multi-Faktor-Authentifizierung (MFA) auf den ChatGPT-Konten wird dringend empfohlen【27†L729-L737】. Beachten Sie die OpenAI-**Nutzungsbedingungen**: Das absichtliche Umgehen von Ratenlimits oder Schutzmaßnahmen – etwa durch ständiges Wechseln der Konten – kann untersagt sein【26†L90-L94】. 

## Detaillierte Erkenntnisse  

### Authentifizierungsverfahren & Tokenformate  
- **ChatGPT-Login (OAuth)**: Standard für die CLI. `codex login` startet einen Browser-Flow, der nach erfolgreicher Anmeldung ein JWT (Access- und Refresh-Token) in `~/.codex/auth.json` speichert【27†L754-L763】. Die Datei enthält JSON-Felder wie `id_token`, `access_token`, `refresh_token` und `account_id`【9†L281-L290】. Tokens werden automatisch aufgefrischt, typischerweise etwa nach 8 Tagen Nutzung【19†L695-L702】【27†L760-L764】. Bei Headless-Systemen kann man den **Device-Code-Flow** (`codex login --device-auth`) verwenden【6†L833-L842】. Alternativ kann ein vorhandenes ChatGPT-Access-Token via `CODEX_ACCESS_TOKEN` über STDIN eingelesen werden (Beispiel: `printenv CODEX_ACCESS_TOKEN | codex login --with-access-token`)【27†L694-L697】【6†L847-L855】.  
- **API-Schlüssel**: Einfachste Methode für Skripte. Man setzt `OPENAI_API_KEY` (oder `CODEX_API_KEY`) in der Umgebung oder piped den Schlüssel mit `codex login --with-api-key` ein【12†L2410-L2418】【9†L245-252】. API-Schlüssel führen zu ChatGPT-Standardtarifen und erfordern kein MFA【27†L699-L707】. Vorteil: kein lokaler Token-Cache nötig.  
- **Zugriffstoken (Enterprise)**: In ChatGPT Enterprise können Administratoren „Codex-Zugriffstoken“ erstellen. Diese statischen Tokens (ähnlich API-Schlüsseln) erlauben non-interaktive Logins und können via `codex login --with-access-token` eingesetzt werden【27†L714-L722】.  

### Gespeicherte Sitzungen und Wiederverwendung  
- **Speicherorte**: Standardmäßig nutzt die CLI `CODEX_HOME=~/.codex`. Darin liegen u.a. `auth.json` (Tokens) und `config.toml`【9†L333-L340】【27†L754-L763】. Unter Windows entspricht das `%USERPROFILE%\.codex`. macOS kann stattdessen den Keychain nutzen (je nach `cli_auth_credentials_store`)【9†L218-L227】【27†L775-L783】. Die Datei `auth.json` wird unter Unix mit Modus `0600` geschrieben【9†L297-L304】. Weitere Dateien: `CODEX_HOME/.credentials.json` (für MCP-Server), `CODEX_HOME/.env` (Environment-Overrides)【9†L333-L340】.  
- **Kopieren/Import**: Um Sitzungen zu teilen, kopieren Sie die `auth.json` eines eingeloggten Kontos in das `~/.codex` eines anderen Systems【6†L847-L855】. Beispiel:  
  ```bash
  # Browser-Login auf einem entwicklerfreundlichen Rechner
  codex login
  # anschließend:
  scp ~/.codex/auth.json user@remote:~/.codex/auth.json
  ```  
  Dabei gilt: **Behandeln Sie `auth.json` als Geheimnis** – teilen oder versionieren Sie es nicht【6†L847-L855】【27†L781-L783】.  
- **Profile / CODEX_HOME**: Alternativ können Sie für jedes Konto ein eigenes Codex-Home-Verzeichnis verwenden und den CLI über Umgebungsvariablen starten【22†L14-L22】【21†L95-L100】. Beispiel:  
  ```bash
  # Benutzung zweier Konten durch separates HOME:
  CODEX_HOME=~/.codex_konto1 codex ...
  CODEX_HOME=~/.codex_konto2 codex ...
  ```  
  Das isoliert `auth.json` und andere Daten pro Account. Tools wie **codex-profiles** (GitHub) automatisieren dies【22†L14-L22】.  
- **Konten-Manager (codex-auth)**: Open-Source-CLI `codex-auth` legt **Snapshots** von `auth.json` an (z.B. `~/.codex/accounts/NAME/auth.json`) und kann schnell zwischen diesen wechseln【21†L95-L100】【2†L324-L332】. Nach dem Wechsel sollte der Codex-Client neu gestartet werden, damit das neue Konto aktiv ist【2†L309-L317】. 

### CLI-Kommandos & Umgebungsvariablen  
- **codex login/logout**: Startet Browser- oder Device-Flow. Flags: `--device-auth` für Gerätecode, `--with-api-key` bzw. `--with-access-token` zum Einlesen aus stdin【12†L2402-L2413】. `codex login status` prüft, ob ein gültiges Login vorliegt (Exit-Code 0 bei vorhandenem Token)【12†L2472-L2475】. `codex logout` löscht gespeicherte Anmeldedaten【12†L2477-L2480】.  
- **Umgebungsvariablen**:  
  - `OPENAI_API_KEY`/`CODEX_API_KEY` – alternative API-Schlüssel-Quelle【9†L247-254】.  
  - `CODEX_ACCESS_TOKEN` – übernimmt ein ChatGPT-Access-Token.  
  - `CODEX_HOME` – überschreibt das Standard-`~/.codex` für Profile.  
  - `CODEX_CA_CERTIFICATE` – optionales TLS-Zertifikat für Unternehmensumgebungen【6†L810-L818】.  
  - `CODEX_REFRESH_TOKEN_URL_OVERRIDE` – (seltener) URL-Fallback für OAuth-Token-Refresh【9†L264-L270】.  
- **Konfiguration**: Die Datei `~/.codex/config.toml` kann z.B. `cli_auth_credentials_store = "file|keyring|auto"` setzen【27†L769-L778】. Unter `[login]` lassen sich erzwungene Login-Methoden definieren (z.B. nur ChatGPT oder API)【27†L785-L793】.  

### Datei- und Token-Formate  
- **auth.json** – JSON-Struktur (Beispiel【9†L283-L292】):  
  ```json
  {
    "auth_mode": "chatgpt",
    "OPENAI_API_KEY": null,
    "tokens": {
      "id_token": "...",
      "access_token": "...",
      "refresh_token": "...",
      "account_id": "..."
    },
    "last_refresh": "2026-05-24T12:00:00Z"
  }
  ```  
  (`auth_mode` kann auch `"apiKey"` oder `"chatgptAuthTokens"` sein).  
- **MCP/.credentials.json** – nur relevant bei Verwendung von Model Context Protocol (separates Credential-File).  
- **Config.toml** – Einstellungen wie `model_provider`, Verzeichnisse, feature-flags etc.  
- **.env-Datei** – Wird am Programmstart eingelesen (außer Variablen mit `CODEX_`-Präfix)【9†L325-L327】. Nützlich für API-Keys, um sie nicht im System-Environment hartzulegen.  

### Wechseln und Rotieren von Anmeldedaten  
- **Account-Switch**: Wie oben beschrieben durch Austausch von `auth.json` oder unterschiedlichen `CODEX_HOME`. Nach jedem Wechsel empfiehlt sich ein Neustart der Codex-CLI【2†L309-L317】. Tools wie `codex-auth switch NAME` automatisieren das Klonen/Rückwärtskopieren der Dateien【21†L95-L100】【2†L331-L340】.  
- **API-Keys rotieren**: Tauschen Sie den Schlüssel z.B. in Ihrem Shell-Profil oder geheimen Manager aus und führen `codex login --with-api-key` neu aus【12†L2414-L2423】. Verändern Sie ggf. `~/.codex/config.toml` entsprechend.  
- **Tokens erneuern**: Codex erneuert ChatGPT-Tokens automatisch bei Bedarf oder nach ~8 Tagen【19†L695-L702】. In CI-Umgebungen speichert man `auth.json` persistent und lässt Codex sie während der Ausführung auffrischen【19†L695-L702】【19†L773-L782】. Alternativ starten Sie bei abgelaufenem Token einfach `codex login` erneut.  
- **Session-Expiry**: Bei `401 Unauthorized` führt die CLI ebenfalls automatisch einen Refresh-Versuch durch【19†L699-L702】. 2FA (Multi-Faktor-Authentifizierung) auf dem ChatGPT-Konto verhindert unbefugten Zugriff und sollte zwingend aktiv sein【27†L729-L737】.  

> **Mermaid-Workflowdiagramm:** Wechsel zwischen Konten über gespeicherte Token.  
```mermaid
graph TD
  A[Terminal Start] --> B{Gespeichertes Konto auswählen}
  B --> |Account1| C[Setze CODEX_HOME=~/.codex_acc1]
  B --> |Account2| D[Setze CODEX_HOME=~/.codex_acc2]
  C --> E[codex login oder codex-auth use acc1]
  D --> F[codex login oder codex-auth use acc2]
  E --> G[Nutzen der Codex-CLI mit Konto1]
  F --> H[Nutzen der Codex-CLI mit Konto2]
  G --> I{Token abgelaufen?}
  H --> I
  I --> |Ja| J[codex login (erneut)]
  I --> |Nein| K[CLI beendet]
```

### Vergleichstabelle der Ansätze  

| Methode                        | Persistenz       | Sicherheitsrisiko                   | Scripting-**Aufwand**   | Sitzungs-Reuse | Anmerkungen                             |
|-------------------------------|------------------|-------------------------------------|-------------------------|---------------|-----------------------------------------|
| **API-Schlüssel (Env)**       | Hoch (bis Ausloggen) | Mittel (Schlüssel im Klartext)       | Sehr einfach (Env-Var)   | Ja            | Standard-API-Raten, kein MFA nötig【27†L699-L707】 |
| **ChatGPT-Token (Env)**       | Kurz (erfordert Refresh) | Hoch (Token  klebt im Speicher)   | Mittel (Token-Extraktion nötig) | Nein (Token neu generieren)| Nur Enterprise (Access Token) oder aus Browser【27†L694-L697】 |
| **auth.json kopieren**        | Mittel (manuell) | Sehr hoch (enthält alle Tokens)      | Moderat (cp/mv befehle)  | Ja            | Einfachstes Verfahren: *.json-Datei über Profile handhaben【21†L95-L100】 |
| **Separates CODEX_HOME**      | Hoch             | Hoch (mehrere auth.json-Dateien)    | Mittel (Env-Var setzen)  | Ja            | Jede `CODEX_HOME` mit eigenen Login-Daten【22†L14-L22】 |
| **codex-auth / codex-profiles** | Hoch           | Abhängig von Implementierung        | Niedrig (Tool übernimmt) | Ja            | Automatisiertes Profil-Management【21†L95-L100】【22†L14-L22】 |
| **OS-Schlüsselbund (Keyring)** | Hoch            | Niedrig (Keys gesichert im OS Store) | Mittel (Konfiguration)   | Ja            | Nur Apple/Windows (sys-keyring), CLI muss darauf konfiguriert sein【9†L213-L222】【27†L775-L783】 |
| **.env-Datei (im CODEX_HOME)**| Mittel          | Mittel (Datei könnte ausgelesen werden) | Einfach (setzt bei Start)| Ja            | Liegt im `CODEX_HOME`, lädt `OPENAI_API_KEY` automatisch【9†L306-L314】 |

### Sicherheitsempfehlungen und Checkliste  
- **Schutz der `auth.json`**: Speichern Sie Login-Daten nur auf **vertrauenswürdigen** Rechnern. Setzen Sie Dateiberechtigungen (`chmod 600 ~/.codex/auth.json`) und geben Sie die Datei niemals weiter【6†L847-L855】【9†L297-L304】.  
- **Vermeidung von Klartext-Keys**: Legen Sie `OPENAI_API_KEY` in geschützten Umgebungen an (z.B. `.env` im Home-Verzeichnis) statt in Skripten. Nutzen Sie Secret-Manager wo möglich.  
- **Nutzung von MFA**: Aktivieren Sie **Multifaktor-Authentifizierung** für alle ChatGPT-Konten【27†L729-L737】. Bei Social-Login-Angeboten (Google/Microsoft/Apple) sollten die jeweiligen MFA-Optionen genutzt werden.  
- **Regelmäßige Rotation**: Wechseln Sie API-Schlüssel und Zugriffstoken regelmäßig und widerrufen Sie alte Tokens. Planen Sie eine Wartung (z.B. wöchentlich) ein, um abgelaufene `auth.json` automatisch durch ein Frischmelden zu ersetzen【19†L813-L822】.  
- **Zugriffsverwaltung**: Nutzen Sie, wenn möglich, den Betriebssystem-Keyring statt Datei-Speicherung (`cli_auth_credentials_store = "keyring"`)【27†L775-L783】. Auf Servern ohne GUI verwenden Sie den Device-Code-Flow oder kopieren vorab per `scp` das Token.  
- **Keine Umgehung von Limits**: Vermeiden Sie Skripte, die Konten zyklisch wechseln, um Nutzungsbegrenzungen zu umgehen – dies kann laut OpenAI-ToS als Umgehung von **Ratenlimits** gelten【26†L90-L94】.  
- **Update der CLI**: Halten Sie die Codex-CLI auf aktuellem Stand, da Sicherheits- oder Auth-Verbesserungen (z.B. Device-Flow) nachgeliefert werden. Prüfen Sie Versionshinweise von OpenAI.  

### Offizielle Quellen und Community-Ressourcen  
1. **OpenAI Codex-Dokumentation:** „Authentication – Codex“ (Offizielle Anleitung zu Login-Methoden, Token-Handling)【27†L754-L763】【6†L847-L855】.  
2. **OpenAI-Dev-Blog:** „Maintain Codex account auth in CI/CD (advanced)“ (Tipps für frische Tokens und `auth.json`-Management)【19†L695-L702】【19†L813-L822】.  
3. **Offizielles CLI-Referenzhandbuch:** Kommando-Referenz für `codex login/logout`, Flags und Konfigurationsoptionen【12†L2402-L2413】【27†L754-L763】.  
4. **GitHub „codex-auth“ (Loongphy):** Community-CLI zum Wechseln von Konten【21†L95-L100】【2†L324-L332】.  
5. **OpenAI Community:** Thread „codex-profiles“ – Anleitungen, wie man mit `CODEX_HOME` isolierte Profile erstellt【22†L14-L22】.  
6. **Reddit & Foren:** Nutzerberichte und Lösungsansätze (z.B. Profile-Switching, Device-Auth-Issues)【21†L95-L100】【14†L225-L234】.  
7. **Agent Safehouse Blog:** Technische Analyse der Codex-CLI (Credential-Speicherorte, JSON-Formate)【9†L279-L288】【9†L333-L340】.  
8. **OpenAI Terms of Use:** Offizielle Nutzungsbedingungen, u.a. §“Using our Services” mit Verbot von „Umgehung von Ratenlimits“【26†L90-L94】【26†L65-L73】.  

**Tabelle:** Übersicht der Ansätze (Methode, Persistenz, Risiko, Skriptbarkeit, Sitzungs-Reuse) – siehe oben.  

Bitte prüfen Sie immer die aktuellsten OpenAI-Dokumente und Community-Updates, da sich die CLI-Funktionen rasch weiterentwickeln. Die oben genannte Lösungslage gilt für einen “unbestimmten” Codex CLI Release und gängige Betriebssysteme (bei Bedarf explizit die Pfade unter Windows (`%USERPROFILE%\.codex`) statt `~/.codex` anpassen).