# VBG Website

Organisationstool für den **Busbetrieb VBG**:
Shifts mit Dutys (Fahrten + Halte), **linienbasierte Lizenzen** (19, (SB) 24, 8, N1),
Shift-Anmeldungen mit manueller Zuteilung, Wunsch-System, Warn-System und
Fahrzeugübersicht mit supervisor-gesteuertem Status.

## Tech-Stack

| Teil | Technik | Hosting |
|---|---|---|
| Frontend | HTML, CSS, Vanilla JS (SPA) | GitHub Pages **oder** Render |
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
- **Shifts mit von–bis-Uhrzeit** (Start/Ende), Dutys je Shift.
- **Shift-Anmeldungen:** Fahrer melden sich mit einer Nachricht an → Supervisor
  nimmt an/ab und teilt danach manuell Dutys zu (mit Lizenzprüfung).
- **Duty-Wünsche** nur bei passender Linien-Lizenz; Supervisor nimmt an/ab.
- **Fahrzeugübersicht für alle Rollen**: Wagennummer, Kennzeichen, Typ, Standort,
  Einsatzstatus (kein Einsatz / eingeplant / im Einsatz), geplante Dutys.
  Der **Status** (einsatzbereit / nicht einsatzbereit / Sonderfahrzeug /
  Ersatzwagen / Fahrschule / Reserve) ist **nur durch den Supervisor** änderbar.
- **Warn-System:** Warnungen mit Stundenzahl + Frist; **ab 3 Stunden muss
  abgearbeitet werden** (Fortschritt wird gepflegt).
- **Supervisor-Bereich mit Untertabs:** Nutzer · Linien & Lizenzen · Wünsche ·
  Anmeldungen · Warnungen.
- **Benachrichtigungen:** In-App-Box + Desktop (Polling alle 30 s).

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

### 2. GitHub Pages (Frontend)

In `public/config.js` die Render-URL eintragen (`window.VBG_API_BASE`). Dann in
GitHub: **Settings → Pages → Source: „GitHub Actions"**. Der Workflow
`.github/workflows/pages.yml` veröffentlicht `public/` bei jedem Push auf `main`.

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
render.yaml        Render-Blueprint
.github/workflows/pages.yml   GitHub-Pages-Deploy
data.json          Daten (wird automatisch angelegt)
```

## Sicherheits-Hinweis

- Passwörter werden mit bcrypt gehasht, Tokens sind JWT.
- `JWT_SECRET` in Produktion unbedingt setzen!
- Nur der **Supervisor** darf Nutzer/Lizenzen/Warnungen verwalten und zuteilen.
  Fahrer sehen alles lesend und können nur wünschen oder sich für Shifts anmelden.