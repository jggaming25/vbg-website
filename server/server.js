const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const db = require("./db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const SECRET = process.env.JWT_SECRET || "vbg-website-dev-secret-bitte-in-env-setzen-123456";
const TOKEN_TIMEOUT = { normal: "12h", remember: "30d" };

db.load();

// Auto-Seed beim Start: Wenn SEED_FILE gesetzt ist, wird der wiederverwendbare
// Tagesplan (seed/duties.json) importiert – idempotent (Shift-ID "tpl-tagesplan").
const seedCount = db.importDutiesFromFile(process.env.SEED_FILE);
if (seedCount) console.log(`Seed: ${seedCount} Tagesplan-Dutys importiert (${process.env.SEED_FILE}).`);

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

// ---------- Hilfsfunktionen ----------

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    roleLabel: roleLabel(u.role),
    linien: u.linien || [],
    suspended: !!u.suspended,
    protected: !!u.protected,
    createdAt: u.createdAt,
  };
}

function notify(userId, message, type) {
  const data = db.load();
  data.notifications.push({
    id: db.uid(),
    userId,
    message,
    type: type || "info",
    read: false,
    createdAt: new Date().toISOString(),
  });
  db.save();
}

function effectiveVehicle(duty) {
  if (duty.vehicleId) return duty.vehicleId;
  const t = (duty.trips || []).find((x) => x.vehicleId);
  return t ? t.vehicleId : null;
}

// Lizenzprüfung beruht jetzt auf LINIEN (19, (SB)24, 8, N1), nicht mehr auf Fahrzeugen.
function hasLineLicense(user, linieId) {
  if (!linieId) return true; // ohne Linie keine Lizenzpruefung noetig
  return (user.linien || []).includes(linieId);
}

function vehicleById(id) {
  return db.load().fahrzeuge.find((f) => f.id === id) || null;
}

function minuteKey(dep, overnight) {
  const s = String(dep || "");
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return 0;
  let v = Number(m[1]) * 60 + Number(m[2]);
  if (overnight && Number(m[1]) < 12) v += 24 * 60; // Morgenfahrten gehören zum Folgetag
  return v;
}

// Overnight-Dutys (Start ab 20 Uhr oder vor 5 Uhr) sortieren 00:xx-Fahrten ans Ende,
// damit Nachtlinien (z. B. N1 ab 23:20) chronologisch richtig stehen.
function isOvernight(duty) {
  const m = /^(\d{1,2})/.exec(String(duty.startTime || ""));
  if (!m) return false;
  const h = Number(m[1]);
  return h >= 20 || h < 5;
}

function sortTrips(duty) {
  if (!duty.trips) duty.trips = [];
  const overnight = isOvernight(duty);
  duty.trips.sort((a, b) => minuteKey(a.dep, overnight) - minuteKey(b.dep, overnight));
  return duty;
}

// ---------- Auth ----------

function authToken(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  const t = h.slice(7).trim();
  try {
    return jwt.verify(t, SECRET);
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
  if (user.suspended) {
    return res.status(403).json({ error: "Konto gesperrt" });
  }
  req.user = user;
  next();
}

function requireSupervisor(req, res, next) {
  if (req.user.role !== "supervisor") {
    return res.status(403).json({ error: "Nur Supervisor erlaubt" });
  }
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
  if (user.suspended) {
    return res.status(403).json({ error: "Konto ist gesperrt" });
  }
  const token = jwt.sign(
    { sub: user.id, role: user.role },
    SECRET,
    { expiresIn: remember ? TOKEN_TIMEOUT.remember : TOKEN_TIMEOUT.normal }
  );
  res.json({ token, user: publicUser(user) });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post("/api/auth/logout", (req, res) => {
  res.json({ ok: true });
});

// ---------- Nutzer (Supervisor) ----------

app.get("/api/users", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  res.json({ users: data.users.map(publicUser) });
});

app.post("/api/users", async (req, res) => {
  const data = db.load();
  // Bootstrap: erster Nutzer wird automatisch Supervisor.
  if (data.users.length > 0) {
    const payload = authToken(req);
    if (!payload) return res.status(401).json({ error: "Nicht angemeldet" });
    const u2 = data.users.find((x) => x.id === payload.sub);
    if (!u2) return res.status(401).json({ error: "Unbekannter Nutzer" });
    if (u2.suspended) return res.status(403).json({ error: "Konto gesperrt" });
    if (u2.role !== "supervisor") return res.status(403).json({ error: "Nur Supervisor erlaubt" });
  }
  const { username, password, role, linien } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Benutzername und Passwort fehlen" });
  }
  if (data.users.some((u) => u.username.toLowerCase() === username.trim().toLowerCase())) {
    return res.status(400).json({ error: "Benutzername existiert bereits" });
  }
  const validRole = DRIVER_ROLES.includes(role) || role === "supervisor" ? role : "user";
  const user = {
    id: db.uid(),
    username: username.trim(),
    passwordHash: await bcrypt.hash(password, 10),
    role: validRole,
    linien: Array.isArray(linien) ? linien : [],
    suspended: false,
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  db.save();
  res.json({ user: publicUser(user) });
});

app.patch("/api/users/:id", requireAuth, requireSupervisor, async (req, res) => {
  const data = db.load();
  const user = data.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  if (user.protected) {
    return res.status(403).json({ error: "Dieser Nutzer ist geschützt und kann nicht verändert werden" });
  }
  const { role, linien, suspended, password } = req.body || {};
  if (role && (role === "supervisor" || DRIVER_ROLES.includes(role))) user.role = role;
  if (Array.isArray(linien)) user.linien = linien;
  if (typeof suspended === "boolean") user.suspended = suspended;
  if (password) user.passwordHash = await bcrypt.hash(password, 10);
  db.save();
  res.json({ user: publicUser(user) });
});

app.post("/api/users/:id/licenses", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const user = data.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  const { linien = [] } = req.body || {};
  user.linien = Array.from(new Set([...(user.linien || []), ...linien]));
  db.save();
  res.json({ user: publicUser(user) });
});

app.post("/api/users/:id/suspend", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const user = data.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  if (user.protected) {
    return res.status(403).json({ error: "Dieser Nutzer ist geschützt und kann nicht gesperrt werden" });
  }
  if (user.id === req.user.id) {
    return res.status(400).json({ error: "Du kannst dein eigenes Konto nicht sperren" });
  }
  user.suspended = !user.suspended;
  db.save();
  res.json({ user: publicUser(user) });
});

app.delete("/api/users/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const i = data.users.findIndex((u) => u.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  if (data.users[i].protected) {
    return res.status(403).json({ error: "Dieser Nutzer ist geschützt und kann nicht gelöscht werden" });
  }
  if (data.users[i].id === req.user.id) {
    return res.status(400).json({ error: "Du kannst dein eigenes Konto nicht löschen" });
  }
  const [removed] = data.users.splice(i, 1);
  data.wishes = data.wishes.filter((w) => w.userId !== removed.id);
  data.applications = data.applications.filter((a) => a.userId !== removed.id);
  data.duties.forEach((d) => {
    if (d.assignedUserId === removed.id) d.assignedUserId = null;
  });
  db.save();
  res.json({ ok: true });
});

// ---------- Kataloge: Linien (Lizenzen) & Fahrzeuge ----------

app.get("/api/linien", requireAuth, (req, res) => {
  res.json({ items: db.load().linien });
});
app.post("/api/linien", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const name = (req.body && req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name fehlt" });
  if (data.linien.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: "Linie existiert bereits" });
  }
  const item = { id: db.uid(), name, label: (req.body && req.body.label || name).trim() };
  data.linien.push(item);
  db.save();
  res.json({ item });
});
app.delete("/api/linien/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const i = data.linien.findIndex((l) => l.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Linie nicht gefunden" });
  data.linien.splice(i, 1);
  data.users.forEach((u) => (u.linien = (u.linien || []).filter((x) => x !== req.params.id)));
  data.duties.forEach((d) => {
    if (d.linieId === req.params.id) d.linieId = null;
  });
  db.save();
  res.json({ ok: true });
});

app.get("/api/fahrzeuge", requireAuth, (req, res) => {
  res.json({ items: db.load().fahrzeuge });
});
app.post("/api/fahrzeuge", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const wagennummer = (req.body && req.body.wagennummer || "").trim();
  if (!wagennummer) return res.status(400).json({ error: "Wagennummer fehlt" });
  if (data.fahrzeuge.some((f) => String(f.wagennummer) === String(wagennummer))) {
    return res.status(400).json({ error: "Fahrzeug existiert bereits" });
  }
  const item = {
    id: db.uid(),
    wagennummer,
    kennzeichen: (req.body.kennzeichen || "").trim(),
    typ: (req.body.typ || "").trim(),
    art: (req.body.art || "").trim(),
    status: (req.body.status || "einsatzbereit").trim(),
    ort: (req.body.ort || "").trim(),
    bemerkung: (req.body.bemerkung || "").trim(),
  };
  data.fahrzeuge.push(item);
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
    (d.trips || []).forEach((t) => {
      if (t.vehicleId === req.params.id) t.vehicleId = null;
    });
  });
  db.save();
  res.json({ ok: true });
});

// ---------- Shifts (mit von–bis-Uhrzeit) ----------

app.get("/api/shifts", requireAuth, (req, res) => {
  const data = db.load();
  const items = data.shifts.map((s) => ({ ...s, dutyCount: data.duties.filter((d) => d.shiftId === s.id).length }));
  res.json({ shifts: items });
});

app.post("/api/shifts", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const { name, date, startTime, endTime, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name fehlt" });
  const shift = {
    id: db.uid(),
    name: name.trim(),
    date: date || "",
    startTime: startTime || "",
    endTime: endTime || "",
    notes: notes || "",
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
  };
  data.shifts.push(shift);
  db.save();
  res.json({ shift });
});

app.patch("/api/shifts/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const s = data.shifts.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Shift nicht gefunden" });
  const { name, date, startTime, endTime, notes } = req.body || {};
  if (typeof name === "string") s.name = name.trim();
  if (typeof date === "string") s.date = date;
  if (typeof startTime === "string") s.startTime = startTime;
  if (typeof endTime === "string") s.endTime = endTime;
  if (typeof notes === "string") s.notes = notes;
  db.save();
  res.json({ shift: s });
});

app.delete("/api/shifts/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const i = data.shifts.findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Shift nicht gefunden" });
  data.shifts.splice(i, 1);
  data.duties = data.duties.filter((d) => d.shiftId !== req.params.id);
  data.applications = data.applications.filter((a) => a.shiftId !== req.params.id);
  data.wishes = data.wishes.filter((w) => !data.duties.find((d) => d.id === w.dutyId));
  db.save();
  res.json({ ok: true });
});

// Kopiert eine Shift inkl. Dutys (ohne Zuteilungen/Stornierungen) in eine neue Shift.
app.post("/api/shifts/:id/copy", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const src = data.shifts.find((s) => s.id === req.params.id);
  if (!src) return res.status(404).json({ error: "Shift nicht gefunden" });
  const { name, date } = req.body || {};
  const shift = {
    id: db.uid(),
    name: (name || src.name + " (Kopie)").trim(),
    date: date || src.date || "",
    startTime: src.startTime || "",
    endTime: src.endTime || "",
    notes: src.notes || "",
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
  };
  data.shifts.push(shift);
  data.duties
    .filter((d) => d.shiftId === src.id)
    .forEach((d) => {
      data.duties.push({
        ...d,
        id: db.uid(),
        shiftId: shift.id,
        assignedUserId: null,
        cancelled: false,
        cancelNote: "",
        trips: (d.trips || []).map((t) => ({
          ...t,
          id: db.uid(),
          cancelled: false,
          cancelNote: "",
          stops: (t.stops || []).map((s) => ({ ...s, id: db.uid(), cancelled: false })),
        })),
      });
    });
  db.save();
  res.json({ shift });
});

// ---------- Dutys ----------

app.get("/api/shifts/:id/duties", requireAuth, (req, res) => {
  const data = db.load();
  const shift = data.shifts.find((s) => s.id === req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift nicht gefunden" });
  const duties = data.duties
    .filter((d) => d.shiftId === shift.id)
    .map((d) => enrichDuty(d));
  res.json({ shift, duties });
});

app.get("/api/duties/:id", requireAuth, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  res.json({ duty: enrichDuty(duty) });
});

function enrichDuty(d) {
  const data = db.load();
  const driver = data.users.find((u) => u.id === d.assignedUserId) || null;
  const line = data.linien.find((l) => l.id === d.linieId) || null;
  const v = vehicleById(effectiveVehicle(d));
  return {
    ...d,
    trips: sortTrips({ ...d }).trips,
    linieName: line ? (line.name || line.label) : null,
    linieLabel: line ? (line.label || line.name) : null,
    vehicleName: v ? (v.typ || v.wagennummer) : null,
    vehicleWagennummer: v ? v.wagennummer : null,
    assignedUsername: driver ? driver.username : null,
  };
}

app.post("/api/shifts/:id/duties", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const shift = data.shifts.find((s) => s.id === req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift nicht gefunden" });
  const { name, linieId, kurs, vehicleId, notes, unit, startTime, endTime, linienwechsel } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name fehlt" });
  const duty = {
    id: db.uid(),
    shiftId: shift.id,
    linieId: linieId || null,
    kurs: kurs || "",
    name: name.trim(),
    vehicleId: vehicleId || null,
    unit: unit || "",
    startTime: startTime || "",
    endTime: endTime || "",
    notes: notes || "",
    linienwechsel: linienwechsel || "",
    cancelled: false,
    cancelNote: "",
    assignedUserId: null,
    trips: [],
    createdAt: new Date().toISOString(),
  };
  data.duties.push(duty);
  db.save();
  res.json({ duty: enrichDuty(duty) });
});

app.patch("/api/duties/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const { name, linieId, kurs, vehicleId, notes, cancelled, cancelNote, assignedUserId, unit, startTime, endTime, linienwechsel } = req.body || {};
  let notifyAssign = false;
  if (typeof name === "string") duty.name = name.trim();
  if (typeof linieId !== "undefined") duty.linieId = linieId;
  if (typeof kurs === "string") duty.kurs = kurs;
  if (typeof vehicleId !== "undefined") duty.vehicleId = vehicleId;
  if (typeof notes === "string") duty.notes = notes;
  if (typeof unit === "string") duty.unit = unit;
  if (typeof startTime === "string") duty.startTime = startTime;
  if (typeof endTime === "string") duty.endTime = endTime;
  if (typeof linienwechsel === "string") duty.linienwechsel = linienwechsel;
  if (typeof cancelNote === "string") duty.cancelNote = cancelNote;
  if (typeof cancelled === "boolean") {
    duty.cancelled = cancelled;
    if (cancelled) notify(duty.assignedUserId, `Duty ${duty.name} entfällt. ${cancelNote || ""}`.trim(), "danger");
  }
  if (typeof assignedUserId !== "undefined") {
    if (assignedUserId) {
      const driver = data.users.find((u) => u.id === assignedUserId);
      if (!driver) return res.status(400).json({ error: "Unbekannter Fahrer" });
      if (driver.suspended) return res.status(400).json({ error: "Fahrer ist gesperrt" });
      if (!hasLineLicense(driver, duty.linieId)) {
        return res.status(400).json({ error: "Fahrer hat keine Linien-Lizenz für diese Duty" });
      }
    }
    duty.assignedUserId = assignedUserId;
    if (assignedUserId) notifyAssign = true;
  }
  db.save();
  if (notifyAssign) {
    notify(req.body.assignedUserId, `Du wurdest der Duty "${duty.name}" zugeteilt.`, "success");
  }
  res.json({ duty: enrichDuty(duty) });
});

app.post("/api/duties/:id/vehicle", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const { vehicleId, scope } = req.body || {};
  if (scope === "all") {
    duty.vehicleId = vehicleId;
    (duty.trips || []).forEach((t) => (t.vehicleId = null));
  } else {
    duty.vehicleId = vehicleId;
  }
  db.save();
  if (duty.assignedUserId) {
    notify(duty.assignedUserId, `Fahrzeug der Duty "${duty.name}" wurde geändert.`, "warning");
  }
  res.json({ duty: enrichDuty(duty) });
});

app.post("/api/duties/:id/trips", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const { from, to, dep, arr, vehicleId } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: "Von/Ziel fehlen" });
  const trip = {
    id: db.uid(),
    from,
    to,
    dep: dep || "",
    arr: arr || "",
    vehicleId: vehicleId || null,
    cancelled: false,
    cancelNote: "",
    stops: [],
  };
  duty.trips.push(trip);
  duty.trips = sortTrips(duty).trips;
  db.save();
  res.json({ duty: enrichDuty(duty) });
});

app.patch("/api/duties/:id/trips/:tripId", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const trip = (duty.trips || []).find((t) => t.id === req.params.tripId);
  if (!trip) return res.status(404).json({ error: "Fahrt nicht gefunden" });
  const { from, to, dep, arr, vehicleId, cancelled, cancelNote } = req.body || {};
  if (typeof from === "string") trip.from = from;
  if (typeof to === "string") trip.to = to;
  if (typeof dep === "string") trip.dep = dep;
  if (typeof arr === "string") trip.arr = arr;
  if (typeof vehicleId !== "undefined") trip.vehicleId = vehicleId;
  if (typeof cancelled === "boolean") {
    trip.cancelled = cancelled;
    if (cancelled) notify(duty.assignedUserId, `Fahrt ${trip.from}→${trip.to} entfällt. ${cancelNote || ""}`.trim(), "danger");
  }
  if (typeof cancelNote === "string") trip.cancelNote = cancelNote;
  db.save();
  res.json({ duty: enrichDuty(duty) });
});

app.delete("/api/duties/:id/trips/:tripId", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  duty.trips = (duty.trips || []).filter((t) => t.id !== req.params.tripId);
  db.save();
  res.json({ duty: enrichDuty(duty) });
});

app.post("/api/duties/:id/trips/:tripId/stops", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const trip = (duty.trips || []).find((t) => t.id === req.params.tripId);
  if (!trip) return res.status(404).json({ error: "Fahrt nicht gefunden" });
  const { station, arr, dep } = req.body || {};
  if (!station) return res.status(400).json({ error: "Station fehlt" });
  trip.stops.push({ id: db.uid(), station, arr: arr || "", dep: dep || "", cancelled: false });
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

app.delete("/api/duties/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const i = data.duties.findIndex((d) => d.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Duty nicht gefunden" });
  data.duties.splice(i, 1);
  data.wishes = data.wishes.filter((w) => w.dutyId !== req.params.id);
  db.save();
  res.json({ ok: true });
});

// ---------- Wünsche / Zuteilung ----------

app.get("/api/wishes", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const items = data.wishes.map((w) => {
    const duty = data.duties.find((d) => d.id === w.dutyId);
    const user = data.users.find((u) => u.id === w.userId);
    const shift = duty ? data.shifts.find((s) => s.id === duty.shiftId) : null;
    const v = duty ? vehicleById(effectiveVehicle(duty)) : null;
    return {
      ...w,
      dutyName: duty ? duty.name : "?",
      linie: duty ? ((data.linien.find((l) => l.id === duty.linieId) || {}).name || "") : "",
      shiftName: shift ? shift.name : "?",
      shiftId: duty ? duty.shiftId : null,
      username: user ? user.username : "?",
      vehicleName: (v && (v.typ || v.wagennummer)) || null,
    };
  });
  res.json({ wishes: items });
});

app.post("/api/duties/:id/wish", requireAuth, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  if (!hasLineLicense(req.user, duty.linieId)) {
    return res.status(400).json({ error: "Keine Linien-Lizenz für diese Duty" });
  }
  if (duty.assignedUserId === req.user.id) {
    return res.status(400).json({ error: "Du bist dieser Duty bereits zugeteilt" });
  }
  const existing = data.wishes.find(
    (w) => w.dutyId === duty.id && w.userId === req.user.id && w.status === "pending"
  );
  if (existing) return res.status(400).json({ error: "Wunsch bereits vorhanden" });
  data.wishes.push({
    id: db.uid(),
    dutyId: duty.id,
    userId: req.user.id,
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  db.save();
  notify("all-supervisors", `${req.user.username} wünscht die Duty "${duty.name}".`, "wish");
  res.json({ ok: true });
});

app.post("/api/wishes/:id/accept", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const wish = data.wishes.find((w) => w.id === req.params.id);
  if (!wish) return res.status(404).json({ error: "Wunsch nicht gefunden" });
  const duty = data.duties.find((d) => d.id === wish.dutyId);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const user = data.users.find((u) => u.id === wish.userId);
  if (!user || !hasLineLicense(user, duty.linieId)) {
    return res.status(400).json({ error: "Fahrer hat keine Linien-Lizenz für diese Duty" });
  }
  wish.status = "accepted";
  duty.assignedUserId = wish.userId;
  db.save();
  notify(wish.userId, `Dein Wunsch für "${duty.name}" wurde angenommen – du bist zugeteilt.`, "success");
  res.json({ ok: true });
});

app.post("/api/wishes/:id/deny", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const wish = data.wishes.find((w) => w.id === req.params.id);
  if (!wish) return res.status(404).json({ error: "Wunsch nicht gefunden" });
  wish.status = "denied";
  db.save();
  const duty = data.duties.find((d) => d.id === wish.dutyId);
  if (duty) notify(wish.userId, `Dein Wunsch für "${duty.name}" wurde abgelehnt.`, "danger");
  res.json({ ok: true });
});

app.delete("/api/wishes/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  data.wishes = data.wishes.filter((w) => w.id !== req.params.id);
  db.save();
  res.json({ ok: true });
});

// ---------- Shift-Anmeldungen ----------
// Fahrer melden sich mit Text für eine Shift an; der Supervisor sieht alle und
// teilt sie danach manuell Dutys zu (Lizenzprüfung dort).

app.get("/api/applications", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const items = data.applications.map((a) => {
    const user = data.users.find((u) => u.id === a.userId);
    const shift = data.shifts.find((s) => s.id === a.shiftId);
    return {
      ...a,
      username: user ? user.username : "?",
      roleLabel: user ? roleLabel(user.role) : "?",
      linien: user ? (user.linien || []) : [],
      shiftName: shift ? shift.name : "?",
      shiftDate: shift ? shift.date : "",
      shiftStart: shift ? shift.startTime : "",
      shiftEnd: shift ? shift.endTime : "",
    };
  });
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ applications: items });
});

// Fahrer: eigene Shift-Anmeldungen ansehen.
app.get("/api/my/applications", requireAuth, (req, res) => {
  const data = db.load();
  const items = data.applications
    .filter((a) => a.userId === req.user.id)
    .map((a) => {
      const shift = data.shifts.find((s) => s.id === a.shiftId);
      return {
        ...a,
        shiftName: shift ? shift.name : "?",
        shiftDate: shift ? shift.date : "",
        shiftStart: shift ? shift.startTime : "",
        shiftEnd: shift ? shift.endTime : "",
      };
    });
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ applications: items });
});

app.post("/api/shifts/:id/apply", requireAuth, (req, res) => {
  const data = db.load();
  const shift = data.shifts.find((s) => s.id === req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift nicht gefunden" });
  const note = (req.body && req.body.note || "").trim();
  if (data.applications.find((a) => a.shiftId === shift.id && a.userId === req.user.id && a.status !== "denied")) {
    return res.status(400).json({ error: "Du bist für diese Shift bereits angemeldet" });
  }
  const app2 = {
    id: db.uid(),
    shiftId: shift.id,
    userId: req.user.id,
    note,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  data.applications.push(app2);
  db.save();
  notify("all-supervisors", `${req.user.username} hat sich für "${shift.name}" angemeldet.`, "apply");
  res.json({ application: app2 });
});

app.post("/api/applications/:id/accept", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const a = data.applications.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "Anmeldung nicht gefunden" });
  a.status = "accepted";
  db.save();
  notify(a.userId, "Deine Shift-Anmeldung wurde angenommen.", "success");
  res.json({ ok: true });
});

app.post("/api/applications/:id/deny", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const a = data.applications.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "Anmeldung nicht gefunden" });
  a.status = "denied";
  db.save();
  notify(a.userId, "Deine Shift-Anmeldung wurde abgelehnt.", "danger");
  res.json({ ok: true });
});

app.delete("/api/applications/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  data.applications = data.applications.filter((a) => a.id !== req.params.id);
  db.save();
  res.json({ ok: true });
});

// ---------- Benachrichtigungen ----------

app.get("/api/notifications", requireAuth, (req, res) => {
  const data = db.load();
  let items;
  if (req.user.role === "supervisor") {
    items = data.notifications.filter(
      (n) => n.userId === req.user.id || n.userId === "all-supervisors"
    );
  } else {
    items = data.notifications.filter((n) => n.userId === req.user.id);
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const unread = items.filter((n) => !n.read).length;
  res.json({ notifications: items, unread });
});

app.post("/api/notifications/:id/read", requireAuth, (req, res) => {
  const data = db.load();
  const n = data.notifications.find((x) => x.id === req.params.id);
  if (n) n.read = true;
  db.save();
  res.json({ ok: true });
});

app.post("/api/notifications/read-all", requireAuth, (req, res) => {
  const data = db.load();
  data.notifications.forEach((n) => {
    if (n.userId === req.user.id || (req.user.role === "supervisor" && n.userId === "all-supervisors")) {
      n.read = true;
    }
  });
  db.save();
  res.json({ ok: true });
});

// ---------- Fahrzeugübersicht (für alle Rollen) ----------

function dutyTimeRange(duty) {
  let first = null;
  let last = null;
  (duty.trips || []).forEach((t) => {
    if (t.cancelled) return;
    if (!first || (t.dep || t.from || "") < (first?.dep || first?.from || "")) first = t;
    if (!last || (t.arr || t.to || "") > (last?.arr || last?.to || "")) last = t;
  });
  return { first, last };
}

app.get("/api/vehicles/overview", requireAuth, (req, res) => {
  const data = db.load();
  const now = new Date();
  const result = data.fahrzeuge.map((f) => {
    const uses = [];
    data.duties.forEach((d) => {
      if (d.cancelled) return;
      const eff = effectiveVehicle(d);
      const tripsUsing = (d.trips || []).filter(
        (t) => !t.cancelled && (t.vehicleId || d.vehicleId) === f.id
      );
      if (eff === f.id || tripsUsing.length) {
        const r = dutyTimeRange(d);
        uses.push({
          dutyId: d.id,
          shiftId: d.shiftId,
          dutyName: d.name,
          shiftName: (data.shifts.find((s) => s.id === d.shiftId) || {}).name,
          shiftDate: (data.shifts.find((s) => s.id === d.shiftId) || {}).date,
          dep: r.first ? r.first.dep : "",
          arr: r.last ? r.last.arr : "",
          from: r.first ? r.first.from : "",
          to: r.last ? r.last.to : "",
          assignedUserId: d.assignedUserId,
        });
      }
    });
    uses.sort((a, b) => (a.dep || "").localeCompare(b.dep || "", "de", { numeric: true }));
    let status = "kein Einsatz";
    if (uses.length) {
      const today = now.toISOString().slice(0, 10);
      const active = uses.find((u) => u.shiftDate && u.shiftDate === today);
      status = active ? "im Einsatz (heute)" : "eingeplant";
    }
    let spawn = null;
    const cand = uses.find((u) => u.from);
    if (cand) spawn = { from: cand.from, dutyName: cand.dutyName, dep: cand.dep, shiftDate: cand.shiftDate };

    return {
      id: f.id,
      wagennummer: f.wagennummer,
      kennzeichen: f.kennzeichen,
      typ: f.typ,
      art: f.art,
      status: f.status, // einsatzbereit / nicht_einsatzbereit / sonderfahrzeug / ersatzwagen / fahrschule / reserve
      ort: f.ort,
      bemerkung: f.bemerkung,
      einsatzStatus: status, // kein Einsatz / eingeplant / im Einsatz (heute)
      uses,
      spawn,
    };
  });
  res.json({ vehicles: result });
});

// ---------- Warn-System (Würste: ab 3 Stunden muss abgearbeitet werden) ----------

app.get("/api/warns", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const items = data.warns.map((w) => {
    const user = data.users.find((u) => u.id === w.userId);
    return { ...w, username: user ? user.username : "?" };
  });
  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  res.json({ warns: items });
});

app.post("/api/warns", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const { userId, grund, stunden, frist } = req.body || {};
  if (!userId) return res.status(400).json({ error: "Nutzer fehlt" });
  const warn = {
    id: db.uid(),
    userId,
    grund: (grund || "").trim(),
    stunden: Number(stunden) || 0,
    abgearbeitet: 0,
    abgeschlossen: false,
    frist: frist || "",
    createdAt: new Date().toISOString(),
  };
  data.warns.push(warn);
  db.save();
  const user = data.users.find((u) => u.id === userId);
  notify(userId, `Du hast eine Warnung erhalten (${warn.stunden} Std. Strafe). ${warn.grund}`.trim(), "danger");
  res.json({ warn, username: user ? user.username : "?" });
});

app.patch("/api/warns/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const warn = data.warns.find((w) => w.id === req.params.id);
  if (!warn) return res.status(404).json({ error: "Warnung nicht gefunden" });
  const { grund, stunden, abgearbeitet, abgeschlossen, frist, userId } = req.body || {};
  if (typeof grund === "string") warn.grund = grund;
  if (typeof frist === "string") warn.frist = frist;
  if (typeof userId !== "undefined") warn.userId = userId;
  if (typeof stunden === "number") warn.stunden = stunden;
  if (typeof abgearbeitet === "number") warn.abgearbeitet = abgearbeitet;
  if (typeof abgeschlossen === "boolean") warn.abgeschlossen = abgeschlossen;
  db.save();
  res.json({ warn });
});

app.delete("/api/warns/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  data.warns = data.warns.filter((w) => w.id !== req.params.id);
  db.save();
  res.json({ ok: true });
});

// ---------- Health / Monitoring ----------

app.get("/api/health", (req, res) => {
  const data = db.load();
  res.json({
    ok: true,
    service: "vbg-website",
    uptime: Math.round(process.uptime()),
    started: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    time: new Date().toISOString(),
    duties: data.duties.length,
    users: data.users.length,
    fahrzeuge: data.fahrzeuge.length,
  });
});
app.get("/healthz", (req, res) => res.json({ ok: true }));

// ---------- Statik & Start ----------

app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`VBG Website API läuft auf Port ${PORT}`);
  console.log(`Daten-Datei: ${db.DATA_FILE}`);
});