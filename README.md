# VBG Website

Organisationstool für **FDL & TF** (Railway-Community):
Shifts mit Dutys (Fahrten + Halte), Lizenzen (Stellwerke / Fahrzeuge),
Zuteilung mit Wunsch-System, Benachrichtigungen (Desktop + In-App) und
Fahrzeugübersicht.

## Tech-Stack

| Teil | Technik | Hosting |
|---|---|---|
| Frontend | HTML, CSS, Vanilla JS (SPA) | GitHub Pages **oder** Render |
| Backend/API | Node.js + Express | Render |
| Daten | `data.json` (JSON-Datei, atomar geschrieben) | Render-Disk |

## Funktionen

- **Login** mit *"Angemeldet bleiben"* (Token 30 Tage im localStorage)
- **Rollen:** Supervisor (verwaltet alles) und normale Nutzer (FDL/TF)
- **Lizenzen:**
  - FDL → Stellwerke (Start: AK, STB, NS, BHBF) – Supervisor kann beliebig viele anlegen
  - TF → Fahrzeuge (Start: 628, 429, 245 (Dosto)) – beliebig erweiterbar
  - Beim **Anlegen** eines Nutzers wählt der Supervisor Lizenzen direkt aus,
    nachträglich können jederzeit Lizenzen ergänzt/geändert werden
  - Konten können **gesperrt** und **gelöscht** werden
- **Shifts & Dutys:**
  - Erst Shift anlegen, dann Dutys je Shift
  - Duty = mehrere **Fahrten**, Fahrt = mehrere **Halte**
  - Dutys zeigen zusätzlich **Einheit** (z.B. 628 001) und **Dienstzeit** (Anfang–Ende)
  - Fahrten können **mit Vermerk entfallen** (einzelne Fahrt **oder** ganze Duty)
  - Halte einzelner Fahrten können gestrichen werden
  - Fahrzeug der Duty ist **einzeln pro Fahrt** oder **für alle Fahrten** änderbar
- **Zuteilung:** Fahrer können Dutys **wünschen** – nur mit passender TF-Lizenz.
  Supervisor nimmt an/lehnt ab oder weist direkt zu.
- **Benachrichtigungen:** In-App-Box oben rechts (links vom Nutzer-Menü) +
  **Desktop-Benachrichtigungen** (Browser-Notification), Polling alle 30 s
- **Fahrzeugübersicht:** Status aller Fahrzeuge automatisch aus allen Dutys
  berechnet (Einsätze, Zeitfenster, **Spawnpunkt bei Serverstart**), shiftunabhängig.

## Lokal starten

```bash
npm install
npm start          # -> http://localhost:3000
```

Startdaten (Dutys aus dem Organisationsplan) einspielen:

```bash
npm run seed       # liest automatisch die neueste "TF duty*s.html" aus dem Temp-Ordner
# oder mit explizitem Pfad:
node server/seed.js "C:\Pfad\zu\Dutys.html"
```

Das Seed-Skript legt den Shift **"Organisationsplan"** mit ~39 Dutys und 382 Fahrten
an (Duty 32 fehlt in der Quelldatei). Erneutes Ausführen ist wirkungslos, solange
schon geseedete Dutys existieren – zum Neu-Seeden `data.json` löschen.

Login: Der **fest verankerte Supervisor** ist automatisch eingerichtet:
- **Benutzername:** `jggaming2518` · **Passwort:** `Jlg161218MGB!`

Dieser Nutzer wird aus dem Code (`server/db.js`) bei **jedem** Start garantiert
angelegt (überlebt auch Daten-Resets) und ist **unlöschbar + nicht sperrbar**
(im Backend hart gesperrt, in der Oberfläche als „geschützt" markiert).

Danach unter `http://localhost:3000` einloggen und über *Nutzer → + Nutzer
anlegen* weitere Konten mit Lizenzen erstellen.

> **Komplette Schritt-für-Schritt-Anleitung (GitHub + Render + Pages +
> UptimeRobot + erster Supervisor): `SETUP-ANLEITUNG.md`**

## Deploy

> **Health/Monitoring:** Die API stellt Endpunkte zum Überwachen bereit:
> `GET /api/health` (Infos + Duty-Anzahl) und `GET /healthz` (kurz: `{"ok":true}`).
> Beide brauchen **kein Login** und sind genau der Weg, den Render-Healthcheck
> und UptimeRobot nutzen – so bleibt der freie Plan wach und Ausfälle werden erkannt.

### 1. Render (Backend + Daten)

**Variante A – Blueprint (empfohlen):** Die Datei `render.yaml` im Repo ist schon
fertig konfiguriert (inkl. automatisch generiertem `JWT_SECRET` und Healthcheck).
Auf [render.com](https://render.com) → **New → Blueprint → Repo auswählen** → Deploy.

**Variante B – manuell:**
1. Repo auf GitHub pushen.
2. Auf [render.com](https://render.com): **New → Web Service → Repo auswählen**.
3. Einstellungen:
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`
4. **Environment Variables:**
   - `JWT_SECRET` – langes, geheimes Zufalls-Passwort (wichtig für Logins)
   - `DATA_FILE` – optional, z.B. `/var/data/data.json`
   - `PORT` – wird von Render automatisch gesetzt
5. Fertig → URL wie `https://vbg-website.onrender.com` – `.../api/health`
   wird nach dem ersten Deploy `{"ok":true}` liefern.

> **Hinweis Datenhaltung:** Render (kostenloser/dünner Plan) hält den Disk
> meist dauerhaft, setzt ihn aber bei *Redeployment* zurück. Für echten
> produktiven Betrieb: Plan mit persistentem Disk wählen oder ein DB-Add-on
> (z.B. Supabase) anschließen. Die `data.json` wird von jeder Änderung atomar
> neu geschrieben. Die geseedeten Dutys liegen zusätzlich committet in
> `seed/duties.json` und werden beim Serverstart **automatisch importiert**
> (Umgebungsvariable `SEED_FILE=seed/duties.json`), sobald keine Daten da sind –
> ein Reset/Redeploy ist damit unproblematisch.

### 2. GitHub Pages (Frontend)

Die App wird komplett automatisch deployt – in `public/config.js` zuerst die
Render-URL eintragen:
```js
window.VBG_API_BASE = "https://vbg-website.onrender.com";
```

Dann in GitHub: **Settings → Pages → Source: „GitHub Actions"**. Der Workflow
`.github/workflows/pages.yml` baut bei jedem Push auf `main` den Inhalt von
`public/` und veröffentlicht ihn unter deiner Pages-URL. Die App redet dann mit
der API auf Render.

(Alternativ: Frontend direkt via Render ausliefern lassen – geht automatisch,
`public/` wird vom Express-Server mit ausgeliefert.)

### 3. UptimeRobot (Uptime-Bot/-Monitor)

Render quollt bei freien Plänen nach ~15 min in den Schlaf, der erste Request
braucht dann ~30–60 s. Mit UptimeRobot wach halten und Ausfälle melden:

1. [uptimerobot.com](https://uptimerobot.com) → **New Monitor**
2. **HTTP(s)**, URL `https://vbg-website.onrender.com/api/health`,
   Interval z.B. 5 min, Timeout 30 s
3. Optional: **Alert Contacts**, um bei Ausfall E-Mail/Discord/Telegram zu
   benachrichtigen (lettuces, kann aber nicht von hier eingerichtet werden).
4. Fertig – der Monitor pingt den Health-Endpoint und hält den Service wach.
   Erwartete Antwort: HTTP 200 + `{"ok":true}`.

## Projektstruktur

```
server/            Express-API (Auth, Nutzer, Lizenzen, Shifts/Dutys, Wünsche, Notifications, Fahrzeuge)
  server.js        alle Routen + Middleware (+ Health-Endpoints /api/health, /healthz)
  db.js            JSON-Datenspeicher (data.json)
  seed.js          Importiert die realen Dutys aus der Google-Sheets-HTML (npm run seed)
public/            Frontend (SPA)
  index.html       Seite
  style.css        Styles (dunkles Design)
  app.js           komplette App-Logik
  api.js           Fetch-Wrapper + Token-Handling ("Angemeldet bleiben")
  config.js        API-Basis-URL (für Pages setzen)
  manifest.webmanifest  PWA-Metadaten (Desktop-Notifications)
render.yaml        Render-Blueprint (Auto-Deploy des Backends)
.github/workflows/pages.yml   GitHub-Pages-Deploy des Frontends
data.json          Daten (wird automatisch angelegt)
```

## Sicherheits-Hinweis

- Passwörter werden mit bcrypt gehasht, Tokens sind JWT.
- `JWT_SECRET` in Produktion unbedingt setzen!
- Nur der **Supervisor** darf Nutzer verwalten, Lizenzen anlegen, Shifts/Dutys
  bearbeiten und zuteilen. Fahrer sehen alles lesend und können nur **wünschen**.