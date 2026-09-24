const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, "..", "data.json");

// Fest verankerte/r, geschützte/r Supervisor (unlöschbar, nicht sperrbar).
// Wird bei jedem Start automatisch angelegt bzw. als geschützt markiert.
const PROTECTED_SUPERVISOR = {
  username: "jggaming2518",
  password: "Jlg161218MGB!",
  role: "supervisor",
};

function emptyStore() {
  return {
    users: [],
    stellwerke: [],
    fahrzeuge: [],
    shifts: [],
    duties: [],
    wishes: [],
    notifications: [],
  };
}

let db = null;

function ensureDefaultCatalogs() {
  if (db.stellwerke.length === 0) {
    ["AK", "STB", "NS", "BHBF"].forEach((n) =>
      db.stellwerke.push({ id: crypto.randomUUID(), name: n })
    );
  }
  if (db.fahrzeuge.length === 0) {
    ["628", "429", "245 (Dosto)"].forEach((n) =>
      db.fahrzeuge.push({ id: crypto.randomUUID(), name: n })
    );
  }
}

// Legt den fest verankerten Supervisor an (falls nicht vorhanden) und markiert
// ihn als geschützt. Wird bei jedem load() garantiert – auch nach Daten-Reset.
function ensureProtectedSupervisor() {
  let u = db.users.find((x) => x.username === PROTECTED_SUPERVISOR.username);
  if (!u) {
    u = {
      id: crypto.randomUUID(),
      username: PROTECTED_SUPERVISOR.username,
      passwordHash: bcrypt.hashSync(PROTECTED_SUPERVISOR.password, 10),
      role: PROTECTED_SUPERVISOR.role,
      fdl: [],
      tf: [],
      suspended: false,
      protected: true,
      createdAt: new Date().toISOString(),
    };
    db.users.push(u);
    save();
  } else {
    u.protected = true;
    if (u.role !== "supervisor") u.role = "supervisor";
    if (u.suspended) u.suspended = false;
  }
}

// Hartgelöschte Pfade, damit der geschützte Nutzer nie gelöscht/gesperrt wird.
// Wird vor jedem Schreibzugriff auf Nutzer aufgerufen.
function reProtect() {
  const u = db.users.find((x) => x.username === PROTECTED_SUPERVISOR.username);
  if (!u) {
    ensureProtectedSupervisor();
    return false;
  }
  u.protected = true;
  u.role = "supervisor";
  u.suspended = false;
  return true;
}

function isProtected(id) {
  const u = db.users.find((x) => x.id === id);
  return !!(u && u.protected);
}

function protectedUsername() {
  return PROTECTED_SUPERVISOR.username;
}

function ensureSupervisor() {
  // Falls noch kein Supervisor existiert, wird der erste angelegte User automatisch Supervisor.
}

function load() {
  if (db) return db;
  try {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } else {
      db = emptyStore();
    }
  } catch (e) {
    console.error("Daten konnten nicht geladen werden:", e.message);
    db = emptyStore();
  }
  if (!db.users) db.users = [];
  if (!db.stellwerke) db.stellwerke = [];
  if (!db.fahrzeuge) db.fahrzeuge = [];
  if (!db.shifts) db.shifts = [];
  if (!db.duties) db.duties = [];
  if (!db.wishes) db.wishes = [];
  if (!db.notifications) db.notifications = [];
  ensureDefaultCatalogs();
  ensureProtectedSupervisor();
  return db;
}

function save() {
  if (!db) db = load();
  reProtect(); // Sicherheitsnetz: geschützter Nutzer bleibt immer Supervisor + aktiv
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

// Importiert geseedete Shifts/Dutys aus einer committeten JSON-Datei (z.B.
// seed/duties.json), wenn noch nichts vorhanden ist. Fahrzeuge werden per NAME
// auf die Katalog-IDs des laufenden Systems gemappt.
function importDutiesFromFile(filePath) {
  if (!filePath) return 0;
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return 0;
  const seed = JSON.parse(fs.readFileSync(abs, "utf8"));
  if (!seed.duties || !seed.duties.length) return 0;
  if (db.duties.length > 0) return 0; // nichts mehr importieren, wenn Daten da sind

  const fzNameToId = {};
  (db.fahrzeuge || []).forEach((f) => (fzNameToId[f.name] = f.id));
  const mapVehicle = (name) => {
    if (!name) return null;
    if (fzNameToId[name]) return fzNameToId[name];
    const nf = { id: uid(), name };
    db.fahrzeuge.push(nf);
    fzNameToId[name] = nf.id;
    return nf.id;
  };

  for (const s of seed.shifts || []) {
    if (!db.shifts.find((x) => x.id === s.id)) db.shifts.push({ ...s });
    for (const d of seed.duties.filter((x) => x.shiftId === s.id)) {
      db.duties.push({
        ...d,
        vehicleId: mapVehicle(d.vehicleId),
        trips: (d.trips || []).map((t) => ({
          ...t,
          vehicleId: mapVehicle(t.vehicleId),
        })),
      });
    }
  }
  save();
  return seed.duties.length;
}

function uid() {
  return crypto.randomUUID();
}

module.exports = {
  load,
  save,
  uid,
  DATA_FILE,
  importDutiesFromFile,
  isProtected,
  protectedUsername,
};