# VBG Website

Organisationstool für den **Busbetrieb VBG**:
Shifts mit Dutys (Fahrten + Halte), **linienbasierte Lizenzen** (19, (SB) 24, 8, N1),
**Shiftplan** mit Zuteilung (Dutys + Einzelfahrten), Shift-Anmeldungen mit von–bis-Zeiten,
**Strafstunden-System**, Activity/Anwesenheit, Kundenservice-Anmeldungen,
Supervisor-Nachrichten (auch dringend) und Fahrzeugübersicht mit
supervisor-gesteuertem Status.

## Tech-Stack

| Teil | Technik | Hosting |
|---|---|---|
| Frontend | HTML, CSS, Vanilla JS (SPA) | **Cloudflare Pages** (unbegrenzte Bandbreite), alternativ GitHub Pages |
| Backend/API | Node.js + Express | Render |
| Daten | `data.json` (JSON-Datei, atomar geschrieben) | Render-Disk |

## Funktionen

- **Login** mit *"Angemeldet bleiben"* (Token 30 Tage im localStorage)
- **Rollen:** Supervisor · Senior Busfahrer · Busfahrer
- **Linien-Lizenzen (Start):** 19 (Stümp Voiskamp ↔ Gravenberg ZOB, Solo),
  (SB) 24 (Sorenkoppel ↔ Gravenberg ZOB, Gelenk/Solo), 8 (Bf. Gravenberg ↔ Bergdorf, Solo),
  N1 (Gravenberg ZOB ↔ Sorenkoppel, Gelenk, Nacht). Wer eine Linie besitzt, kann
  Dutys dieser Linie fahren – unabhängig vom konkreten Fahrzeug.
- **Wiederverwendbarer Tagesplan:** `seed/generate-day.js` erzeugt einen
  ganztägigen Plan (25 Fahrzeuge, 10 Dutys, 4 Linien) ohne festes Datum.
  Per Klick „Als Shift übernehmen" wird er für einen Wochentag kopiert.
- **Linienwechsel** sind als Hinweis an Dutys hinterlegt (z.B. „Umlauf kann am
  GVZ auf Linie 19 wechseln").
- **Shifts mit von–bis-Uhrzeit** (Start/Ende), Dutys je Shift. Neue Shifts werden
  per Häkchen automatisch aus dem Tagesplan befüllt.
- **Shiftplan:** pro Shift eine Planansicht mit Dutys (Kurs, Fahrzeiten, Pausen,
  Leerfahrten als erste/letzte Fahrt, Haltestellen). Supervisor vergibt **Host +
  bis zu 2 Co-Supervisoren**, teilt Dutys und Einzelfahrten zu (mit Fahrzeugwahl)
  und kann Zeiten, Haltestellen und Ausfälle verwalten; **Konfliktprüfung**
  verhindert zeitliche Überschneidungen.
- **Shift-Anmeldungen mit von–bis-Zeiten:** Busfahren (min. 75 min) oder
  **Kundenservice** (min. 30 min, Standort wählbar) – pro Person und Shift nur
  eine Funktion. **Ab 3 Strafstunden** ist nur noch Kundenservice erlaubt.
  Supervisor nimmt an/ab und teilt danach manuell Dutys zu (mit Lizenzprüfung).
- **Duty-Wünsche** nur bei passender Linien-Lizenz; Supervisor nimmt an/ab.
- **Strafstunden-System:** Warnungen als Strafstunden + Frist. **Ab 20 ist die
  Kündigung gefährdet** (rot markiert, „Kündigung droht"), ab 3 nur noch
  Kundenservice. Fortschritt wird supervisorseitig gepflegt.
- **Activity/Anwesenheit:** Fahrer melden sich ein/aus; Activity = **60 % der
  reinen Fahrzeit**. Übersicht pro Nutzer (Zeitraum Woche/Monat/Jahr/Alle) und
  über alle Nutzer.
- **Supervisor-Nachrichten:** an Busfahrer/Senioren/Supervisoren, optional
  **dringend** (= rotes Overlay mit 10 s-Sperre + Warnton + Banner).
- **Fahrzeugübersicht für alle Rollen**: Wagennummer, Kennzeichen, Typ, Standort,
  Einsatzstatus (kein Einsatz / eingeplant / im Einsatz), geplante Dutys.
  Der **Status** (einsatzbereit / nicht einsatzbereit / Sonderfahrzeug /
  Ersatzwagen / Fahrschule / Reserve) ist **nur durch den Supervisor** änderbar.
- **Strafstunden-System** (siehe oben): Warnungen mit Stundenzahl + Frist werden
  supervisorseitig gepflegt.
- **Supervisor-Bereich mit Untertabs:** Nutzer · Linien & Lizenzen · Anmeldungen ·
  Activity.
- **Benachrichtigungen:** In-App-Box + Desktop-Toggle (Polling alle 20 s).
- **Gerätesperre:** läuft nur auf Windows-/Linux-PCs, Surfaces und Laptops –
  Konsolen und Handys werden blockiert.
- **Account:** Sprache (DE/EN), Discord, Roblox-Name mit 6-Monats-Sperre nach
  Änderung, Zuteilungen.

## Lokal starten

```bash
npm install
npm start          # -> http://localhost:3000
```

Wiederverwendbaren Tagesplan (neu) generieren:

```bash
node seed/generate-day.js   # schreibt seed/duties.json
```

Login: Der **fest verankerte Supervisor** ist automatisch eingerichtet:
- **Benutzername:** `jggaming2518` · **Passwort:** `Jlg161218MGB!`

Dieser Nutzer wird aus dem Code (`server/db.js`) bei **jedem** Start garantiert
angelegt (überlebt auch Daten-Resets) und ist **unlöschbar + nicht sperrbar**.

> **Komplette Schritt-für-Schritt-Anleitung (GitHub + Render + Pages +
> erster Supervisor): `SETUP-ANLEITUNG.md`**

## Daten & Seed

`seed/duties.json` enthält den wiederverwendbaren Tagesplan und wird beim
Serverstart automatisch importiert (Umgebungsvariable `SEED_FILE=seed/duties.json`),
wenn der Shift `tpl-tagesplan` noch fehlt – idempotent, auch auf Bestandsinstallationen
nachrüstbar. Ein Reset/Redeploy ist damit unproblematisch.

## Deploy

> **Health/Monitoring:** `GET /api/health` und `GET /healthz` ohne Login –
> genutzt von Render-Healthcheck und UptimeRobot.

### 1. Render (Backend + Daten)

`render.yaml` ist fertig konfiguriert. Auf [render.com](https://render.com) →
**New → Blueprint → Repo auswählen** → Deploy.
Wichtigste Environment-Variablen:

- `JWT_SECRET` – langes, geheimes Zufallspasswort
- `DATA_FILE` – optional, z.B. `/var/data/data.json`
- `SEED_FILE` – `seed/duties.json` (Tagesplan automatisch einspielen)
- `DISCORD_WEBHOOK_URL` – optional, Discord-Webhook für das Login-Log (Erfolg **und**
  Fehlversuche werden als Embed in den Channel gepostet). Mehrere Webhooks durch
  Komma getrennt. **Niemals ins Frontend (`public/`) schreiben** – die URL ist ein
  Geheimnis und würde sonst im Klartext an jeden Besucher ausgeliefert.
  Fehlversuche sind pro Benutzer+IP auf 1 Meldung / 5 Minuten gedrosselt.

### 2. Frontend (Cloudflare Pages – empfohlen)

Das Frontend ist eine reine statische SPA und liegt deshalb am besten auf
**Cloudflare Pages**: im Free-Tarif ist die **statische Bandbreite unbegrenzt**,
unlimited SSL ist dabei. Damit fließt über den Render-Workflow nur noch JSON,
nicht mehr das Frontend.

In `public/config.js` die Render-URL eintragen (`window.VBG_API_BASE`, ist bereits
auf `https://vbg-website.onrender.com` gesetzt). Dann auf
[Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages → Create →
Pages → Connect to Git**:

| Einstellung | Wert |
| --- | --- |
| Framework preset | None |
| Build command | *(leer lassen)* |
| Build output directory | `public` |
| Node.js version | *(wird nicht benötigt)* |

Es ist **kein Build-Schritt** nötig, `public/` wird direkt ausgeliefert. Anschließend
im Pages-Projekt unter **Custom domains** die eigene Domain eintragen; DNS und
Zertifikat übernimmt Cloudflare.

Zwei Konfigurationsdateien in `public/` steuern das Verhalten:

- `_headers` – Cache-Regeln. `app.js`/`style.css` sind nicht fingerprinted und
  werden deshalb nur revalidiert (`max-age=0, must-revalidate`): Der Browser holt
  beim nächsten Aufruf einen 304, überträgt aber keine Datei erneut. `config.js`
  und `sw.js` stehen auf `no-store`, damit alte API-URLs und alte
  Service-Worker-Versionen nicht hängen bleiben.
- `_redirects` – bewusst **ohne** SPA-Fallback. Die App nutzt kein
  History-Routing, fehlende Dateien sollen als 404 enden.

**CORS ist bereits passend:** `server.js` ruft `app.use(cors())` ohne
Origin-Beschränkung, und der Browser sendet `Authorization: Bearer` ohne
Credentials. Eine andere Frontend-Origin (`*.pages.dev`, eigene Domain) darf die
API daher direkt ansprechen.

**Warum das Backend auf Workers Free nicht in Frage kommt:** dort sind 10 ms
CPU-Zeit pro Aufruf erlaubt, ein `bcrypt`-Vergleich braucht aber 90–130 ms. Dazu
gibt es kein beschreibbares Dateisystem für `data.json`. Die API bleibt darum auf
Render (siehe Kompression unten).

### 3. GitHub Pages (Alternative)

Funktioniert weiterhin: **Settings → Pages → Source: „GitHub Actions"**. Der
Workflow `.github/workflows/pages.yml` veröffentlicht `public/` bei jedem Push auf
`main`. Limit: 100 GB/Monat statt unbegrenzt.

### Bandbreite des Backends (Render)

Render Free (Hobby) liefert seit 23.04.2026 **5 GB/Monat** inklusive, danach
$0,15/GB. Ohne hinterlegte Zahlungsmethode wird der Service bei Überschreitung
**suspendiert** – mit Karte wird der Überhang abgerechnet.

`server.js` setzt `compression` (gzip/Brotli) mit Schwelle 512 Byte. Für reine
JSON-Antworten wirkt das stark:

| | ohne Kompression | mit Kompression |
| --- | --- | --- |
| `/api/applications` | 25.396 B | 1.419 B (−94 %) |
| `/api/shifts` | 12.474 B | 514 B (−96 %) |
| **Summe eines vollen Syncs** | **56,0 KB** | **3,1 KB (−94,5 %)** |

**Der eigentliche Verbraucher waren jedoch die Profilbilder.** `publicUser()`
hatte das Avatar-Bild als Base64-Data-URL in *jede* Nutzerliste eingebettet, und
diese Serializer-Funktion wird an 11 Stellen verwendet. Bei vier Nutzern mit drei
Bildern (Ø 202 KB, größtes 340 KB) wurde ein einzelner `/api/users`-Aufruf
**605 KB** groß – davon waren **99,9 %** Base64. Die 5 GB waren damit nach
**8.657 Aufrufen** von `/api/users` erreicht, nicht nach Millionen.

Gzip allein half nur wenig: Base64 ist Hochentropie, die Kompression brachte
gerade **24,7 %** (605,6 KB → 455,8 KB).

Deshalb liefert `publicUser()` jetzt nur noch `hasAvatar: true`. Die Bilddaten
holt der Client einmalig über den geschützten Endpunkt

```
GET /api/avatar/:id          (requireAuth)
  Cache-Control: private, max-age=2592000
  ETag: <sha1 des Bildes>    -> 304 statt 200 KB bei Revalidierung
```

Das Frontend lädt das Bild per `fetch()` mit Token als Blob, hält eine
Object-URL pro Sitzung und lässt die Initialen stehen, bis es da ist. Schlägt
der Abruf fehl, bleibt der Buchstaben-Kreis stehen.

Gemessen mit echten Produktionsbildern:

| | vorher | nachher |
| --- | --- | --- |
| `/api/users` (4 Nutzer, 3 Bilder) | 605,6 KB | **4,5 KB** |
| gzip davon | 455,8 KB | 0,5 KB |

Hochrechnung 15–20 Nutzer × 50–70 Aufrufe/Tag:

| Szenario | Aufrufe/Monat | Verbrauch | Anteil am 5-GB-Limit |
| --- | --- | --- | --- |
| 15 Nutzer × 50 | 22.500 | ~16 MB | 0,3 % |
| 18 Nutzer × 60 | 32.400 | ~22 MB | 0,4 % |
| 20 Nutzer × 70 | 42.000 | ~28 MB | 0,5 % |

**Wichtig für neue Felder:** Wer Binärdaten (Bilder, PDFs) in `data.json`
speichert, darf sie nicht in Listen-Serialisern einbetten. Entweder ein Flag
zurückgeben und über einen eigenen Endpunkt mit Cache-Header ausliefern, oder
extern ablegen.

## Projektstruktur

```
server/            Express-API (Auth, Nutzer, Linien, Shifts/Dutys, Anmeldungen, Wünsche, Warns, Fahrzeuge)
  server.js        alle Routen + Middleware (+ Health-Endpoints)
  db.js            JSON-Datenspeicher (data.json) + Migration + geschützter Supervisor + Tagesplan-Import
seed/
  generate-day.js  erzeugt den wiederverwendbaren Tagesplan (seed/duties.json)
  duties.json      Tagesplan-Daten (Shift tpl-tagesplan)
public/            Frontend (SPA)
  index.html, style.css, app.js, api.js, config.js, manifest.webmanifest
  _headers, _redirects   Cloudflare-Pages-Regeln (Cache + Rewrites)
render.yaml        Render-Blueprint
.github/workflows/pages.yml   GitHub-Pages-Deploy (Alternative)
data.json          Daten (wird automatisch angelegt)
```

## Sicherheits-Hinweis

- Passwörter werden mit bcrypt gehasht, Tokens sind JWT.
- `JWT_SECRET` in Produktion unbedingt setzen!
- Nur der **Supervisor** darf Nutzer/Lizenzen/Warnungen verwalten und zuteilen.
  Fahrer sehen alles lesend und können nur wünschen oder sich für Shifts anmelden.