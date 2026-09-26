const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const crypto = require("crypto");
const webpush = require("web-push");
const db = require("./db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const SECRET = process.env.JWT_SECRET || "vbg-website-dev-secret-bitte-in-env-setzen-123456";
const TOKEN_TIMEOUT = { normal: "12h", remember: "30d" };

async function boot() {
  db.load();
  try { ensureVapidKeys(); } catch (e) { console.error("VAPID-Setup fehlgeschlagen:", e.message); }

  // Persistenz: Bei jedem Start die zuletzt gespeicherte Remote-DB (GitHub-Branch "data") nachladen,
  // damit Profil/Profilbilder/Shifts/Anmeldungen jeden Deploy überleben.
  if (db.remoteDbEnabled()) {
    try {
      const remote = await db.fetchRemoteDb();
      if (remote && db.applyRemoteDb(remote)) {
        console.log(`Remote-DB geladen (${(remote.users || []).length} Nutzer, Branch data).`);
      } else {
        console.log("Keine Remote-DB verfügbar – nutze lokale data.json.");
      }
    } catch (e) {
      console.error("Remote-DB Fehler:", e.message);
    }
  }

  const seedCount = db.importDutiesFromFile(process.env.SEED_FILE);
  if (seedCount) console.log(`Seed: ${seedCount} Tagesplan-Dutys importiert (${process.env.SEED_FILE}).`);
}

module.exports = { boot };

// ---------- Rollen ----------
const ROLE_LABELS = {
  supervisor: "Supervisor",
  senior: "Senior Busfahrer",
  user: "Busfahrer",
};
const DRIVER_ROLES = ["user", "senior"];

function roleLabel(r) {
  return ROLE_LABELS[r] || r;
}

// ---------- Zeithelfer ----------
function timeToMin(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim());
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
// Dauer zwischen zwei Uhrzeiten (bis < von ⇒ über Mitternacht)
function durMinutes(von, bis) {
  const a = timeToMin(von);
  let b = timeToMin(bis);
  if (b <= a) b += 1440;
  return b - a;
}
// Schlüsselt eine Uhrzeit auf die Folgetag-Achse auf (klappt für Über-Mitternacht-Spannen)
function spanKey(von, bis) {
  const a = timeToMin(von);
  let b = timeToMin(bis);
  if (b <= a) b += 1440;
  return [a, b];
}
function overlaps(aVon, aBis, bVon, bBis) {
  const [a1, a2] = spanKey(aVon, aBis);
  const [b1, b2] = spanKey(bVon, bBis);
  return a1 < b2 && b1 < a2;
}

function uid() { return crypto.randomUUID(); }

function newPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  if (!/\d/.test(out)) out = "f" + out.slice(1);
  return out;
}

// ---------- Hilfsfunktionen ----------

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    roleLabel: roleLabel(u.role),
    linien: u.linien || [],
    strafstunden: u.strafstunden || 0,
    strafstundenGrund: u.strafstundenGrund || "",
    kündigung: (u.strafstunden || 0) >= 20,
    discordName: u.discordName || "",
    robloxName: u.robloxName || "",
    robloxChangedAt: u.robloxChangedAt || null,
    robloxEditable: canEditRoblox(u),
    displayName: u.displayName || "",
    displayNameChangedAt: u.displayNameChangedAt || null,
    displayNameEditable: canEditDisplayName(u),
    strafFristBis: u.strafFristBis || null,
    strafFristAuto: !!u.strafFristAuto,
    language: u.language || "de",
    avatar: u.avatar || "",
    suspended: !!u.suspended,
    protected: !!u.protected,
    mustChangePassword: !!u.mustChangePassword,
    license: u.license || "",
    createdAt: u.createdAt,
  };
}

function canEditRoblox(u) {
  // Selbst änderbar nur alle 6 Monate; Supervisor jederzeit.
  if (!u.robloxChangedAt) return true;
  const six = 1000 * 60 * 60 * 24 * 182;
  return Date.now() - new Date(u.robloxChangedAt).getTime() >= six;
}

const DISPLAY_NAME_COOLDOWN_MS = 1000 * 60 * 60 * 24 * 30; // 1x pro Monat

function canEditDisplayName(u) {
  if (!u.displayNameChangedAt) return true;
  return Date.now() - new Date(u.displayNameChangedAt).getTime() >= DISPLAY_NAME_COOLDOWN_MS;
}

// ---------- Strafstunden-Frist ----------

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + dd;
}

// Automatische Frist: +1 Kalendermonat ab heute. Fällt der Tag im Zielmonat weg
// (z. B. Strafe am 31. → Zielmonat ohne 31.), läuft die Frist bis zum 01. des Folgemonats.
function autoFristDate(from) {
  const d = from || new Date();
  const y = d.getFullYear(), mo = d.getMonth();
  const plus = new Date(y, mo + 1, d.getDate());
  if (plus.getMonth() !== ((mo + 1) % 12)) {
    return toISODate(new Date(y, mo + 2, 1));
  }
  return toISODate(plus);
}

function addMonthsIsoDate(baseIso, months) {
  const b = baseIso ? new Date(String(baseIso).slice(0, 10) + "T00:00:00") : new Date();
  if (isNaN(b.getTime())) return autoFristDate(new Date());
  const y = b.getFullYear(), mo = b.getMonth();
  const target = new Date(y, mo + Math.round(months), 1);
  const days = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const dd = Math.min(b.getDate(), days);
  return toISODate(new Date(target.getFullYear(), target.getMonth(), dd));
}

// Strafstunden-Frist automatisch pflegen:
// - unter 3 h → Frist wird entfernt
// - über/bei 3 h ohne gesetzte Frist → automatisch 1 Monat zum Abarbeiten
// (außer ein Supervisor hat die Frist bewusst entfernt: strafFristAuto=false)
function syncStrafFrist(user) {
  if ((user.strafstunden || 0) < 3) {
    user.strafFristBis = null;
    user.strafFristAuto = true; // zurück auf automatisch verwaltet
  } else if (!user.strafFristBis && user.strafFristAuto !== false) {
    user.strafFristBis = autoFristDate(new Date());
    user.strafFristAuto = true;
  }
}

// ---------- System-/Desktop-Benachrichtigungen (Web Push) ----------
const PUSH_SUBJECT = "mailto:admin@vbg-website.local";

function ensureVapidKeys() {
  const data = db.load();
  const envPublic = process.env.VBG_VAPID_PUBLIC_KEY;
  const envPrivate = process.env.VBG_VAPID_PRIVATE_KEY;
  let pub = envPublic;
  let priv = envPrivate;
  if (envPublic && envPrivate) {
    webpush.setVapidDetails(PUSH_SUBJECT, envPublic, envPrivate);
    return { publicKey: envPublic };
  }
  if (!pub || !priv) {
    if (data._vapid && data._vapid.publicKey && data._vapid.privateKey) {
      pub = data._vapid.publicKey;
      priv = data._vapid.privateKey;
    } else {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey;
      priv = keys.privateKey;
      data._vapid = { publicKey: pub, privateKey: priv };
      db.save();
    }
  }
  webpush.setVapidDetails(PUSH_SUBJECT, pub, priv);
  return { publicKey: pub };
}

function subKey(s) {
  return s.endpoint + "|" + s.keys.p256dh;
}

function pushToSubs(subs, title, body, url) {
  (subs || []).forEach((s) => {
    if (!s || !s.endpoint || !s.keys || !s.keys.p256dh) return;
    webpush.sendNotification(s, JSON.stringify({ title: title || "VBG Orga", body: body || "", url: url || "/" }))
      .catch((err) => {
        // Abonnement nicht mehr gültig (nutzer deaktiviert / Browser)/gerätesperre → entfernen
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          const d = db.load();
          d.pushSubscriptions = (d.pushSubscriptions || []).filter((x) => subKey(x) !== subKey(s));
          db.save();
        }
      });
  });
}

function pushToUser(userId, title, body, url) {
  const d = db.load();
  const subs = (d.pushSubscriptions || []).filter((x) => x.userId === userId);
  if (subs.length) pushToSubs(subs, title, body, url);
}

function pushTitleFor(type) {
  switch (type) {
    case "apply": return "Neue Anmeldung";
    case "success": return "Mitteilung";
    case "warning": return "Warnung";
    case "announce": return "Ansage vom Supervisor";
    default: return "VBG Orga";
  }
}

function notify(userId, message, type) {
  const data = db.load();
  data.notifications.push({
    id: uid(),
    userId,
    message,
    type: type || "info",
    read: false,
    createdAt: new Date().toISOString(),
  });
  db.save();
  pushToUser(userId, pushTitleFor(type), message);
}

function notifyAll(message, type) {
  const data = db.load();
  // Nur Supervisoren für systemweite Ankündigungen
  const supervisors = data.users.filter((u) => u.role === "supervisor");
  supervisors.forEach((u) => {
    data.notifications.push({
      id: uid(), userId: u.id, message, type: type || "info",
      read: false, createdAt: new Date().toISOString(),
    });
  });
  // Spezielle "all-supervisors" für Broadcast
  data.notifications.push({
    id: uid(), userId: "all-supervisors", message, type: type || "info",
    read: false, createdAt: new Date().toISOString(),
  });
  db.save();
  const subs = (data.pushSubscriptions || [])
    .filter((x) => supervisors.find((u) => u.id === x.userId));
  pushToSubs(subs, pushTitleFor(type), message);
}

function effectiveVehicle(duty) {
  if (duty.vehicleId) return duty.vehicleId;
  const t = (duty.trips || []).find((x) => x.vehicleId);
  return t ? t.vehicleId : null;
}

// ---------- Supervisor-Aktions-Protokoll (Audit-Log) ----------
const SUP_LOG_CAP = 2000;
function audit(data, actor, action, detail) {
  data.supervisorLog = data.supervisorLog || [];
  data.supervisorLog.push({
    id: uid(),
    actorId: actor ? actor.id : null,
    actorName: actor ? (actor.displayName || actor.username || actor.id) : "?",
    action,
    detail,
    createdAt: new Date().toISOString(),
  });
  if (data.supervisorLog.length > SUP_LOG_CAP) {
    data.supervisorLog = data.supervisorLog.slice(-SUP_LOG_CAP);
  }
}

// ---------- Fahrtenbuch (manuelle Einträge, pro Fahrzeug) ----------
function fbWeekCutoffWeeks(role) {
  return role === "supervisor" ? 8 : 4;
}
function fbCutoffDate(weeksAgo) {
  const d = new Date();
  d.setDate(d.getDate() - 7 * weeksAgo);
  return d.toISOString().slice(0, 10);
}
function isIntNum(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
function fbValidate(body, isSup, actor) {
  const res = { ok: true, errors: [] };
  if (!body || typeof body !== "object") { res.ok = false; res.errors.push("Fehlende Daten"); return res; }
  const datum = String(body.datum || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || isNaN(new Date(datum).getTime())) res.errors.push("Datum fehlt oder ungültig");
  const linieId = body.linieId || "";
  if (!linieId) res.errors.push("Linie fehlt");
  if (!isIntNum(body.blitzer)) res.errors.push("Blitzer: ganze Zahl ≥ 0 nötig");
  if (!isIntNum(body.defekte)) res.errors.push("Defekte: ganze Zahl ≥ 0 nötig");
  if (!isIntNum(body.behoben)) res.errors.push("Behoben: ganze Zahl ≥ 0 nötig");
  if (isIntNum(body.defekte) && isIntNum(body.behoben) && body.behoben > body.defekte) {
    res.errors.push("Beim Ende behoben darf nicht höher sein als die Defekte");
  }
  const fz = vehicleById(body.vehicleId);
  if (!fz) res.errors.push("Fahrzeug fehlt oder existiert nicht");
  if (!isSup) {
    const linie = db.load().linien.find((l) => l.id === linieId);
    if (!linie) res.errors.push("Linie existiert nicht");
  }
  if (res.errors.length) { res.ok = false; }
  return res;
}
function enrichFbEntry(data, e) {
  const fz = data.fahrzeuge.find((f) => f.id === e.vehicleId) || null;
  const linie = data.linien.find((l) => l.id === e.linieId) || null;
  const drv = data.users.find((u) => u.id === e.driverUserId) || null;
  return {
    ...e,
    vehicle: fz ? (fz.wagennummer || fz.typ || fz.id) : "–",
    vehicleKennzeichen: fz ? fz.kennzeichen : "",
    vehicleTyp: fz ? fz.typ : "",
    linieName: linie ? (linie.name || linie.beschreibung) : "",
    fahrername: drv ? (drv.displayName || drv.username) : (e.fahrername || ""),
  };
}
function userDayName(d) {
  return d.toISOString().slice(0, 10);
}
// „Heute offen“: heutige Einsätze (echte Shifts) mit Fahrer, für die noch kein
// Fahrtenbuch-Eintrag (gleicher Fahrer, gleiche Linie, gleiches Datum) existiert.
function fbTodayOpen(data, user) {
  const today = userDayName(new Date());
  const entries = data.fahrtenbuch || [];
  const anyReal = data.shifts.some((s) => s.id !== "tpl-tagesplan" && s.date === today);
  if (!anyReal) return [];
  const rows = [];
  data.duties.forEach((d) => {
    if (d.cancelled) return;
    const shift = data.shifts.find((s) => s.id === d.shiftId);
    if (!shift || shift.id === "tpl-tagesplan" || shift.date !== today) return;
    const fahrerIds = new Set();
    if (d.assignedUserId) fahrerIds.add(d.assignedUserId);
    (d.trips || []).forEach((t) => { if (t.assignedUserId) fahrerIds.add(t.assignedUserId); });
    fahrerIds.forEach((fid) => {
      if (user && user.role !== "supervisor" && fid !== user.id) return;
      const hasEntry = entries.some((e) =>
        e.driverUserId === fid && e.datum === today &&
        (!d.linieId || e.linieId === d.linieId || !e.linieId));
      if (hasEntry) return;
      const drv = data.users.find((u) => u.id === fid);
      rows.push({
        dutyId: d.id, dutyName: d.name, shiftName: shift.name,
        linieId: d.linieId || null,
        vehicleId: effectiveVehicle(d),
        linieName: (data.linien.find((l) => l.id === d.linieId) || {}).name || "",
        fahrername: drv ? (drv.displayName || drv.username) : fid,
        fahrerId: fid,
        datum: today,
      });
    });
  });
  // deduplizieren (gleiche Linie+Fahrer+Tagname)
  const seen = new Set();
  return rows.filter((r) => {
    const k = r.fahrerId + "|" + r.linieName + "|" + r.dutyName;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
// Löscht Einträge älter als 8 Wochen komplett (Retention).
function cleanupFahrtenbuch() {
  const cutoff = fbCutoffDate(8);
  const data = db.load();
  const before = (data.fahrtenbuch || []).length;
  data.fahrtenbuch = (data.fahrtenbuch || []).filter((e) => (e.datum || "") >= cutoff);
  if ((data.fahrtenbuch || []).length !== before) db.save();
  return before - (data.fahrtenbuch || []).length;
}

function hasLineLicense(user, linieId) {
  if (!linieId) return true;
  return (user.linien || []).includes(linieId);
}

function vehicleById(id) {
  return db.load().fahrzeuge.find((f) => f.id === id) || null;
}

function dutyDauerMin(duty) {
  if (!duty.trips || !duty.trips.length) return 0;
  const reisen = duty.trips.filter((t) => !t.leerfahrt && !t.cancelled);
  if (!reisen.length) return 0;
  let fahrSumme = 0;
  reisen.forEach((t) => { fahrSumme += Math.max(0, durMinutes(t.dep, t.arr)); });
  let spanne = 0;
  const all = duty.trips.filter((t) => !t.cancelled);
  if (all.length) {
    const a = timeToMin(all[0].dep);
    let b = timeToMin(all[all.length - 1].arr);
    if (b <= a) b += 1440;
    spanne = b - a;
  }
  return { fahrSumme, spanne, pausen: Math.max(0, spanne - fahrSumme) };
}

function sortTrips(duty) {
  const m = /^(\d{1,2})/.exec(String(duty.startTime || ""));
  const dutyStart = m ? Number(m[1]) * 60 : null; // Duty-Beginn in Minuten
  duty.trips.sort((a, b) => {
    let ka = timeToMin(a.dep);
    let kb = timeToMin(b.dep);
    // Fahrt liegt >12h VOR dem Duty-Start → gehört zum Folgetag (z. B. Nachtbus nach Mitternacht).
    if (dutyStart !== null) {
      const wrapBefore = dutyStart - 12 * 60;
      if (ka < wrapBefore) ka += 1440;
      if (kb < wrapBefore) kb += 1440;
    }
    return ka - kb;
  });
  return duty;
}

function enrichDuty(d) {
  const data = db.load();
  const driver = data.users.find((u) => u.id === d.assignedUserId) || null;
  const line = data.linien.find((l) => l.id === d.linieId) || null;
  const v = vehicleById(effectiveVehicle(d));
  const dauer = dutyDauerMin(d);
  let kundenserviceStandort = null;
  if (d.art === "kundenservice" && d.kundenserviceStandortId) {
    const ks = data.kundenservice.find((k) => k.id === d.kundenserviceStandortId);
    if (ks) kundenserviceStandort = { id: ks.id, name: ks.name, startTime: ks.startTime, endTime: ks.endTime };
  }
  return {
    ...d,
    trips: sortTrips({ ...d }).trips.map((t) => {
      const tdr = data.users.find((u) => u.id === t.assignedUserId) || null;
      const tv = vehicleById(t.vehicleId) || null;
      return { ...t, assignedUsername: tdr ? tdr.username : null, vehicleWagennummer: tv ? tv.wagennummer : null };
    }),
    linieName: line ? line.name : null,
    linieLabel: line ? line.beschreibung : null,
    vehicleName: v ? (v.typ || v.wagennummer) : null,
    vehicleWagennummer: v ? v.wagennummer : null,
    assignedUsername: driver ? driver.username : null,
    fahrSummeMin: dauer.fahrSumme,
    spanneMin: dauer.spanne,
    pausenMin: dauer.pausen,
    linienwechsel: d.linienwechsel || null,
    kundenserviceStandort,
  };
}

// Zuteilungs-Konflikte prüfen:
// – Nur innerhalb genehmigter Anmeldung der Shift
// – keine zeitliche Überschneidung mit anderen Zuteilungen desselben Fahrers
function zuteilungsKonflikt(userId, duty, von, bis, ignoreTripId) {
  const data = db.load();
  const user = data.users.find((u) => u.id === userId);
  if (!user) return "Unbekannter Fahrer";
  if (user.suspended) return "Fahrer ist gesperrt";
  if (!hasLineLicense(user, duty.linieId)) return "Fahrer hat keine Linien-Lizenz für diese Duty";

  // Zeitfenster der Zuteilung (bei Duty = Duty-Spanne, bei Fahrt = Fahrt-Zeit)
  let a1, a2;
  if (von && bis) { const s = spanKey(von, bis); a1 = s[0]; a2 = s[1]; }
  else {
    const trips = duty.trips.filter((t) => !t.cancelled);
    if (!trips.length) return "Duty hat keine aktiven Fahrten";
    const s = spanKey(trips[0].dep, trips[trips.length - 1].arr);
    a1 = s[0]; a2 = s[1];
  }

  // Genehmigte Anmeldung für die Shift vorhanden?
  const granted = data.applications.find(
    (ap) => ap.userId === userId && ap.shiftId === duty.shiftId &&
      ap.status === "accepted" && ap.art !== "kundenservice"
  );
  if (granted && granted.von && granted.bis) {
    const g = spanKey(granted.von, granted.bis);
    if (!(a1 >= g[0] && a2 <= g[1])) {
      return "Zuteilung liegt außerhalb der genehmigten Anmeldezeit (von–bis)";
    }
  }

  // Überschneidung mit anderen Zuteilungen in derselben Shift
  for (const other of data.duties) {
    if (other.id === duty.id || other.shiftId !== duty.shiftId) continue;
    if (other.assignedUserId !== userId) continue;
    const ot = other.trips.filter((t) => !t.cancelled);
    if (!ot.length) continue;
    const s = spanKey(ot[0].dep, ot[ot.length - 1].arr);
    if (a1 < s[1] && s[0] < a2) return `Zeitkonflikt mit Duty "${other.name}"`;
  }
  // Einzelfahrt-Zuteilungen
  for (const other of data.duties) {
    if (other.id === duty.id || other.shiftId !== duty.shiftId) continue;
    if (other.assignedUserId === userId) continue;
    for (const t of other.trips || []) {
      if (t.assignedUserId !== userId || t.cancelled) continue;
      if (ignoreTripId && t.id === ignoreTripId) continue;
      const s = spanKey(t.dep, t.arr);
      if (a1 < s[1] && s[0] < a2) return `Zeitkonflikt mit Fahrt "${other.name} (${t.from}→${t.to}) "`;
    }
  }
  return null;
}

// ---------- Auth ----------

function authToken(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  try {
    return jwt.verify(h.slice(7).trim(), SECRET);
  } catch (e) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const data = db.load();
  const payload = authToken(req);
  if (!payload) return res.status(401).json({ error: "Nicht angemeldet" });
  const user = data.users.find((u) => u.id === payload.sub);
  if (!user) return res.status(401).json({ error: "Unbekannter Nutzer" });
  if (user.suspended) return res.status(403).json({ error: "Konto gesperrt" });
  req.user = user;
  next();
}

function requireSupervisor(req, res, next) {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "Nur Supervisor erlaubt" });
  next();
}

app.post("/api/auth/login", async (req, res) => {
  const data = db.load();
  const { username, password, remember } = req.body || {};
  const user = data.users.find(
    (u) => (u.username || "").toLowerCase() === (username || "").trim().toLowerCase()
  );
  if (!user || !(await bcrypt.compare(password || "", user.passwordHash || ""))) {
    return res.status(401).json({ error: "Falscher Benutzername oder Passwort" });
  }
  if (user.suspended) return res.status(403).json({ error: "Konto ist gesperrt" });
  const token = jwt.sign({ sub: user.id, role: user.role }, SECRET, {
    expiresIn: remember ? TOKEN_TIMEOUT.remember : TOKEN_TIMEOUT.normal,
  });
  res.json({ token, user: publicUser(user) });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post("/api/auth/logout", (req, res) => res.json({ ok: true }));

// Manueller Daten-Backup (nur Supervisor)
app.post("/api/backup/manual", requireAuth, requireSupervisor, async (req, res) => {
  const result = await db.pushRemoteDb();
  if (result.ok) {
    res.json({ ok: true, message: "Backup erfolgreich in data-Branch gespeichert" });
  } else {
    res.status(500).json({ ok: false, error: result.error });
  }
});

// ---------- Nutzer ----------

app.get("/api/users", requireAuth, requireSupervisor, (req, res) => {
  res.json({ users: db.load().users.map(publicUser) });
});

// Öffentliche / eigene Informationen (auch für Fahrer für den Account-Tab)
app.get("/api/me/profile", requireAuth, (req, res) => {
  const data = db.load();
  const u = data.users.find((x) => x.id === req.user.id);
  const linien = (u.linien || []).map((id) => {
    const l = data.linien.find((x) => x.id === id);
    return l ? { id: l.id, name: l.name, beschreibung: l.beschreibung } : null;
  }).filter(Boolean);
  const zuteilungen = data.duties.filter(
    (d) => d.assignedUserId === u.id && !d.cancelled
  ).map((d) => ({
    dutyId: d.id, name: d.name, shiftId: d.shiftId,
    linie: ((data.linien.find((l) => l.id === d.linieId) || {}).name || ""),
    start: d.trips.length ? d.trips[0].dep : "",
    end: d.trips.length ? d.trips[d.trips.length - 1].arr : "",
  }));
  const einzelfahrten = [];
  data.duties.forEach((d) => {
    (d.trips || []).forEach((t) => {
      if (t.assignedUserId === u.id && !t.cancelled) {
        einzelfahrten.push({
          dutyId: d.id, dutyName: d.name, shiftId: d.shiftId,
          from: t.from, to: t.to, dep: t.dep, arr: t.arr,
        });
      }
    });
  });
  res.json({
    user: publicUser(u),
    linien,
    zuteilungen,
    einzelfahrten,
    robloxEditable: canEditRoblox(u),
    robloxChangedAt: u.robloxChangedAt,
  });
});

app.post("/api/users", async (req, res) => {
  const data = db.load();
  if (data.users.length > 0) {
    const payload = authToken(req);
    if (!payload) return res.status(401).json({ error: "Nicht angemeldet" });
    const u2 = data.users.find((x) => x.id === payload.sub);
    if (!u2) return res.status(401).json({ error: "Unbekannter Nutzer" });
    if (u2.suspended) return res.status(403).json({ error: "Konto gesperrt" });
    if (u2.role !== "supervisor") return res.status(403).json({ error: "Nur Supervisor erlaubt" });
  }
  const { username, role, linien, license } = req.body || {};
  if (!username) return res.status(400).json({ error: "Benutzername fehlt" });
  if (data.users.some((u) => u.username.toLowerCase() === username.trim().toLowerCase())) {
    return res.status(400).json({ error: "Benutzername existiert bereits" });
  }
  const validRole = role === "supervisor" || DRIVER_ROLES.includes(role) ? role : "user";
  const pw = newPassword();
  const user = {
    id: uid(),
    username: username.trim(),
    passwordHash: await bcrypt.hash(pw, 10),
    role: validRole,
    linien: Array.isArray(linien) ? linien : [],
    license: validRole === "supervisor" ? "Solo,Gelenk" : (license || ""),
    strafstunden: 0,
    discordName: "",
    robloxName: "",
    robloxChangedAt: null,
    displayName: "",
    displayNameChangedAt: null,
    strafFristBis: null,
    strafFristAuto: true,
    language: "de",
    avatar: "",
    suspended: false,
    mustChangePassword: true,
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  db.save();
  res.json({ user: publicUser(user), einmalPasswort: pw });
});

// Profil bearbeiten (eigenes Konto): Discord, Roblox (6-Monats-Regel), Sprache, Bild
app.patch("/api/me/profile", requireAuth, async (req, res) => {
  const data = db.load();
  const u = data.users.find((x) => x.id === req.user.id);
  const { discordName, robloxName, language, avatar, displayName } = req.body || {};
  const isSup = u.role === "supervisor";
  const authUser = u; // wer ändert = der Nutzer selbst (Supervisor ändert über /api/users/:id)

  if (typeof discordName === "string") u.discordName = discordName.trim();
  if (typeof language === "string") u.language = language.trim() || "de";
  if (typeof avatar === "string") u.avatar = avatar;

  if (typeof displayName === "string" && displayName.trim() !== (u.displayName || "")) {
    if (!canEditDisplayName(u)) {
      return res.status(400).json({ error: "Anzeigename ist nur 1x pro Monat änderbar (oder durch Supervisor)" });
    }
    u.displayName = displayName.trim();
    u.displayNameChangedAt = new Date().toISOString();
  }

  if (typeof robloxName === "string" && robloxName.trim() !== (u.robloxName || "")) {
    if (!isSup && !canEditRoblox(u)) {
      return res.status(400).json({ error: "Roblox-Name ist nur alle 6 Monate änderbar (oder durch Supervisor)" });
    }
    u.robloxName = robloxName.trim();
    u.robloxChangedAt = new Date().toISOString();
    // Supervisors dürfen ihren eigenen Roblox-Name jederzeit ändern (kein Cooldown nötig).
    if (isSup) u.robloxChangedAt = u.robloxChangedAt;
  }
  db.save();
  res.json({ user: publicUser(u), robloxEditable: canEditRoblox(u), robloxChangedAt: u.robloxChangedAt, displayNameEditable: canEditDisplayName(u), displayNameChangedAt: u.displayNameChangedAt });
});

app.post("/api/me/password", requireAuth, async (req, res) => {
  const data = db.load();
  const u = data.users.find((x) => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  const { currentPassword, newPassword } = req.body || {};
  const np = String(newPassword || "");
  if (np.length < 6) return res.status(400).json({ error: "Neues Passwort: mindestens 6 Zeichen" });
  // Beim ersten Login mit Einmalpasswort (mustChangePassword) genügt das neue Passwort allein.
  if (!u.mustChangePassword) {
    if (!(await bcrypt.compare(String(currentPassword || ""), u.passwordHash || ""))) {
      return res.status(400).json({ error: "Aktuelles Passwort ist falsch" });
    }
  }
  u.passwordHash = await bcrypt.hash(np, 10);
  u.mustChangePassword = false;
  u.passwordChangedAt = new Date().toISOString();
  audit(data, req.user, "Passwort geändert", u.username);
  db.save();
  res.json({ ok: true, mustChangePassword: false });
});

app.patch("/api/users/:id", requireAuth, requireSupervisor, async (req, res) => {
  const data = db.load();
  const user = data.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  if (user.protected && (req.body.role || req.body.linien || req.body.suspended !== undefined || req.body.strafstunden !== undefined)) {
    return res.status(403).json({ error: "Geschützter Supervisor kann hier nicht verändert werden" });
  }
  const { role, linien, license, suspended, password, strafstunden, discordName, robloxName, language, avatar, displayName, displayNameReset, strafFrist, strafFristDelta } = req.body || {};
  if (role && (role === "supervisor" || DRIVER_ROLES.includes(role))) user.role = role;
  if (Array.isArray(linien)) user.linien = linien;
  if (user.role === "supervisor") {
    user.license = "Solo,Gelenk";
  } else if (typeof license === "string") {
    user.license = license;
  }
  if (typeof suspended === "boolean") user.suspended = suspended;
  if (typeof discordName === "string") user.discordName = discordName.trim();
  if (typeof language === "string") user.language = language.trim() || "de";
  if (typeof avatar === "string") user.avatar = avatar;
  if (typeof displayName === "string" && displayName.trim() !== (user.displayName || "")) {
    user.displayName = displayName.trim();
    user.displayNameChangedAt = new Date().toISOString();
  }
  if (displayNameReset === true) user.displayNameChangedAt = null;
  if (typeof robloxName === "string" && robloxName.trim() !== (user.robloxName || "")) {
    user.robloxName = robloxName.trim();
    user.robloxChangedAt = new Date().toISOString();
  }
  if (password) user.passwordHash = await bcrypt.hash(password, 10);
  if (typeof strafstunden === "number") {
    const s = Math.max(0, strafstunden);
    const wasSup = user.role === "supervisor";
    user.strafstunden = s;
    if (s >= 20 && user.role !== "supervisor") {
      data.notifications.push({
        id: uid(), userId: user.id, read: false, type: "danger",
        message: "Du hast 20+ Strafstunden – es droht die Kündigung!",
        createdAt: new Date().toISOString(),
      });
    }
  }
  // Strafstunden-Frist manuell durch Supervisor: Datum setzen, entfernen oder um Monate verschieben
  if (strafFrist !== undefined) {
    if (strafFrist === null || String(strafFrist).trim() === "") {
      user.strafFristBis = null;
      user.strafFristAuto = false; // bewusst entfernt → kein Auto-Neu-Setzen
    } else if (typeof strafFrist === "string") {
      user.strafFristBis = addMonthsIsoDate(strafFrist, 0);
      user.strafFristAuto = false;
    }
  }
  if (typeof strafFristDelta === "number" && strafFristDelta !== 0) {
    const base = user.strafFristBis || autoFristDate(new Date());
    user.strafFristBis = addMonthsIsoDate(base, strafFristDelta);
    user.strafFristAuto = false;
  }
  syncStrafFrist(user);
  audit(data, req.user, "Nutzer bearbeitet", (user.displayName || user.username || user.id));
  db.save();
  res.json({ user: publicUser(user) });
});

app.delete("/api/users/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const i = data.users.findIndex((u) => u.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  if (data.users[i].protected) return res.status(403).json({ error: "Geschützter Nutzer" });
  if (data.users[i].role === "supervisor") return res.status(403).json({ error: "Supervisor-Accounts können nicht gelöscht werden" });
  if (data.users[i].id === req.user.id) return res.status(400).json({ error: "Eigenes Konto nicht löschen" });
  const [removed] = data.users.splice(i, 1);
  data.wishes = data.wishes.filter((w) => w.userId !== removed.id);
  data.applications = data.applications.filter((a) => a.userId !== removed.id);
  data.duties.forEach((d) => {
    if (d.assignedUserId === removed.id) d.assignedUserId = null;
    (d.trips || []).forEach((t) => { if (t.assignedUserId === removed.id) t.assignedUserId = null; });
  });
  audit(data, req.user, "Nutzer gelöscht", (removed.displayName || removed.username || removed.id));
  db.save();
  res.json({ ok: true });
});

// Backup/Export: liefert die komplette Datenbank als JSON, damit sie (z. B. als data.json)
// ins Repo committet werden kann und nach einem Deploy wiederhergestellt wird.
app.get("/api/backup", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  res.set("Content-Disposition", 'attachment; filename="data.json"');
  res.set("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(data, null, 2));
});

// Strafstunden: Supervisor setzt einzelnen Wert (Backend); Frontend bietet -0,5/+0,5 usw.
app.post("/api/users/:id/strafstunden", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const user = data.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  const { delta } = req.body || {};
  if (typeof delta !== "number") return res.status(400).json({ error: "delta fehlt" });
  const neu = Math.max(0, (user.strafstunden || 0) + delta);
  if (neu === 0 && delta < 0) {
    // Reduzieren unter 0 verboten
    const vor = user.strafstunden || 0;
    const eff = Math.min(vor, -delta);
    user.strafstunden = Math.max(0, vor - eff);
  } else {
    user.strafstunden = neu;
  }
  if ((user.strafstunden) >= 20 && user.role !== "supervisor") {
    data.notifications.push({
      id: uid(), userId: user.id, read: false, type: "danger",
      message: "Du hast 20+ Strafstunden – es droht die Kündigung!",
      createdAt: new Date().toISOString(),
    });
  }
  syncStrafFrist(user);
  audit(data, req.user, "Strafstunden geändert", (user.displayName || user.username) + " → " + user.strafstunden + " h");
  db.save();
  res.json({ user: publicUser(user) });
});

// ---------- Linien (Lizenzen) ----------

function sanitizeStops(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      const station = String((x && (x.station || x.name)) || "").trim();
      if (!station) return null;
      const item = { station, min: Math.max(0, Number(x && x.min) || 0) };
      if (x && typeof x.an === "string" && x.an.trim()) item.an = x.an.trim().slice(0, 5);
      if (x && typeof x.ab === "string" && x.ab.trim()) item.ab = x.ab.trim().slice(0, 5);
      return item;
    })
    .filter(Boolean);
}

// Standart-Vorschläge für eine Linie: die häufigsten Haltesequenzen (mit An/Ab-Zeiten)
// aus den im System hinterlegten Duty-Fahrten (ursprünglich aus den HTML-Daten importiert).
function defaultStopsForLinie(data, name, linieId) {
  const wanted = (name || "").trim().toLowerCase();
  const candidates = (data.duties || []).filter((d) => {
    if (linieId && d.linieId === linieId) return true;
    const dn = (d.name || "").trim().toLowerCase();
    if (!wanted) return false;
    // Match by line name in duty name (e.g., "19" in "19 Kurs 1" or "19" in "Duty 1" with lin19)
    return dn === wanted || dn.indexOf(wanted + " ") === 0 || dn.indexOf(wanted) === 0 || (d.linieId && data.linien.find(l => l.id === d.linieId && (l.name || "").toLowerCase().indexOf(wanted) === 0));
  });

  const map = new Map();
  candidates.forEach((d) => (d.trips || []).forEach((t) => {
    const stops = (t.stops || []).filter((s) => s && String(s.station || "").trim());
    if (stops.length < 2) return;
    const key = stops.map((s) => s.station).join("|");
    let seq = map.get(key);
    if (!seq) {
      seq = { key, count: 0, stops: stops.map((s) => ({ station: String(s.station).trim(), an: s.arr || s.dep || "", ab: s.dep || s.arr || "" })) };
      map.set(key, seq);
    }
    seq.count++;
  }));
  const seqs = Array.from(map.values()).sort((a, b) => b.count - a.count);
  if (!seqs.length) return { stopsHin: [], stopsRueck: [] };

  const hub = (() => {
    const c = new Map();
    candidates.forEach((d) => (d.trips || []).forEach((t) => {
      const k = String(t.to || "").trim();
      if (k) c.set(k, (c.get(k) || 0) + 1);
    }));
    let best = null;
    c.forEach((n, k) => { if (!best || n > best.n) best = { k, n }; });
    return best ? best.k : null;
  })();

  const hin = seqs.find((s) => hub && s.stops[s.stops.length - 1].station === hub) || seqs[0];
  let rueck = seqs.find((s) => hub && s.stops[0].station === hub)
    || seqs.find((s) => s !== hin && s.stops[0].station === (hin.stops[hin.stops.length - 1] || {}).station);
  if (!rueck) rueck = seqs.find((s) => s !== hin) || { stops: hin.stops.slice().reverse() };
  return { stopsHin: hin.stops, stopsRueck: rueck.stops, vonHand: seqs.length > 0 };
}

app.get("/api/linien", requireAuth, (req, res) => res.json({ items: db.load().linien }));

// Vorschläge für den Linien-Editor: Halte + An/Ab wie in den hinterlegten Fahrplänen
app.get("/api/linien/default-stops", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const dflt = defaultStopsForLinie(data, req.query.name || "", null);
  res.json({ stopsHin: dflt.stopsHin, stopsRueck: dflt.stopsRueck });
});

app.post("/api/linien", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const name = (req.body && req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name fehlt" });
  const explicitHin = req.body && req.body.stopsHin !== undefined;
  const explicitRueck = req.body && req.body.stopsRueck !== undefined;
  const dflt = (!explicitHin || !explicitRueck) ? defaultStopsForLinie(data, name, null) : null;
  const item = {
    id: uid(),
    name,
    beschreibung: (req.body && req.body.beschreibung || "").trim(),
    requiredVehicleType: req.body.requiredVehicleType || "",
    requiredLicense: req.body.requiredLicense || "",
    stopsHin: explicitHin ? sanitizeStops(req.body.stopsHin) : sanitizeStops(dflt && dflt.stopsHin),
    stopsRueck: explicitRueck ? sanitizeStops(req.body.stopsRueck) : sanitizeStops(dflt && dflt.stopsRueck),
  };
  data.linien.push(item);
  audit(data, req.user, "Linie angelegt", item.name);
  db.save();
  res.json({ item });
});

app.patch("/api/linien/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const l = data.linien.find((x) => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: "Linie nicht gefunden" });
  if (typeof req.body.name === "string") l.name = req.body.name.trim();
  if (typeof req.body.beschreibung === "string") l.beschreibung = req.body.beschreibung.trim();
  if (typeof req.body.requiredVehicleType === "string") l.requiredVehicleType = req.body.requiredVehicleType;
  if (typeof req.body.requiredLicense === "string") l.requiredLicense = req.body.requiredLicense;
  if (req.body.stopsHin !== undefined) l.stopsHin = sanitizeStops(req.body.stopsHin);
  if (req.body.stopsRueck !== undefined) l.stopsRueck = sanitizeStops(req.body.stopsRueck);
  audit(data, req.user, "Linie bearbeitet", l.name);
  db.save();
  res.json({ item: l });
});

app.delete("/api/linien/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const i = data.linien.findIndex((l) => l.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Linie nicht gefunden" });
  data.linien.splice(i, 1);
  data.users.forEach((u) => (u.linien = (u.linien || []).filter((x) => x !== req.params.id)));
  data.duties.forEach((d) => { if (d.linieId === req.params.id) d.linieId = null; });
  audit(data, req.user, "Linie gelöscht", req.params.id);
  db.save();
  res.json({ ok: true });
});

// ---------- Fahrzeuge ----------

app.get("/api/fahrzeuge", requireAuth, (req, res) => res.json({ items: db.load().fahrzeuge }));

app.post("/api/fahrzeuge", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const wagennummer = (req.body && req.body.wagennummer || "").trim();
  if (!wagennummer) return res.status(400).json({ error: "Wagennummer fehlt" });
  const item = {
    id: uid(), wagennummer,
    kennzeichen: (req.body.kennzeichen || "").trim(),
    typ: (req.body.typ || "").trim(),
    art: (req.body.art || "").trim(),
    status: (req.body.status || "einsatzbereit").trim(),
    ort: (req.body.ort || "").trim(),
    bemerkung: (req.body.bemerkung || "").trim(),
  };
  data.fahrzeuge.push(item);
  audit(data, req.user, "Fahrzeug angelegt", (item.wagennummer || item.typ || item.id));
  db.save();
  res.json({ item });
});

app.patch("/api/fahrzeuge/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const fz = data.fahrzeuge.find((f) => f.id === req.params.id);
  if (!fz) return res.status(404).json({ error: "Fahrzeug nicht gefunden" });
  const { status, ort, bemerkung, kennzeichen, typ, art } = req.body || {};
  if (typeof status === "string") fz.status = status;
  if (typeof ort === "string") fz.ort = ort;
  if (typeof bemerkung === "string") fz.bemerkung = bemerkung;
  if (typeof kennzeichen === "string") fz.kennzeichen = kennzeichen;
  if (typeof typ === "string") fz.typ = typ;
  if (typeof art === "string") fz.art = art;
  audit(data, req.user, "Fahrzeug bearbeitet", (fz.wagennummer || fz.typ || fz.id));
  db.save();
  res.json({ item: fz });
});

app.delete("/api/fahrzeuge/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const i = data.fahrzeuge.findIndex((f) => f.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Fahrzeug nicht gefunden" });
  data.fahrzeuge.splice(i, 1);
  data.duties.forEach((d) => {
    if (d.vehicleId === req.params.id) d.vehicleId = null;
    (d.trips || []).forEach((t) => { if (t.vehicleId === req.params.id) t.vehicleId = null; });
  });
  audit(data, req.user, "Fahrzeug gelöscht", req.params.id);
  db.save();
  res.json({ ok: true });
});

// ---------- Fahrtenbuch ----------

app.get("/api/fahrtenbuch", requireAuth, (req, res) => {
  const data = db.load();
  const weeks = fbWeekCutoffWeeks(req.user.role);
  const cutoff = fbCutoffDate(weeks);
  const entries = (data.fahrtenbuch || [])
    .filter((e) => (e.datum || "") >= cutoff)
    .map((e) => enrichFbEntry(data, e))
    .sort((a, b) => String(b.datum).localeCompare(String(a.datum)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ entries, weeks, todayOpen: fbTodayOpen(data, req.user) });
});

app.post("/api/fahrtenbuch", requireAuth, (req, res) => {
  const data = db.load();
  const isSup = req.user.role === "supervisor";
  const v = fbValidate(req.body, isSup, req.user);
  if (!v.ok) return res.status(400).json({ error: v.errors.join("; ") });
  const b = req.body;
  const driverUserId = isSup && b.driverUserId
    ? (data.users.find((u) => u.id === b.driverUserId) || { id: null }).id
    : req.user.id;
  const entry = {
    id: uid(),
    vehicleId: b.vehicleId,
    datum: String(b.datum).trim(),
    linieId: b.linieId,
    driverUserId,
    fahrername: isSup && b.fahrername ? String(b.fahrername).trim().slice(0, 80)
      : (req.user.displayName || req.user.username || req.user.id),
    blitzer: b.blitzer,
    defekte: b.defekte,
    behoben: b.behoben,
    info: String(b.info || "").trim().slice(0, 500),
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    updatedBy: null,
  };
  data.fahrtenbuch.push(entry);
  audit(data, req.user, "Fahrtenbuch angelegt", `Fahrzeug ${enrichFbEntry(data, entry).vehicle}, ${entry.datum}, ${entry.fahrername}`);
  db.save();
  res.json({ entry: enrichFbEntry(data, entry) });
});

app.patch("/api/fahrtenbuch/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const e = (data.fahrtenbuch || []).find((x) => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: "Eintrag nicht gefunden" });
  const b = req.body || {};
  if (typeof b.datum === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.datum.trim()) && !isNaN(new Date(b.datum.trim()).getTime())) e.datum = b.datum.trim();
  if (typeof b.linieId === "string" && data.linien.find((l) => l.id === b.linieId)) e.linieId = b.linieId;
  if (typeof b.vehicleId === "string" && vehicleById(b.vehicleId)) e.vehicleId = b.vehicleId;
  if (typeof b.fahrername === "string") e.fahrername = b.fahrername.trim().slice(0, 80);
  if (b.driverUserId) { const u = data.users.find((x) => x.id === b.driverUserId); if (u) e.driverUserId = u.id; }
  if (isIntNum(b.blitzer)) e.blitzer = b.blitzer;
  if (isIntNum(b.defekte)) e.defekte = b.defekte;
  if (isIntNum(b.behoben)) e.behoben = b.behoben;
  if (typeof b.info === "string") e.info = b.info.trim().slice(0, 500);
  if (isIntNum(e.defekte) && isIntNum(e.behoben) && e.behoben > e.defekte) {
    return res.status(400).json({ error: "Beim Ende behoben darf nicht höher sein als die Defekte" });
  }
  e.updatedBy = req.user.id;
  e.updatedAt = new Date().toISOString();
  audit(data, req.user, "Fahrtenbuch bearbeitet", `Fahrzeug ${enrichFbEntry(data, e).vehicle}, ${e.datum}, ${enrichFbEntry(data, e).fahrername}`);
  db.save();
  res.json({ entry: enrichFbEntry(data, e) });
});

app.delete("/api/fahrtenbuch/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const i = (data.fahrtenbuch || []).findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Eintrag nicht gefunden" });
  const [removed] = data.fahrtenbuch.splice(i, 1);
  audit(data, req.user, "Fahrtenbuch gelöscht", "Fahrzeug " + enrichFbEntry(data, removed).vehicle + ", " + removed.datum + ", " + enrichFbEntry(data, removed).fahrername);
  db.save();
  res.json({ ok: true });
});

app.get("/api/supervisor-log", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const items = (data.supervisorLog || []).slice(-1000).reverse();
  res.json({ items });
});

// ---------- Shifts (erstellen = Tagesplan automatisch kopieren) ----------

function tagesplanShift(data) {
  return data.shifts.find((s) => s.id === "tpl-tagesplan");
}

// ---------- Dutys auf die Shift-Zeit zuschneiden ----------
function toMin(hhmm) {
  if (typeof hhmm !== "string" || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const p = hhmm.split(":");
  return Number(p[0]) * 60 + Number(p[1]);
}
function tripKey(t) {
  return [t.dep, t.arr, t.from, t.to, t.leerfahrt ? "L" : "F"].join("|");
}
function tripInWindow(t, sMin, eMin) {
  const dep = toMin(t && t.dep);
  if (dep === null) return true; // keine/ungültige Zeit → nicht schneiden
  if (sMin !== null && dep < sMin) return false;
  if (eMin !== null && dep > eMin) return false;
  return true;
}
function cloneTrip(t) {
  return {
    ...t, id: uid(), vehicleId: null, assignedUserId: null,
    cancelled: false, cancelNote: "", bemerkung: "",
    stops: (t.stops || []).map((s) => ({ ...s, id: uid(), cancelled: false })),
  };
}
function recomputeDutyTimes(duty) {
  const trips = (duty.trips || []).slice().sort((a, b) => (toMin(a.dep) || 0) - (toMin(b.dep) || 0));
  if (trips.length) {
    duty.startTime = trips[0].dep;
    duty.endTime = trips[trips.length - 1].arr;
  } else {
    duty.startTime = "";
    duty.endTime = "";
  }
}
// Bei Neuanlage/Kopie: frisch kopierte Fahrten auf das Shift-Zeitfenster beschränken
function cutDutyToShiftTimes(duty, shift) {
  const sMin = toMin(shift.startTime || "");
  const eMin = toMin(shift.endTime || "");
  if (sMin === null && eMin === null) return;
  duty.trips = (duty.trips || []).filter((t) => tripInWindow(t, sMin, eMin));
  recomputeDutyTimes(duty);
  addLineChangesToDuty(duty);
}

function addLineChangesToDuty(duty) {
  const trips = (duty.trips || []).filter((t) => !t.cancelled);
  if (trips.length < 2) return;
  const lines = trips.map((t) => t.linieId || duty.linieId).filter(Boolean);
  const uniqueLines = [...new Set(lines)];
  if (uniqueLines.length <= 1) return;
  // Linienwechsel erkennen
  let lastLine = null;
  const changes = [];
  trips.forEach((t) => {
    const tLine = t.linieId || duty.linieId;
    if (tLine && tLine !== lastLine) {
      changes.push({ line: tLine, time: t.dep, from: t.from, to: t.to });
      lastLine = tLine;
    }
  });
  if (changes.length > 1) {
    // Ersten Eintrag ist Startlinie, danach Wechsel
    const startLine = changes[0].line;
    const switches = changes.slice(1).map((c) => `${c.time} ${c.line} (${c.from}→${c.to})`).join(" | ");
    duty.linienwechsel = `Start: ${startLine} | Wechsel: ${switches}`;
  }
}
// Bei geänderter Shift-Zeit: vorhandene Fahrten im Fenster behalten (Edits bleiben),
// außerhalb liegende entfernen und (bei Verlängerung) fehlende Tagesplan-Fahrten ergänzen.
function syncDutyToShiftTimes(duty, tplDuty, sMin, eMin) {
  if (sMin === null && eMin === null) return;
  const keep = (duty.trips || []).filter((t) => tripInWindow(t, sMin, eMin));
  const keys = new Set(keep.map(tripKey));
  (tplDuty.trips || [])
    .filter((t) => tripInWindow(t, sMin, eMin) && !keys.has(tripKey(t)))
    .forEach((t) => keep.push(cloneTrip(t)));
  duty.trips = keep.slice().sort((a, b) => (toMin(a.dep) || 0) - (toMin(b.dep) || 0));
  recomputeDutyTimes(duty);
}

app.get("/api/shifts", requireAuth, (req, res) => {
  const data = db.load();
  const items = data.shifts.map((s) => ({
    ...s,
    dutyCount: data.duties.filter((d) => d.shiftId === s.id).length,
    hostName: (data.users.find((u) => u.id === s.hostId) || {}).username || null,
    coSupervisorNames: (s.coSupervisorIds || []).map((id) => (data.users.find((u) => u.id === id) || {}).username).filter(Boolean),
  }));
  res.json({ shifts: items });
});

app.post("/api/shifts", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const { name, date, startTime, endTime, notes, hostId, coSupervisorIds, fromTemplate } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name fehlt" });

  // Host aus Supervisoren wählen
  const supers = data.users.filter((u) => u.role === "supervisor");
  let host = supers.find((u) => u.id === hostId);
  if (!host) host = req.user.role === "supervisor" ? req.user : supers[0];
  if (!host) return res.status(400).json({ error: "Mindestens ein Supervisor nötig" });

  const co = (coSupervisorIds || [])
    .filter((id) => supers.find((u) => u.id === id))
    .filter((id) => id !== host.id)
    .slice(0, 2);

  const shift = {
    id: uid(),
    name: name.trim(),
    date: date || "",
    startTime: startTime || "",
    endTime: endTime || "",
    notes: notes || "",
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
    hostId: host.id,
    coSupervisorIds: co,
  };
  data.shifts.push(shift);

  // Optional: Dutys automatisch aus dem Tagesplan kopieren (Standard = true)
  let copied = 0;
  if (fromTemplate !== false) {
    const tpl = tagesplanShift(data);
    if (tpl) {
      const templateDuties = data.duties.filter((d) => d.shiftId === tpl.id);
      templateDuties.forEach((d, idx) => {
        const nd = {
          ...d,
          id: uid(),
          shiftId: shift.id,
          name: "Duty " + (idx + 1),
          kurs: "",
          assignment: undefined,
          assignedUserId: null,
          vehicleId: null,
          cancelled: false,
          cancelNote: "",
          bemerkung: "",
          trips: (d.trips || []).map((t) => ({
            ...t, id: uid(),
            vehicleId: null,
            assignedUserId: null,
            cancelled: false,
            cancelNote: "",
            bemerkung: "",
            stops: (t.stops || []).map((s) => ({ ...s, id: uid(), cancelled: false })),
          })),
        };
        cutDutyToShiftTimes(nd, shift);
        data.duties.push(nd);
        copied++;
      });
    }
  }
  audit(data, req.user, "Shift angelegt", shift.name + " (" + (shift.date || "ohne Datum") + ")");
  db.save();

  if (copied) notifyAll(`Neue Shift „${shift.name}“ ist da – ${copied} Dutys automatisch übernommen.`, "info");
  res.json({ shift, copiedDuties: copied });
});

app.patch("/api/shifts/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const s = data.shifts.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Shift nicht gefunden" });
  // Nur Host oder Co-Supervisoren dürfen Shift bearbeiten
  const isHost = s.hostId === req.user.id;
  const isCo = (s.coSupervisorIds || []).includes(req.user.id);
  if (!isHost && !isCo) return res.status(403).json({ error: "Nur der Shift-Host oder Co-Supervisoren dürfen diesen Shift bearbeiten" });
  const { name, date, startTime, endTime, notes, hostId, coSupervisorIds } = req.body || {};
  if (typeof name === "string") s.name = name.trim();
  if (typeof date === "string") s.date = date;
  if (typeof startTime === "string") s.startTime = startTime;
  if (typeof endTime === "string") s.endTime = endTime;
  if (typeof notes === "string") s.notes = notes;
  if (typeof hostId === "string") s.hostId = hostId;
  if (Array.isArray(coSupervisorIds)) {
    const supers = data.users.filter((u) => u.role === "supervisor");
    s.coSupervisorIds = coSupervisorIds
      .filter((id) => supers.find((u) => u.id === id))
      .filter((id) => id !== s.hostId)
      .slice(0, 2);
  }

  // Shift-Zeit geändert → Dutys aufs neue Fenster schneiden bzw. bei Verlängerung ergänzen
  if (typeof startTime === "string" || typeof endTime === "string") {
    const sMin = toMin(s.startTime || "");
    const eMin = toMin(s.endTime || "");
    if (sMin !== null || eMin !== null) {
      const tpl = tagesplanShift(data);
      const tplDuties = tpl ? data.duties.filter((d) => d.shiftId === tpl.id) : [];
      data.duties.filter((d) => d.shiftId === s.id).forEach((d) => {
        const tplDuty = tplDuties.find((t) => t.name === d.name) || { trips: [] };
        syncDutyToShiftTimes(d, tplDuty, sMin, eMin);
      });
    }
  }

  audit(data, req.user, "Shift bearbeitet", s.name + " (" + (s.date || "ohne Datum") + ")");
  db.save();
  res.json({ shift: s });
});

app.delete("/api/shifts/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const i = data.shifts.findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Shift nicht gefunden" });
  data.shifts.splice(i, 1);
  const ids = new Set(data.duties.filter((d) => d.shiftId === req.params.id).map((d) => d.id));
  data.duties = data.duties.filter((d) => d.shiftId !== req.params.id);
  data.applications = data.applications.filter((a) => a.shiftId !== req.params.id);
  data.wishes = data.wishes.filter((w) => !ids.has(w.dutyId));
  audit(data, req.user, "Shift gelöscht", req.params.id);
  db.save();
  res.json({ ok: true });
});

app.post("/api/shifts/:id/copy", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const src = data.shifts.find((s) => s.id === req.params.id);
  if (!src) return res.status(404).json({ error: "Shift nicht gefunden" });
  const supers = data.users.filter((u) => u.role === "supervisor");
  const shift = {
    id: uid(),
    name: (req.body.name || src.name + " (Kopie)").trim(),
    date: req.body.date || src.date || "",
    startTime: src.startTime || "",
    endTime: src.endTime || "",
    notes: src.notes || "",
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
    hostId: (supers.find((u) => u.id === src.hostId) || req.user).id,
    coSupervisorIds: (src.coSupervisorIds || []).filter((id) => supers.find((u) => u.id === id)).slice(0, 2),
  };
  data.shifts.push(shift);
  data.duties.filter((d) => d.shiftId === src.id).forEach((d) => {
    const nd = {
      ...d, id: uid(), shiftId: shift.id,
      assignedUserId: null, vehicleId: null, cancelled: false, cancelNote: "", bemerkung: "",
      trips: (d.trips || []).map((t) => ({
        ...t, id: uid(), vehicleId: null, assignedUserId: null,
        cancelled: false, cancelNote: "", bemerkung: "",
        stops: (t.stops || []).map((s) => ({ ...s, id: uid(), cancelled: false })),
      })),
    };
    // Kopierte Dutys auf die (ggf. verschobenen) Shift-Zeiten begrenzen
    cutDutyToShiftTimes(nd, shift);
    data.duties.push(nd);
  });
  audit(data, req.user, "Shift kopiert", src.name + " → " + shift.name);
  db.save();
  res.json({ shift });
});

// ---------- Duties ----------

app.get("/api/shifts/:id/duties", requireAuth, (req, res) => {
  const data = db.load();
  const shift = data.shifts.find((s) => s.id === req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift nicht gefunden" });
  const duties = data.duties.filter((d) => d.shiftId === shift.id).map((d) => enrichDuty(d));
  const supers = data.users.filter((u) => u.role === "supervisor");
  res.json({
    shift: { ...shift, hostName: (data.users.find((u) => u.id === shift.hostId) || {}).username, coSupervisorNames: (shift.coSupervisorIds || []).map((id) => (data.users.find((u) => u.id === id) || {}).username).filter(Boolean) },
    duties,
    supervisoren: supers.map(publicUser),
  });
});

app.get("/api/duties/:id", requireAuth, (req, res) => {
  const duty = db.load().duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  res.json({ duty: enrichDuty(duty) });
});

app.post("/api/shifts/:id/duties", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const shift = data.shifts.find((s) => s.id === req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift nicht gefunden" });
  const { name, linieId, kurs, notes, unit, startTime, endTime, linienwechsel, art, kundenserviceStandortId } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name fehlt" });
  const dutyArt = art || "bus";
  const duty = {
    id: uid(), shiftId: shift.id,
    art: dutyArt,
    linieId: dutyArt === "bus" ? (linieId || null) : null, kurs: kurs || "",
    name: name.trim(), vehicleId: null, unit: unit || "",
    startTime: startTime || "", endTime: endTime || "",
    notes: notes || "", bemerkung: "",
    linienwechsel: linienwechsel || "",
    cancelled: false, cancelNote: "",
    assignedUserId: null, trips: [], createdAt: new Date().toISOString(),
    kundenserviceStandortId: dutyArt === "kundenservice" ? (kundenserviceStandortId || null) : null,
  };
  data.duties.push(duty);
  audit(data, req.user, "Duty angelegt", duty.name);
  db.save();
  res.json({ duty: enrichDuty(duty) });
});

app.patch("/api/duties/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const shift = data.shifts.find((s) => s.id === duty.shiftId);
  if (!shift) return res.status(404).json({ error: "Shift nicht gefunden" });
  const isHost = shift.hostId === req.user.id;
  const isCo = (shift.coSupervisorIds || []).includes(req.user.id);
  if (!isHost && !isCo) return res.status(403).json({ error: "Nur der Shift-Host oder Co-Supervisoren dürfen diese Duty bearbeiten" });
  const { name, linieId, kurs, vehicleId, notes, bemerkung, cancelled, cancelNote, assignedUserId, unit, startTime, endTime, linienwechsel } = req.body || {};
  let notifyMsg = null;
  if (typeof name === "string") duty.name = name.trim();
  if (typeof linieId !== "undefined") duty.linieId = linieId;
  if (typeof kurs === "string") duty.kurs = kurs;
  if (typeof notes === "string") duty.notes = notes;
  if (typeof bemerkung === "string") duty.bemerkung = bemerkung;
  if (typeof unit === "string") duty.unit = unit;
  if (typeof startTime === "string") duty.startTime = startTime;
  if (typeof endTime === "string") duty.endTime = endTime;
  if (typeof linienwechsel === "string") duty.linienwechsel = linienwechsel;
  if (typeof art !== "undefined") duty.art = art;
  if (typeof kundenserviceStandortId !== "undefined") duty.kundenserviceStandortId = art === "kundenservice" ? kundenserviceStandortId : null;

  // Zeiten anpassen → Fahrtenzeiten NICHT automatisch verschieben (nur §bezeichnung)
  if (typeof vehicleId !== "undefined") {
    const force = req.body.force === true;
    duty.vehicleId = vehicleId;
    // Prüfen ob Fahrzeugtyp zur Linie passt
    if (vehicleId && duty.linieId && !force) {
      const data2 = db.load();
      const line = data2.linien.find((l) => l.id === duty.linieId);
      const vehicle = data2.fahrzeuge.find((f) => f.id === vehicleId);
      if (line && line.requiredVehicleType && vehicle && vehicle.art && vehicle.art !== line.requiredVehicleType) {
        return res.status(400).json({ 
          error: `Fahrzeugtyp "${vehicle.art}" passt nicht zur Linie ${line.name} (erforderlich: ${line.requiredVehicleType})`,
          warning: true,
          lineRequired: line.requiredVehicleType,
          vehicleType: vehicle.art
        });
      }
    }
  }

  if (typeof cancelNote === "string") duty.cancelNote = cancelNote;
  if (typeof cancelled === "boolean") {
    duty.cancelled = cancelled;
  }

  if (typeof assignedUserId !== "undefined") {
    if (assignedUserId) {
      const konflikt = zuteilungsKonflikt(assignedUserId, duty, null, null, null);
      if (konflikt) return res.status(400).json({ error: konflikt });
    }
    const alt = duty.assignedUserId;
    duty.assignedUserId = assignedUserId;
    if (assignedUserId && assignedUserId !== alt) {
      notify(assignedUserId, `Du wurdest der Duty "${duty.name}" zugeteilt.`, "success");
    }
  }
  audit(data, req.user, "Duty bearbeitet", duty.name);
  db.save();
  res.json({ duty: enrichDuty(duty) });
});

// Fahrer-Tausch zwischen zwei Dutys
app.post("/api/duties/swap-driver", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const { dutyId1, dutyId2 } = req.body || {};
  if (!dutyId1 || !dutyId2 || dutyId1 === dutyId2) {
    return res.status(400).json({ error: "Zwei verschiedene Duty-IDs erforderlich" });
  }
  const d1 = data.duties.find((d) => d.id === dutyId1);
  const d2 = data.duties.find((d) => d.id === dutyId2);
  if (!d1 || !d2) return res.status(404).json({ error: "Eine oder beide Dutys nicht gefunden" });
  const u1 = d1.assignedUserId;
  const u2 = d2.assignedUserId;
  if (!u1 && !u2) return res.status(400).json({ error: "Kein Fahrer zum Tauschen vorhanden" });
  // Konfliktprüfung für beide Richtungen
  if (u2) {
    const konflikt1 = zuteilungsKonflikt(u2, d1, null, null, null);
    if (konflikt1) return res.status(400).json({ error: "Tausch nicht möglich: " + konflikt1 });
  }
  if (u1) {
    const konflikt2 = zuteilungsKonflikt(u1, d2, null, null, null);
    if (konflikt2) return res.status(400).json({ error: "Tausch nicht möglich: " + konflikt2 });
  }
  d1.assignedUserId = u2;
  d2.assignedUserId = u1;
  if (u2) notify(u2, `Du wurdest der Duty "${d1.name}" zugeteilt (Tausch).`, "info");
  if (u1) notify(u1, `Du wurdest der Duty "${d2.name}" zugeteilt (Tausch).`, "info");
  audit(data, req.user, "Fahrer getauscht", `${d1.name} <-> ${d2.name}`);
  db.save();
  res.json({ duty1: enrichDuty(d1), duty2: enrichDuty(d2) });
});

app.delete("/api/duties/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const i = data.duties.findIndex((d) => d.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Duty nicht gefunden" });
  const [removed] = data.duties.splice(i, 1);
  data.wishes = data.wishes.filter((w) => w.dutyId !== req.params.id);
  audit(data, req.user, "Duty gelöscht", removed.name || removed.id);
  db.save();
  res.json({ ok: true });
});

// ---------- Fahrten (Trips) ----------

app.post("/api/duties/:id/trips", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const { from, to, dep, arr, vehicleId, bemerkung, leerfahrt } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: "Von/Ziel fehlen" });
  const trip = {
    id: uid(), from, to, dep: dep || "", arr: arr || "",
    vehicleId: vehicleId || null, assignedUserId: null,
    bemerkung: bemerkung || "", leerfahrt: !!leerfahrt,
    cancelled: false, cancelNote: "", stops: [],
  };
  duty.trips.push(trip);
  duty.trips = sortTrips(duty).trips;
  audit(data, req.user, "Fahrt angelegt", duty.name + " · " + from + " → " + to);
  db.save();
  res.json({ duty: enrichDuty(duty) });
});

app.patch("/api/duties/:id/trips/:tripId", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const trip = (duty.trips || []).find((t) => t.id === req.params.tripId);
  if (!trip) return res.status(404).json({ error: "Fahrt nicht gefunden" });
  const { from, to, dep, arr, vehicleId, bemerkung, cancelled, cancelNote, assignedUserId } = req.body || {};

  if (typeof from === "string") trip.from = from;
  if (typeof to === "string") trip.to = to;
  if (typeof dep === "string") trip.dep = dep;
  if (typeof arr === "string") trip.arr = arr;
  if (typeof vehicleId !== "undefined") {
    const force = req.body.force === true;
    trip.vehicleId = vehicleId;
    // Prüfen ob Fahrzeugtyp zur Linie passt
    if (vehicleId && duty.linieId && !force) {
      const line = data.linien.find((l) => l.id === duty.linieId);
      const vehicle = data.fahrzeuge.find((f) => f.id === vehicleId);
      if (line && line.requiredVehicleType && vehicle && vehicle.art && vehicle.art !== line.requiredVehicleType) {
        return res.status(400).json({ 
          error: `Fahrzeugtyp "${vehicle.art}" passt nicht zur Linie ${line.name} (erforderlich: ${line.requiredVehicleType})`,
          warning: true,
          lineRequired: line.requiredVehicleType,
          vehicleType: vehicle.art
        });
      }
    }
  }
  if (typeof bemerkung === "string") trip.bemerkung = bemerkung;
  if (typeof cancelNote === "string") trip.cancelNote = cancelNote;
  if (typeof cancelled === "boolean") trip.cancelled = cancelled;

  if (typeof assignedUserId !== "undefined") {
    if (assignedUserId) {
      const konflikt = zuteilungsKonflikt(assignedUserId, duty, trip.dep, trip.arr, trip.id);
      if (konflikt) return res.status(400).json({ error: konflikt });
    }
    trip.assignedUserId = assignedUserId;
    if (assignedUserId) {
      notify(assignedUserId, `Du wurdest der Fahrt "${trip.from}→${trip.to}" (${duty.name}) zugeteilt.`, "success");
    }
  }
  duty.trips = sortTrips(duty).trips;
  audit(data, req.user, "Fahrt bearbeitet", duty.name + " · " + (trip.from || "") + " → " + (trip.to || ""));
  db.save();
  res.json({ duty: enrichDuty(duty) });
});

app.delete("/api/duties/:id/trips/:tripId", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const trip = (duty.trips || []).find((t) => t.id === req.params.tripId);
  duty.trips = (duty.trips || []).filter((t) => t.id !== req.params.tripId);
  duty.trips = sortTrips(duty).trips;
  audit(data, req.user, "Fahrt gelöscht", duty.name + " · " + ((trip && trip.from) || "") + " → " + ((trip && trip.to) || ""));
  db.save();
  res.json({ duty: enrichDuty(duty) });
});

// ---------- Haltestellen ----------

app.post("/api/duties/:id/trips/:tripId/stops", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const trip = (duty.trips || []).find((t) => t.id === req.params.tripId);
  if (!trip) return res.status(404).json({ error: "Fahrt nicht gefunden" });
  const { station, arr, dep } = req.body || {};
  if (!station) return res.status(400).json({ error: "Station fehlt" });
  trip.stops.push({ id: uid(), station, arr: arr || "", dep: dep || "", cancelled: false });
  db.save();
  res.json({ duty: enrichDuty(duty) });
});

app.patch("/api/duties/:id/trips/:tripId/stops/:stopId", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const trip = (duty.trips || []).find((t) => t.id === req.params.tripId);
  if (!trip) return res.status(404).json({ error: "Fahrt nicht gefunden" });
  const stop = (trip.stops || []).find((s) => s.id === req.params.stopId);
  if (!stop) return res.status(404).json({ error: "Halt nicht gefunden" });
  const { station, arr, dep, cancelled } = req.body || {};
  if (typeof station === "string") stop.station = station;
  if (typeof arr === "string") stop.arr = arr;
  if (typeof dep === "string") stop.dep = dep;
  if (typeof cancelled === "boolean") stop.cancelled = cancelled;
  db.save();
  res.json({ duty: enrichDuty(duty) });
});

app.delete("/api/duties/:id/trips/:tripId/stops/:stopId", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const trip = (duty.trips || []).find((t) => t.id === req.params.tripId);
  if (!trip) return res.status(404).json({ error: "Fahrt nicht gefunden" });
  trip.stops = (trip.stops || []).filter((s) => s.id !== req.params.stopId);
  db.save();
  res.json({ duty: enrichDuty(duty) });
});

// ---------- Wünsche (Duty-Wunsch) ----------

app.get("/api/wishes", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const items = data.wishes.map((w) => {
    const duty = data.duties.find((d) => d.id === w.dutyId);
    const user = data.users.find((u) => u.id === w.userId);
    const shift = duty ? data.shifts.find((s) => s.id === duty.shiftId) : null;
    const line = duty ? data.linien.find((l) => l.id === duty.linieId) : null;
    return {
      ...w,
      dutyName: duty ? duty.name : "?",
      linie: line ? line.name : "",
      shiftId: duty ? duty.shiftId : null,
      shiftName: shift ? shift.name : "?",
      shiftStart: duty && duty.trips.length ? duty.trips[0].dep : "",
      shiftEnd: duty && duty.trips.length ? duty.trips[duty.trips.length - 1].arr : "",
      username: user ? user.username : "?",
      vehicleName: duty ? (vehicleById(effectiveVehicle(duty)) || {}).wagennummer : null,
    };
  });
  res.json({ wishes: items });
});

app.post("/api/duties/:id/wish", requireAuth, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  if (!hasLineLicense(req.user, duty.linieId)) return res.status(400).json({ error: "Keine Linien-Lizenz für diese Duty" });
  if (req.user.strafstunden >= 3) return res.status(400).json({ error: "Ab 3 Strafstunden sind keine Duty-Anmeldungen möglich" });
  if (duty.assignedUserId === req.user.id) return res.status(400).json({ error: "Bereits zugeteilt" });
  if (data.wishes.find((w) => w.dutyId === duty.id && w.userId === req.user.id && w.status === "pending")) {
    return res.status(400).json({ error: "Wunsch bereits vorhanden" });
  }
  data.wishes.push({ id: uid(), dutyId: duty.id, userId: req.user.id, status: "pending", createdAt: new Date().toISOString() });
  db.save();
  notifyAll(`${req.user.username} wünscht Duty "${duty.name}".`, "wish");
  res.json({ ok: true });
});

app.post("/api/wishes/:id/accept", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const wish = data.wishes.find((w) => w.id === req.params.id);
  if (!wish) return res.status(404).json({ error: "Wunsch nicht gefunden" });
  const duty = data.duties.find((d) => d.id === wish.dutyId);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const konflikt = zuteilungsKonflikt(wish.userId, duty, null, null, null);
  if (konflikt) return res.status(400).json({ error: konflikt });
  wish.status = "accepted";
  duty.assignedUserId = wish.userId;
  audit(data, req.user, "Wunsch angenommen", duty.name + " → " + (data.users.find((u) => u.id === wish.userId) || {}).username);
  db.save();
  notify(wish.userId, `Dein Wunsch für "${duty.name}" wurde angenommen – du bist zugeteilt.`, "success");
  res.json({ ok: true });
});

app.post("/api/wishes/:id/deny", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const wish = data.wishes.find((w) => w.id === req.params.id);
  if (!wish) return res.status(404).json({ error: "Wunsch nicht gefunden" });
  wish.status = "denied";
  const duty = data.duties.find((d) => d.id === wish.dutyId);
  audit(data, req.user, "Wunsch abgelehnt", duty ? duty.name : "?", " " + (data.users.find((u) => u.id === wish.userId) || {}).username);
  db.save();
  if (duty) notify(wish.userId, `Dein Wunsch für "${duty.name}" wurde abgelehnt.`, "danger");
  res.json({ ok: true });
});

// ---------- Anmeldungen (Shift + Kundenservice, von–bis) ----------

function enrichApplication(a) {
  const data = db.load();
  const user = data.users.find((u) => u.id === a.userId);
  const shift = data.shifts.find((s) => s.id === a.shiftId) || null;
  const standort = a.standortId ? data.kundenservice.find((k) => k.id === a.standortId) : null;
  return {
    ...a,
    username: user ? user.username : "?",
    roleLabel: user ? roleLabel(user.role) : "?",
    linien: user ? (user.linien || []) : [],
    strafstunden: user ? user.strafstunden : 0,
    kündigung: user ? user.strafstunden >= 20 : false,
    shiftName: shift ? shift.name : "?",
    shiftDate: shift ? shift.date : "",
    shiftStart: shift ? shift.startTime : "",
    shiftEnd: shift ? shift.endTime : "",
    standortName: standort ? standort.name : null,
  };
}

app.get("/api/applications", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const { nutzer, shift } = req.query || {};
  let items = data.applications.map(enrichApplication);
  if (nutzer) items = items.filter((a) => (a.username || "").toLowerCase().includes(String(nutzer).toLowerCase()));
  if (shift) items = items.filter((a) => (a.shiftName || "").toLowerCase().includes(String(shift).toLowerCase()));
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ applications: items, supervisoren: data.users.filter((u) => u.role === "supervisor").map(publicUser) });
});

app.get("/api/my/applications", requireAuth, (req, res) => {
  const data = db.load();
  const items = data.applications
    .filter((a) => a.userId === req.user.id)
    .map(enrichApplication)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ applications: items });
});

// Anmeldung erstellen (Shift-Busfahren oder Kundenservice)
app.post("/api/applications", requireAuth, (req, res) => {
  const data = db.load();
  const { shiftId, von, bis, art, standortId, hinweis } = req.body || {};
  if (!shiftId) return res.status(400).json({ error: "Shift fehlt" });
  if (!von || !bis) return res.status(400).json({ error: "Von–bis fehlt" });

  const artK = art === "kundenservice" ? "kundenservice" : "bus";
  if (artK === "kundenservice") {
    const standort = data.kundenservice.find((k) => k.id === standortId);
    if (!standort) return res.status(400).json({ error: "Standort fehlt" });
    if (durMinutes(von, bis) < 30) return res.status(400).json({ error: "Kundenservice: mindestens 30 Minuten" });
  } else {
    if (req.user.strafstunden >= 3) {
      return res.status(400).json({ error: "Ab 3 Strafstunden kannst du dich nur noch für Kundenservice anmelden" });
    }
    if (durMinutes(von, bis) < 75) return res.status(400).json({ error: "Busfahren: mindestens 1 h 15 min" });
  }

  const existing = data.applications.find(
    (a) => a.userId === req.user.id && a.status !== "denied" && a.art === artK && a.shiftId === shiftId &&
      a.standortId === (standortId || null)
  );
  if (existing) return res.status(400).json({ error: "Du bist dafür bereits angemeldet" });

  // Pro Person & Shift nur EINE Funktion: Busfahren ODER Kundenservice.
  const andereFunktion = data.applications.find(
    (a) => a.userId === req.user.id && a.status !== "denied" && a.shiftId === shiftId && a.art !== artK
  );
  if (andereFunktion) {
    return res.status(400).json({ error: "Du kannst in derselben Shift nicht Busfahren und Kundenservice gleichzeitig machen" });
  }

  const appEntry = {
    id: uid(), shiftId,
    userId: req.user.id,
    von, bis,
    art: artK,
    standortId: artK === "kundenservice" ? standortId : null,
    hinweis: (hinweis || "").trim(),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  data.applications.push(appEntry);
  db.save();
  notifyAll(`${req.user.username} meldet sich für "${artK === "kundenservice" ? "Kundenservice" : "Busfahren"}" an.`, "apply");
  res.json({ application: enrichApplication(appEntry) });
});

app.post("/api/applications/:id/accept", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const a = data.applications.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "Anmeldung nicht gefunden" });
  a.status = "accepted";
  audit(data, req.user, "Anmeldung angenommen", (data.users.find((u) => u.id === a.userId) || {}).username + " · " + a.art + " · " + a.von + "–" + a.bis);
  db.save();
  notify(a.userId, "Deine Anmeldung wurde angenommen.", "success");
  res.json({ ok: true });
});

app.post("/api/applications/:id/deny", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const a = data.applications.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "Anmeldung nicht gefunden" });
  a.status = "denied";
  audit(data, req.user, "Anmeldung abgelehnt", (data.users.find((u) => u.id === a.userId) || {}).username + " · " + a.art + " · " + a.von + "–" + a.bis);
  db.save();
  notify(a.userId, "Deine Anmeldung wurde abgelehnt.", "danger");
  res.json({ ok: true });
});

app.delete("/api/applications/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const a = data.applications.find((x) => x.id === req.params.id);
  data.applications = data.applications.filter((x) => x.id !== req.params.id);
  audit(data, req.user, "Anmeldung gelöscht", a ? ((data.users.find((u) => u.id === a.userId) || {}).username + " · " + a.art) : req.params.id);
  db.save();
  res.json({ ok: true });
});

// Meine eigene Anmeldung zurückziehen (falls noch pending, bis max. 24h vor Shift-Start)
app.delete("/api/my/applications/:id", requireAuth, (req, res) => {
  const data = db.load();
  const a = data.applications.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!a) return res.status(404).json({ error: "Anmeldung nicht gefunden" });
  if (a.status !== "pending") return res.status(400).json({ error: "Nur ausstehende Anmeldungen zurückziehbar" });
  // Prüfen: Shift-Start liegt mehr als 24h in der Zukunft?
  const shift = data.shifts.find((s) => s.id === a.shiftId);
  if (shift && shift.date && shift.startTime) {
    const shiftStart = new Date(shift.date + "T" + shift.startTime);
    const now = new Date();
    const diffMs = shiftStart - now;
    const diffHours = diffMs / 3600000;
    if (diffHours <= 24) {
      return res.status(400).json({ error: `Rückzug nur bis 24h vor Shift-Start möglich (Shift beginnt ${shift.date} ${shift.startTime})` });
    }
  }
  data.applications = data.applications.filter((x) => x.id !== req.params.id);
  db.save();
  res.json({ ok: true });
});

// ---------- Kundenservice-Standorte ----------

app.get("/api/kundenservice", requireAuth, (req, res) => res.json({ items: db.load().kundenservice }));

app.post("/api/kundenservice", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const name = (req.body && req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name fehlt" });
  const item = {
    id: uid(),
    name,
    startTime: req.body.startTime || "",
    endTime: req.body.endTime || "",
  };
  data.kundenservice.push(item);
  db.save();
  res.json({ item });
});
app.patch("/api/kundenservice/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const k = data.kundenservice.find((x) => x.id === req.params.id);
  if (!k) return res.status(404).json({ error: "Standort nicht gefunden" });
  if (typeof req.body.name === "string") k.name = req.body.name.trim();
  if (typeof req.body.startTime === "string") k.startTime = req.body.startTime;
  if (typeof req.body.endTime === "string") k.endTime = req.body.endTime;
  db.save();
  res.json({ item: k });
});
app.delete("/api/kundenservice/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  data.kundenservice = data.kundenservice.filter((k) => k.id !== req.params.id);
  data.applications.forEach((a) => { if (a.standortId === req.params.id) a.standortId = null; });
  db.save();
  res.json({ ok: true });
});

// ---------- Activity (60 % reine Fahrzeit, ohne Pausen) ----------

const pad2 = (n) => String(n).padStart(2, "0");

// Startdatum (YYYY-MM-DD) des gewählten Zeitraums; monat = Anfang des aktuellen Kalendermonats
function zeitraumFrom(zeitraum) {
  const now = new Date();
  if (zeitraum === "monat") return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
  const d = new Date(now);
  if (zeitraum === "woche") d.setDate(now.getDate() - 7);
  else if (zeitraum === "jahr") d.setFullYear(now.getFullYear() - 1);
  else return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Reine Fahrzeit je Nutzer aus Zuteilungen (Dutys + Einzelfahrten)
function fahrZeitData(fromDateStr) {
  const data = db.load();
  const proUser = {};
  data.users.forEach((u) => (proUser[u.id] = { userId: u.id, fahrMin: 0, spanneMin: 0, activityMin: 0 }));

  const addRange = (userId, dep, arr) => {
    if (!userId || !dep || !arr) return;
    const f = Math.max(0, durMinutes(dep, arr));
    proUser[userId].fahrMin += f;
  };

  data.duties.forEach((d) => {
    if (d.cancelled) return;
    const dDate = d.date || ((data.shifts.find((s) => s.id === d.shiftId) || {}).date) || "";
    if (fromDateStr && dDate && dDate < fromDateStr) return;
    if (d.assignedUserId) {
      const trips = d.trips.filter((t) => !t.cancelled && !t.leerfahrt);
      if (trips.length) {
        proUser[d.assignedUserId].fahrMin += Math.max(0, durMinutes(trips[0].dep, trips[trips.length - 1].arr));
        proUser[d.assignedUserId].spanneMin += Math.max(0, durMinutes(trips[0].dep, trips[trips.length - 1].arr));
      }
    }
    (d.trips || []).forEach((t) => {
      if (t.assignedUserId) addRange(t.assignedUserId, t.dep, t.arr);
    });
  });

  data.users.forEach((u) => {
    proUser[u.id].activityMin = Math.round((proUser[u.id].fahrMin || 0) * 0.6);
  });
  return proUser;
}

app.get("/api/activity/me", requireAuth, (req, res) => {
  const data = db.load();
  const fromDateStr = zeitraumFrom(req.query.zeitraum);
  const proUser = fahrZeitData(fromDateStr);
  const me = proUser[req.user.id] || { userId: req.user.id, fahrMin: 0, spanneMin: 0, activityMin: 0 };
  const signups = data.activity
    .filter((a) => a.userId === req.user.id && (!fromDateStr || (a.createdAt || "").slice(0, 10) >= fromDateStr))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ ...me, signups, from: fromDateStr });
});

app.post("/api/activity/signup", requireAuth, (req, res) => {
  const data = db.load();
  const { von } = req.body || {};
  const user = req.user;
  const proUser = fahrZeitData();
  const me = proUser[user.id];
  if (!me || me.fahrMin < 60) {
    return res.status(400).json({ error: "Mindestens 1 Stunde reine Fahrzeit nötig (60 % werden für Activity angerechnet)" });
  }
  data.activity.push({
    id: uid(), userId: user.id,
    von: von || new Date().toISOString().slice(0, 16),
    createdAt: new Date().toISOString(),
  });
  db.save();
  res.json({ ok: true });
});

app.get("/api/activity/all", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const { zeitraum } = req.query || {}; // woche | monat | jahr | alle
  const fromDateStr = zeitraumFrom(zeitraum);

  const proUser = fahrZeitData(fromDateStr);
  const rows = data.users.map((u) => ({
    ...proUser[u.id],
    username: u.username,
    roleLabel: roleLabel(u.role),
    signups: u.role === "supervisor" ? [] : data.activity
      .filter((a) => a.userId === u.id && (!fromDateStr || (a.createdAt || "").slice(0, 10) >= fromDateStr))
      .length,
  }));
  res.json({ zeitraum: zeitraum || "alle", from: fromDateStr, rows });
});

// ---------- Nachrichten (Supervisor → Alle/Busfahrer/Senior) ----------

app.post("/api/announcements", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const { text, zielgruppe, dringend } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Text fehlt" });
  const isUrgent = dringend === true || dringend === "true";
  // Dringend erreicht alle aktuell Online-Nutzer – Zielgruppen werden ignoriert.
  const audiences = isUrgent
    ? ["user", "senior", "supervisor"]
    : (Array.isArray(zielgruppe) && zielgruppe.length ? zielgruppe : ["user", "senior", "supervisor"]);
  const rang = roleLabel(req.user.role);

  const ann = {
    id: uid(),
    text: text.trim(),
    zielgruppen: audiences,
    dringend: isUrgent,
    von: req.user.username,
    rang,
    createdAt: new Date().toISOString(),
  };
  data.announcements.push(ann);
  data.notifications.push({
    id: uid(), userId: "announce-" + ann.id, message: ann.text, type: "announce",
    announcementId: ann.id, dringend: ann.dringend, von: ann.von, rang,
    read: false, createdAt: ann.createdAt,
  });
  data.users.forEach((u) => {
    if (audiences.includes(u.role)) {
      data.notifications.push({
        id: uid(), userId: u.id, message: ann.text, type: "announce",
        announcementId: ann.id, dringend: ann.dringend, von: ann.von, rang,
        read: false, createdAt: ann.createdAt,
      });
    }
  });
  audit(data, req.user, "Ansage gesendet", (isUrgent ? "[Dringend] " : "") + audiences.map(roleLabel).join(", ") + " – " + text.trim().slice(0, 80));
  db.save();

  // System-/Desktop-Push an alle Zielgruppen-Nutzer
  const pushers = (data.pushSubscriptions || [])
    .filter((x) => data.users.find((u) => u.id === x.userId && audiences.includes(u.role)));
  pushToSubs(pushers, (isUrgent ? "Dringend – " : "") + "Ansage: " + req.user.username, ann.text);

  // Poll-Erkennung: Bühne über eine zentrale Rückgabe
  res.json({ announcement: ann });
});

app.get("/api/announcements/latest", requireAuth, (req, res) => {
  const data = db.load();
  const items = data.notifications
    .filter((n) => n.type === "announce")
    .filter((n) => {
      if (n.userId === req.user.id) return true; // eigene Ziel-Benachrichtigung
      if (!n.userId.startsWith("announce-")) return false;
      const ann = data.announcements.find((a) => a.id === n.userId.replace("announce-", ""));
      // Dringend erreicht alle Online-Nutzer, unabhängig von der Zielgruppe
      return !!ann && (ann.dringend === true || (ann.zielgruppen || []).includes(req.user.role));
    })
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const latest = items[items.length - 1] || null;
  const unseen = latest
    ? (latest.userId === req.user.id ? !latest.read : !((latest.readSeenBy || {})[req.user.id]))
    : false;
  let latestResult = latest;
  if (latest && latest.userId && latest.userId.startsWith("announce-")) {
    const ann = data.announcements.find((a) => a.id === latest.userId.replace("announce-", ""));
    if (ann) latestResult = { ...latest, dringend: ann.dringend === true, von: ann.von, rang: ann.rang || "" };
  }
  res.json({ latest: latestResult, unseen });
});

// ---------- Benachrichtigungen ----------

app.get("/api/notifications", requireAuth, (req, res) => {
  const data = db.load();
  let items;
  if (req.user.role === "supervisor") {
    items = data.notifications.filter((n) => n.userId === req.user.id || n.userId === "all-supervisors" || n.userId.startsWith("announce-"));
  } else {
    items = data.notifications.filter((n) => n.userId === req.user.id);
  }
  if (req.query.onlyUnread === "1") items = items.filter((n) => !n.read);
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const unread = items.filter((n) => !n.read).length;
  res.json({ notifications: items, unread });
});

app.post("/api/notifications/:id/read", requireAuth, (req, res) => {
  const data = db.load();
  const n = data.notifications.find((x) => x.id === req.params.id);
  if (n) {
    n.read = true;
    if (n.type === "announce" && n.userId.startsWith("announce-")) {
      n.readSeenBy = n.readSeenBy || {};
      n.readSeenBy[req.user.id] = true;
    }
  }
  db.save();
  res.json({ ok: true });
});

app.post("/api/notifications/read-all", requireAuth, (req, res) => {
  const data = db.load();
  data.notifications.forEach((n) => {
    const mine = n.userId === req.user.id ||
      (req.user.role === "supervisor" && (n.userId === "all-supervisors" || n.userId.startsWith("announce-")));
    if (mine) n.read = true;
    if (n.type === "announce" && n.userId.startsWith("announce-")) {
      n.readSeenBy = n.readSeenBy || {};
      n.readSeenBy[req.user.id] = true;
    }
  });
  db.save();
  res.json({ ok: true });
});

// ---------- Web Push (System-/Desktop-Benachrichtigungen) ----------

app.get("/api/push/vapid", (req, res) => {
  res.json({ publicKey: ensureVapidKeys().publicKey });
});

app.post("/api/push/register", requireAuth, (req, res) => {
  const data = db.load();
  const { endpoint, auth, p256dh, ua } = req.body || {};
  if (!endpoint || !auth || !p256dh) {
    return res.status(400).json({ error: "endpoint, auth und p256dh fehlen" });
  }
  data.pushSubscriptions = (data.pushSubscriptions || []).filter((x) => x.userId !== req.user.id || x.endpoint !== endpoint);
  data.pushSubscriptions.push({
    userId: req.user.id,
    endpoint,
    keys: { auth, p256dh },
    ua: ua || "",
    createdAt: new Date().toISOString(),
  });
  db.save();
  res.json({ ok: true });
});

app.post("/api/push/unregister", requireAuth, (req, res) => {
  const data = db.load();
  const { endpoint } = req.body || {};
  if (endpoint) {
    data.pushSubscriptions = (data.pushSubscriptions || []).filter((x) => x.endpoint !== endpoint);
  } else {
    data.pushSubscriptions = (data.pushSubscriptions || []).filter((x) => x.userId !== req.user.id);
  }
  db.save();
  res.json({ ok: true });
});

// ---------- Fahrzeugübersicht ----------

app.get("/api/vehicles/overview", requireAuth, (req, res) => {
  const data = db.load();
  const result = data.fahrzeuge.map((f) => {
    const uses = [];
    data.duties.forEach((d) => {
      if (d.cancelled) return;
      const eff = effectiveVehicle(d);
      const tripsUsing = (d.trips || []).filter((t) => !t.cancelled && (t.vehicleId || d.vehicleId) === f.id);
      if (eff === f.id || tripsUsing.length) {
        const all = d.trips.filter((t) => !t.cancelled);
        uses.push({
          dutyId: d.id, shiftId: d.shiftId, dutyName: d.name,
          shiftName: (data.shifts.find((s) => s.id === d.shiftId) || {}).name,
          shiftDate: (data.shifts.find((s) => s.id === d.shiftId) || {}).date,
          dep: all.length ? all[0].dep : "",
          arr: all.length ? all[all.length - 1].arr : "",
          from: all.length ? all[0].from : "",
          to: all.length ? all[all.length - 1].to : "",
          assignedUserId: d.assignedUserId,
        });
      }
    });
    uses.sort((a, b) => (a.dep || "").localeCompare(b.dep || "", "de", { numeric: true }));
    let status = "kein Einsatz";
    if (uses.length) status = "eingeplant";
    return {
      id: f.id, wagennummer: f.wagennummer, kennzeichen: f.kennzeichen,
      typ: f.typ, art: f.art, status: f.status, ort: f.ort, bemerkung: f.bemerkung,
      einsatzStatus: status, uses,
      spawn: uses[0] ? { from: uses[0].from, dutyName: uses[0].dutyName, dep: uses[0].dep, shiftDate: uses[0].shiftDate } : null,
    };
  });
  res.json({ vehicles: result });
});

// ---------- Health / Statik ----------

app.get("/api/health", (req, res) => {
  const data = db.load();
  res.json({
    ok: true, service: "vbg-website",
    uptime: Math.round(process.uptime()),
    time: new Date().toISOString(),
    duties: data.duties.length, users: data.users.length, fahrzeuge: data.fahrzeuge.length,
  });
});
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;
boot().then(() => {
  try { const removed = cleanupFahrtenbuch(); if (removed) console.log(`Fahrtenbuch-Aufräumlauf: ${removed} Einträge älter als 8 Wochen gelöscht`); } catch (e) { console.error("Fahrtenbuch-Cleanup fehlgeschlagen:", e.message); }
  setInterval(() => { try { cleanupFahrtenbuch(); } catch (e) {} }, 6 * 60 * 60 * 1000);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`VBG Website API läuft auf Port ${PORT}`);
    console.log(`Daten-Datei: ${db.DATA_FILE}`);
  });
});