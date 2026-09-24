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

// Auto-Seed beim Start: Wenn SEED_FILE gesetzt ist (z.B. auf Render) und noch
// keine Dutys existieren (frische/geleerte Daten), werden die geseedeten Dutys
// aus seed/duties.json importiert.
const seedCount = db.importDutiesFromFile(process.env.SEED_FILE);
if (seedCount) console.log(`Seed: ${seedCount} Dutys automatisch importiert (${process.env.SEED_FILE}).`);

// ---------- Hilfsfunktionen ----------

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    fdl: u.fdl || [],
    tf: u.tf || [],
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

function hasTfLicense(user, vehicleId) {
  if (!vehicleId) return true; // ohne Fahrzeug keine Lizenzpruefung noetig
  return (user.tf || []).includes(vehicleId);
}

function sortTrips(duty) {
  if (!duty.trips) duty.trips = [];
  duty.trips.sort((a, b) =>
    (a.dep || a.from || "").toString().localeCompare(b.dep || b.from || "")
  );
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
  // Kein Nutzer vorhanden -> erster Nutzer darf sich als Supervisor anlegen (Bootstrap)
  if (data.users.length > 0) {
    if (!authToken(req) || !req.user || req.user.role !== "supervisor") {
      const payload = authToken(req);
      if (!payload) return res.status(401).json({ error: "Nicht angemeldet" });
      const u2 = data.users.find((x) => x.id === payload.sub);
      if (!u2) return res.status(401).json({ error: "Unbekannter Nutzer" });
      if (u2.suspended) return res.status(403).json({ error: "Konto gesperrt" });
      if (u2.role !== "supervisor") return res.status(403).json({ error: "Nur Supervisor erlaubt" });
    }
  }
  const { username, password, fdl, tf } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Benutzername und Passwort fehlen" });
  }
  if (data.users.some((u) => u.username.toLowerCase() === username.trim().toLowerCase())) {
    return res.status(400).json({ error: "Benutzername existiert bereits" });
  }
  const role = data.users.length === 0 ? "supervisor" : "user";
  const user = {
    id: db.uid(),
    username: username.trim(),
    passwordHash: await bcrypt.hash(password, 10),
    role,
    fdl: fdl || [],
    tf: tf || [],
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
  const { fdl, tf, suspended, password } = req.body || {};
  if (Array.isArray(fdl)) user.fdl = fdl;
  if (Array.isArray(tf)) user.tf = tf;
  if (typeof suspended === "boolean") user.suspended = suspended;
  if (password) user.passwordHash = await bcrypt.hash(password, 10);
  db.save();
  res.json({ user: publicUser(user) });
});

app.post("/api/users/:id/licenses", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const user = data.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  const { fdl = [], tf = [] } = req.body || {};
  user.fdl = Array.from(new Set([...(user.fdl || []), ...fdl]));
  user.tf = Array.from(new Set([...(user.tf || []), ...tf]));
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
  data.duties.forEach((d) => {
    if (d.assignedUserId === removed.id) d.assignedUserId = null;
  });
  db.save();
  res.json({ ok: true });
});

// ---------- Kataloge (Lizenzen) ----------

app.get("/api/stellwerke", requireAuth, (req, res) => {
  res.json({ items: db.load().stellwerke });
});
app.post("/api/stellwerke", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const name = (req.body && req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name fehlt" });
  if (data.stellwerke.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: "Stellwerk existiert bereits" });
  }
  const item = { id: db.uid(), name };
  data.stellwerke.push(item);
  db.save();
  res.json({ item });
});
app.delete("/api/stellwerke/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const i = data.stellwerke.findIndex((s) => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Stellwerk nicht gefunden" });
  data.stellwerke.splice(i, 1);
  data.users.forEach((u) => (u.fdl = (u.fdl || []).filter((x) => x !== req.params.id)));
  db.save();
  res.json({ ok: true });
});

app.get("/api/fahrzeuge", requireAuth, (req, res) => {
  res.json({ items: db.load().fahrzeuge });
});
app.post("/api/fahrzeuge", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const name = (req.body && req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name fehlt" });
  if (data.fahrzeuge.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: "Fahrzeug existiert bereits" });
  }
  const item = { id: db.uid(), name };
  data.fahrzeuge.push(item);
  db.save();
  res.json({ item });
});
app.delete("/api/fahrzeuge/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const i = data.fahrzeuge.findIndex((s) => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Fahrzeug nicht gefunden" });
  data.fahrzeuge.splice(i, 1);
  data.users.forEach((u) => (u.tf = (u.tf || []).filter((x) => x !== req.params.id)));
  db.save();
  res.json({ ok: true });
});

// ---------- Shifts ----------

app.get("/api/shifts", requireAuth, (req, res) => {
  const data = db.load();
  const items = data.shifts.map((s) => ({ ...s, dutyCount: data.duties.filter((d) => d.shiftId === s.id).length }));
  res.json({ shifts: items });
});

app.post("/api/shifts", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const { name, date, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name fehlt" });
  const shift = {
    id: db.uid(),
    name: name.trim(),
    date: date || "",
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
  const { name, date, notes } = req.body || {};
  if (typeof name === "string") s.name = name.trim();
  if (typeof date === "string") s.date = date;
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
  db.save();
  res.json({ ok: true });
});

// ---------- Dutys ----------

app.get("/api/shifts/:id/duties", requireAuth, (req, res) => {
  const data = db.load();
  const shift = data.shifts.find((s) => s.id === req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift nicht gefunden" });
  const duties = data.duties
    .filter((d) => d.shiftId === shift.id)
    .map((d) => ({ ...d, trips: sortTrips({ ...d }).trips }));
  res.json({ shift, duties });
});

app.get("/api/duties/:id", requireAuth, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  res.json({ duty: { ...duty, trips: sortTrips({ ...duty }).trips } });
});

app.post("/api/shifts/:id/duties", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const shift = data.shifts.find((s) => s.id === req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift nicht gefunden" });
  const { name, vehicleId, notes, unit, startTime, endTime } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name fehlt" });
  const duty = {
    id: db.uid(),
    shiftId: shift.id,
    name: name.trim(),
    vehicleId: vehicleId || null,
    unit: unit || "",
    startTime: startTime || "",
    endTime: endTime || "",
    notes: notes || "",
    cancelled: false,
    cancelNote: "",
    assignedUserId: null,
    trips: [],
    createdAt: new Date().toISOString(),
  };
  data.duties.push(duty);
  db.save();
  res.json({ duty });
});

app.patch("/api/duties/:id", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const { name, vehicleId, notes, cancelled, cancelNote, assignedUserId, unit, startTime, endTime } = req.body || {};
  let notifyAssign = false;
  if (typeof name === "string") duty.name = name.trim();
  if (typeof vehicleId !== "undefined") duty.vehicleId = vehicleId;
  if (typeof notes === "string") duty.notes = notes;
  if (typeof unit === "string") duty.unit = unit;
  if (typeof startTime === "string") duty.startTime = startTime;
  if (typeof endTime === "string") duty.endTime = endTime;
  if (typeof cancelNote === "string") duty.cancelNote = cancelNote;
  if (typeof cancelled === "boolean") {
    duty.cancelled = cancelled;
    if (cancelled) notify(duty.assignedUserId, `Duty ${duty.name} entfällt. ${cancelNote || ""}`.trim(), "danger");
  }
  if (typeof assignedUserId !== "undefined") {
    const vehicleId2 = effectiveVehicle(duty);
    const driver = data.users.find((u) => u.id === assignedUserId);
    if (assignedUserId && (!driver || !hasTfLicense(driver, vehicleId2))) {
      return res.status(400).json({ error: "Fahrer hat keine TF-Lizenz für das Fahrzeug der Duty" });
    }
    duty.assignedUserId = assignedUserId;
    if (assignedUserId) notifyAssign = true;
  }
  db.save();
  if (notifyAssign) {
    notify(req.body.assignedUserId, `Du wurdest der Duty "${duty.name}" zugeteilt.`, "success");
  }
  res.json({ duty: { ...duty, trips: sortTrips(duty).trips } });
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
  res.json({ duty });
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
  res.json({ duty: { ...duty, trips: sortTrips(duty).trips } });
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
  res.json({ duty: { ...duty, trips: sortTrips(duty).trips } });
});

app.delete("/api/duties/:id/trips/:tripId", requireAuth, requireSupervisor, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  duty.trips = (duty.trips || []).filter((t) => t.id !== req.params.tripId);
  db.save();
  res.json({ duty: { ...duty, trips: sortTrips(duty).trips } });
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
  res.json({ duty: { ...duty, trips: sortTrips(duty).trips } });
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
  res.json({ duty: { ...duty, trips: sortTrips(duty).trips } });
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
    return {
      ...w,
      dutyName: duty ? duty.name : "?",
      shiftName: shift ? shift.name : "?",
      shiftId: duty ? duty.shiftId : null,
      username: user ? user.username : "?",
      vehicleName:
        duty && effectiveVehicle(duty)
          ? (data.fahrzeuge.find((f) => f.id === effectiveVehicle(duty)) || {}).name
          : null,
    };
  });
  res.json({ wishes: items });
});

app.post("/api/duties/:id/wish", requireAuth, (req, res) => {
  const data = db.load();
  const duty = data.duties.find((d) => d.id === req.params.id);
  if (!duty) return res.status(404).json({ error: "Duty nicht gefunden" });
  const vehicleId = effectiveVehicle(duty);
  if (!hasTfLicense(req.user, vehicleId)) {
    return res.status(400).json({ error: "Keine TF-Lizenz für das Fahrzeug dieser Duty" });
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
  const vehicleId2 = effectiveVehicle(duty);
  const user = data.users.find((u) => u.id === wish.userId);
  if (!hasTfLicense(user, vehicleId2)) {
    return res.status(400).json({ error: "Fahrer hat keine TF-Lizenz für das Fahrzeug" });
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

// ---------- Fahrzeugübersicht ----------

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
    uses.sort((a, b) => (a.dep || "").localeCompare(b.dep || ""));
    let status = "kein Einsatz";
    if (uses.length) {
      // Prüfen: läuft gerade?
      const active = uses.find((u) => {
        if (!u.dep) return false;
        // nur vergleichen, wenn Datum gleich heute ist
        const today = now.toISOString().slice(0, 10);
        if (u.shiftDate && u.shiftDate !== today) return false;
        return true;
      });
      status = active ? "im Einsatz (heute)" : "eingeplant";
    }
    let spawn = null;
    const cand = uses.find((u) => u.from);
    if (cand) spawn = { from: cand.from, dutyName: cand.dutyName, dep: cand.dep, shiftDate: cand.shiftDate };
    return {
      id: f.id,
      name: f.name,
      status,
      uses,
      spawn,
    };
  });
  res.json({ vehicles: result });
});

// ---------- Health / Monitoring ----------

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "vbg-website",
    uptime: Math.round(process.uptime()),
    started: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    time: new Date().toISOString(),
    duties: db.load().duties.length,
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