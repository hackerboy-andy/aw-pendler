# Pendler München ↔ Nürnberg

Statische PWA für die Pendelstrecke München Hbf ↔ Nürnberg Hbf mit dem
Deutschlandticket. Keine Eingabe, kein Backend — öffnen und die nächste
Abfahrt sehen.

## Warum diese API

Datenquelle ist die öffentliche [transitous.org](https://transitous.org)-Instanz
(MOTIS-API, `api.transitous.org`), nicht die DB direkt. Der ursprünglich
vorgesehene `v6.db.transport.rest`-Wrapper war zum Zeitpunkt der Umsetzung
nicht erreichbar (durchgängig 503 auf allen Daten-Endpunkten); dessen
Ersatz-Backend `db-vendo-client` nutzt inoffizielle, reverse-engineerte
DB-APIs, für die laut eigener Dokumentation ausdrücklich "permission is
necessary" gilt. transitous.org basiert dagegen auf offenen GTFS-Daten
(DELFI) mit offener CORS-Policy — direkt aus dem Browser nutzbar, kein
eigenes Backend nötig.

**Auflagen der [Nutzungsbedingungen](https://transitous.org/api/):**
- Open-Source-Veröffentlichung des Quellcodes (dieses Repo)
- nicht-kommerzielle, ressourcenschonende Nutzung
- Attribution-Link zu transitous.org/sources/ (siehe Footer der App)
- Kontaktinfo sichtbar (siehe Footer der App)

## Stationen

Verifiziert am 2026-09-01 über `GET /api/v1/geocode`:
- München Hbf → `de-DELFI_de:09162:100`
- Nürnberg Hbf → `de-DELFI_de:09564:510`

Das sind die DELFI-Parent-Stop-IDs (nicht die `at-Railway-...`-Alias-IDs aus
der Geocoding-Antwort) — MOTIS löst darüber automatisch die richtigen
Gleise/Plattformen auf, ohne einen künstlichen Umstiegs-Fußweg in die Route
einzufügen.

## Lokal starten

Kein Build-Schritt nötig. Einfach einen statischen Server im Ordner starten,
z. B.:

```bash
npx serve .
```

## Deploy auf Cloudflare Pages

```bash
npx wrangler pages deploy . --project-name=aw-pendler
```

Kein Build-Command, kein Output-Directory außer dem Repo-Root nötig — die
Dateien sind bereits deploybereit.

## Grenzen

- Nur die Relation München Hbf ↔ Nürnberg Hbf, keine anderen Verbindungen.
- Kein Ticketkauf, kein Login, keine Fahrtverfolgung.
- Echtzeitdaten hängen von der Datenlage bei transitous.org ab — bei
  Ausfall der API wird der letzte lokal gecachte Stand angezeigt.
