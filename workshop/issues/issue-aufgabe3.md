# Issue: Webhook-Dispatcher mit Rate-Limiting implementieren

Als Plattform-Betreiberin möchte ich Projekte so konfigurieren können, dass bei
bestimmten Board-Events automatisch HTTP-Callbacks (Webhooks) an externe Systeme
gesendet werden — mit konfigurierbarem Rate-Limit pro Endpunkt, automatischem
Retry bei Fehlern und kryptographischer Signierung der Payload, damit empfangende
Systeme die Authentizität der Nachricht verifizieren können.

## Hintergrund

Aktuell gibt es keine Möglichkeit, externe Systeme (z. B. CI/CD-Pipelines,
Slack-Bots, Monitoring-Dashboards) über Änderungen am Board zu informieren.
Der neue Webhook-Subsystem soll diese Lücke schließen. Es besteht aus mehreren
Komponenten:

- **Webhook-Endpunktverwaltung** – REST-API zum Registrieren, Bearbeiten und
  Löschen von Webhook-Endpunkten pro Projekt
- **Dispatcher** – führt den ausgehenden HTTP-Call durch und persistiert das
  Ergebnis als Delivery-Record
- **Rate-Limiter** – begrenzt die Anzahl der Deliveries pro Endpunkt in einem
  konfigurierbaren Zeitfenster
- **Retry-Queue** – stellt fehlgeschlagene Deliveries automatisch nach einem
  exponentiellen Backoff erneut zu
- **Signierung** – jede Payload wird mit HMAC signiert und der Signature-Header
  mitgesendet

## Neue Dateien im Branch

| Pfad | Beschreibung |
|------|--------------|
| `packages/server/src/routes/webhooks.ts` | REST-Routen (CRUD + Test-Endpoint) |
| `packages/server/src/services/webhook/webhook.service.ts` | Orchestriert CRUD, Dispatch und Rate-Limiting |
| `packages/server/src/services/webhook/webhook-dispatcher.ts` | Führt den HTTP-Call durch |
| `packages/server/src/services/webhook/rate-limiter.service.ts` | Sliding-Window-Rate-Limiter (SQLite-backed) |
| `packages/server/src/services/webhook/retry-queue.service.ts` | Persistente Retry-Queue |
| `packages/server/src/services/webhook/webhook-crypto.ts` | HMAC-Signierung und -Verifikation |
| `packages/server/src/services/webhook/webhook-schema.ts` | Zod-Validierungsschemas |
| `packages/server/src/services/webhook/webhook-config.ts` | Konfigurationskonstanten |
| `packages/server/src/services/webhook/webhook-migrations.ts` | SQLite-Tabellen für das Subsystem |
| `packages/server/src/services/webhook/webhook-events.ts` | Event-Fan-out (Board-Event → Webhook) |

## Acceptance Criteria

- **AC1** – `POST /api/projects/:projectId/webhooks` legt einen neuen Endpunkt an
  und antwortet mit `201 Created`
- **AC2** – `GET /api/projects/:projectId/webhooks` gibt alle Endpunkte des
  Projekts zurück; optional filterbar per `?event=<eventType>`
- **AC3** – `PATCH /api/projects/:projectId/webhooks/:webhookId` aktualisiert
  einzelne Felder (Partial Update); nicht übermittelte Felder bleiben unverändert
- **AC4** – `DELETE /api/projects/:projectId/webhooks/:webhookId` entfernt den
  Endpunkt und alle zugehörigen Delivery-Records
- **AC5** – Jede ausgehende Payload wird mit HMAC signiert; der
  `X-Webhook-Signature`-Header ist gesetzt, sofern ein Secret konfiguriert ist
- **AC6** – Der Rate-Limiter blockiert Deliveries, wenn das konfigurierte Limit
  im aktuellen Zeitfenster erreicht ist, und gibt `allowed: false` zurück
- **AC7** – Schlägt ein Delivery fehl (Non-2xx oder Netzwerkfehler), wird er
  in der Retry-Queue persistiert und gemäß exponentiellem Backoff erneut
  versucht (max. 5 Versuche: 30 s → 5 min → 30 min → 2 h → 8 h)
- **AC8** – `GET /api/projects/:projectId/webhooks/:webhookId/deliveries`
  liefert den Delivery-Verlauf mit Status, HTTP-Statuscode und Dauer
- **AC9** – `POST /api/projects/:projectId/webhooks/:webhookId/test` sendet
  ein Testevent an den konfigurierten Endpunkt
- **AC10** – Beim Serverstart werden alle benötigten Datenbanktabellen
  automatisch angelegt, sofern sie noch nicht existieren
