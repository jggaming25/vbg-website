# Einrichtungs-Anleitung: VBG Website komplett live setzen

Diese Anleitung richtet die **VBG Website** komplett ein:
**lokal testen → GitHub-Repo → Render (Backend) → GitHub Pages (Frontend) →
UptimeRobot (Status-/Wachhalte-Monitor) → Nutzer & Lizenzen.**

Alles ist im Projekt bereits vorbereitet: Render-Blueprint (`render.yaml`),
Pages-Workflow (`.github/workflows/pages.yml`), Health-Endpoints
(`/api/health`, `/healthz`), Auto-Seed der Dutys (`seed/duties.json`) und der
**fest verankerte Supervisor** `jggaming2518`. Du musst nur noch die Konten
anlegen und ein paar URLs setzen.

> Hinweis: Der Projektordner heißt auch lokal **VBG Website** – den Namen
> kannst du in Windows jederzeit ändern, der Code ist davon unabhängig.

---

## Was du brauchst

| Dienst | Zweck | Konto |
|---|---|---|
| [GitHub](https://github.com) | Hosting des Codes + Frontend | kostenlos |
| [Render](https://render.com) | Backend/API + Daten (Node) | kostenloser Free-Plan ok |
| [UptimeRobot](https://uptimerobot.com) | hält Render wach + meldet Ausfälle | kostenlos |
| Node.js ≥ 18 | lokales Testen | [nodejs.org](https://nodejs.org) |

---

## Teil 0 – Lokal starten (zum Testen)

```bash
# 1. Abhängigkeiten installieren
npm install

# 2. Dutys einspielen (liest automatisch die Datei "TF duty's…" aus dem Temp-Ordner)
npm run seed

# 3. Server starten
npm start
```

Im Browser **http://localhost:3000** öffnen und mit dem **fest verankerten
Supervisor** einloggen:

- **Benutzername:** `jggaming2518`
- **Passwort:** `Jlg161218MGB!`

Dieser Nutzer ist ins System **eingebaut** (Code `server/db.js` + Datenbank):
Er wird bei jedem Start automatisch angelegt, ist **unlöschbar** und
**nicht sperrbar** (im Nutzer-Menü mit „geschützt" markiert) und übersteht auch
einen Daten-Reset.

Über **Nutzer → + Nutzer anlegen** weitere Konten mit Lizenzen
(FDL-Stellwerke und/oder TF-Fahrzeuge) erstellen.

Zum Beenden: `Strg+C` im Terminal.

---

## Teil 1 – GitHub-Repository anlegen & pushen

1. Auf [github.com](https://github.com) oben rechts auf **+ → New repository**.
   - Name z.B. `vbg-website`, **privat** (wegen des Passworts im Code),
     **ohne** Dateien initialisieren.
2. Im Projektordner folgende Befehle ausführen:

```bash
git init
git add .
git commit -m "VBG Website initial"
git branch -M main
git remote add origin https://github.com/DEIN-NAME/vbg-website.git
git push -u origin main
```

> **Wichtig:** `data.json` (Nutzer + Passwort-Hashes) steht in `.gitignore`
> und wird **nicht** gepusht. `seed/duties.json`, `render.yaml` und
> `.github/workflows/pages.yml` werden mitgepusht – die brauchst du für die
> nächsten Schritte.

---

## Teil 2 – Render: Backend live schalten

### Variante A – Blueprint (empfohlen)

1. Auf [render.com](https://render.com) anmelden → GitHub-Account verbinden.
2. **New → Blueprint** → dein Repo `vbg-website` auswählen.
3. Render liest `render.yaml` und erstellt automatisch den Service
   `vbg-website` (Node 20, Healthcheck auf `/api/health`, `JWT_SECRET` wird
   automatisch erzeugt, Auto-Seed aktiv).
4. **Deploy abwarten** (~2–5 min für `npm ci` + Start).
5. Oben im Service den **URL** kopieren, z. B. `https://vbg-website.onrender.com`.

### Variante B – Manuell

1. Render → **New → Web Service** → Repo auswählen.
2. Einstellungen:
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`
   - **Plan:** Free
3. **Environment Variables:**
   - `JWT_SECRET` → langer, zufälliger Wert (z.B. `openssl rand -base64 32`)
   - `SEED_FILE` → `seed/duties.json`
4. **Create** → Deploy abwarten.

### Nach dem Deploy prüfen

```bash
# Muss liefern: {"ok":true,"service":"vbg-website","duties":39,...}
curl https://DEIN-SERVICE.onrender.com/api/health
```

Die 39 Dutys sind automatisch da (Shift **„Organisationsplan"**), weil beim
ersten Start `SEED_FILE` die Datei `seed/duties.json` importiert – und der
fest verankerte Supervisor `jggaming2518` existiert ebenfalls sofort.

**Erster Login:** App unter `https://DEIN-SERVICE.onrender.com` öffnen →
einloggen mit `jggaming2518` / `Jlg161218MGB!`. (Kein curl zum Anlegen nötig.)

> **Sicherheit:** Das Start-Passwort steht im Quellcode (`server/db.js`), damit
> der Nutzer nach jedem Daten-Reset wieder da ist. Deshalb das Repo auf GitHub
> **privat** halten. Der Nutzer ist trotzdem nicht über die Oberfläche
> löschbar oder sperrbar.

> **Datenverlust / Schlafmodus:** Render (Free-Plan) schläft nach ~15 min
> ohne Traffic ein – kein Problem, Teil 4 (UptimeRobot) hält den Service wach.
> Bei Disk-Reset beim Redeploy: Dutys **und** der verankerte Supervisor werden
> beim nächsten Start automatisch neu angelegt – nur selbst angelegte Nutzer
> musst du dann einmalig neu anlegen.

---

## Teil 3 – GitHub Pages: Frontend live schalten

1. In `public/config.js` die Render-URL eintragen:

```js
window.VBG_API_BASE = "https://DEIN-SERVICE.onrender.com";
```

2. Pushen (der Pages-Workflow macht den Rest automatisch):

```bash
git add public/config.js
git commit -m "API-URL fuer GitHub Pages gesetzt"
git push
```

3. In GitHub: **Repo → Settings → Pages** → **Source: „GitHub Actions"**
   auswählen. (Der Workflow läuft ab jetzt bei jedem Push auf `main`.)
4. Nach ~1 min ist das Frontend unter
   `https://DEIN-NAME.github.io/vbg-website/` verfügbar.
5. Dort einloggen – die App spricht automatisch mit deiner Render-API.

> Tipp: Alternativ kannst du die App auch einfach direkt unter der Render-URL
> nutzen (das Frontend wird dort mit ausgeliefert). Pages ist der „schönere" Weg.

---

## Teil 4 – UptimeRobot: Monitor (= Uptime-Bot) einrichten

Render schaltet den Free-Plan nach ~15 min in den Schlaf; der erste Request
braucht dann 30–60 s. UptimeRobot pingt regelmäßig, hält den Service so wach
und benachrichtigt bei Ausfall.

1. Auf [uptimerobot.com](https://uptimerobot.com) anmelden.
2. **+ New monitor**:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** z.B. `VBG Website API`
   - **URL:** `https://DEIN-SERVICE.onrender.com/api/health`
   - **Monitoring Interval:** 5 minutes
   - **Timeout:** 30 seconds
3. **Create monitor**.
4. Optional: **Alert Contacts** (oben) anlegen und dem Monitor zuweisen –
   E-Mail, Discord (via Webhook), Telegram, Slack … dann bekommst du bei
   Ausfall automatisch eine Nachricht.
5. Nach wenigen Minuten steht der Monitor auf **UP**. Erwartete Antwort:
   HTTP 200 + `{"ok":true,...}`.

Damit ist die komplette Kette aktiv: **UptimeRobot → Render (Backend) →
Pages (Frontend)**.

---

## Teil 5 – Produktiv nutzen

1. **Admin/Login:** Mit `jggaming2518` / `Jlg161218MGB!` einloggen – dieser
   Nutzer ist nicht löschbar/sperrbar.
2. **Weitere Nutzer:** Unter **Nutzer → + Nutzer anlegen** (Supervisor)
   Konten mit Benutzername + Passwort + Lizenzen erstellen:
   - FDL: Stellwerke (z.B. AK, STB, NS, BHBF)
   - TF: Fahrzeuge (z.B. 628, 429, 245 (Dosto))
   Lizenzen lassen sich später jederzeit ergänzen/ändern; Konten können
   gesperrt oder gelöscht werden (außer der geschützte Supervisor).
3. **Organisation:** **Shifts → Organisationsplan** öffnen → Dutys ansehen.
   - Fahrer wünschen Dutys (nur mit passender TF-Lizenz), du nimmst an/ab
     oder weist direkt zu.
   - Fahrten entfallen lassen (mit Vermerk), Halte streichen, Fahrzeug ändern
     (einzeln oder für alle Fahrten).
4. **Fahrzeugübersicht** zeigt automatisch, welches Fahrzeug wann wo eingesetzt
   ist und wo es bei Serverstart steht.

---

## Troubleshooting

| Problem | Lösung |
|---|---|
| `curl .../api/health` antwortet nicht | Deploy läuft noch / fehlgeschlagen → Render → **Logs** ansehen. Erste Auslieferung kann Minuten dauern. |
| `/api/health` zeigt `duties:0` | `SEED_FILE=seed/duties.json` als Env-Variable gesetzt? Sonst Render-Einstellungen prüfen, Speichern deployst neu. |
| Login meldet „Nicht angemeldet" | `JWT_SECRET` wurde geändert → einfach erneut einloggen. |
| Pages lädt, aber keine Daten | `public/config.js` mit falscher/leerer `VBG_API_BASE`? → korrigieren + pushen. |
| Daten futsch nach Reset/Redeploy | Normal. Dutys + geschützter Supervisor werden automatisch neu angelegt; nur eigene Nutzer/Zuteilungen/Vermerke neu machen. |
| CORS-Fehler im Browser | Render-URL in `config.js` ohne Schluss-Slash prüfen. (cors ist offen – Pages + Render funktionieren aus verschiedenen Domains.) |
| Freie Render-Pläne sind langsam | Normal. UptimeRobot hält sie warm. |
| `jggaming2518` nicht da | Passiert nur, wenn `data.json` manuell angefasst wurde – einmal neu starten, der Nutzer wird automatisch angelegt. |

---

## Sicherheit kurz

- `data.json` mit Passwort-Hashes wird **nie** gepusht (`.gitignore`).
- In Produktion läuft alles über HTTPS (Render + Pages automatisch).
- Das Start-Passwort von `jggaming2518` steht im Code (`server/db.js`) → Repo
  **privat** halten, sonst kann es jeder lesen. Weitere Admins legst du selbst
  mit sicheren Passwörtern an.
- `JWT_SECRET` ist bei der Blueprint-Variante automatisch zufällig erzeugt –
  danach nicht ohne Grund ändern (sonst sind alle Logins neu nötig).