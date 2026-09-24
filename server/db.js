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

// Standard-Linien (Lizenzen der VBG). Stabile IDs, damit der Seed sie referenzieren kann.
const DEFAULT_LINIEN = [
  { id: "lin19", name: "19", label: "Linie 19" },
  { id: "lin24", name: "(SB) 24", label: "Linie 24 (Schnellbus)" },
  { id: "lin8", name: "8", label: "Linie 8" },
  { id: "linN1", name: "N1", label: "Linie N1 (Nacht)" },
];

function emptyStore() {
  return {
    users: [],
    linien: [],
    fahrzeuge: [],
    shifts: [],
    duties: [],
    wishes: [],
    applications: [], // Shiftanmeldungen
    warns: [],
    notifications: [],
  };
}

let db = null;

function ensureDefaultCatalogs() {
  // Linien-Katalog (falls leer) mit den 4 VBG-Linien füllen.
  if (db.linien.length === 0) {
    DEFAULT_LINIEN.forEach((l) => db.linien.push({ ...l }));
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
      linien: DEFAULT_LINIEN.map((l) => l.id),
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
    if (!Array.isArray(u.linien)) u.linien = DEFAULT_LINIEN.map((l) => l.id);
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
  // Feldsicherung (auch für Daten aus älteren Versionen)
  if (!db.users) db.users = [];
  if (!db.linien) db.linien = [];
  if (!db.fahrzeuge) db.fahrzeuge = [];
  if (!db.shifts) db.shifts = [];
  if (!db.duties) db.duties = [];
  if (!db.wishes) db.wishes = [];
  if (!db.applications) db.applications = [];
  if (!db.warns) db.warns = [];
  if (!db.notifications) db.notifications = [];
  // Migration älterer Felder: fdl/tf (Fahrzeug/Stellwerk-Lizenzen) werden
  // durch Linien-Lizenzen ersetzt; fallengelassene Stellwerke entfernen wir nicht hart.
  db.users.forEach((u) => {
    if (!Array.isArray(u.linien)) u.linien = [];
    delete u.fdl;
    delete u.tf;
    if (u.role === "Supervisor") u.role = "supervisor";
  });
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

// Importiert den wiederverwendbaren Tagesplan aus seed/duties.json.
// - Linien: idempotent anhand Name.
// - Fahrzeuge: idempotent anhand Wagennummer.
// - Shifts/Dutys: immer eingespielt, wenn die Shift-ID noch nicht existiert
//   (damit der Tagesplan auch auf Bestandsinstallationen nachgerüstet wird).
// Fahrzeug-Referenzen (vehicleId) werden über Wagennummer auf die laufenden IDs gemappt.
function importDutiesFromFile(filePath) {
  if (!filePath) return 0;
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return 0;
  const seed = JSON.parse(fs.readFileSync(abs, "utf8"));
  let imported = 0;

  // Linien
  for (const l of seed.linien || []) {
    if (!db.linien.find((x) => x.name === l.name || x.id === l.id)) {
      db.linien.push({ id: l.id, name: l.name, label: l.label || l.name });
    }
  }

  // Fahrzeuge (Wagennummer = eindeutiger Schlüssel)
  const wzToId = {};
  (db.fahrzeuge || []).forEach((f) => (wzToId[f.wagennummer] = f.id));
  for (const f of seed.fahrzeuge || []) {
    if (!f.wagennummer) continue;
    if (wzToId[f.wagennummer]) continue;
    const nf = {
      id: f.id || uid(),
      wagennummer: f.wagennummer,
      kennzeichen: f.kennzeichen || "",
      typ: f.typ || "",
      art: f.art || "",
      status: f.status || "einsatzbereit",
      ort: f.ort || "",
      bemerkung: f.bemerkung || "",
    };
    db.fahrzeuge.push(nf);
    wzToId[nf.wagennummer] = nf.id;
  }

  // Shifts + zugehörige Dutys
  for (const s of seed.shifts || []) {
    if (db.shifts.find((x) => x.id === s.id)) continue;
    db.shifts.push({ ...s });
    const shiftDuties = (seed.duties || []).filter((d) => d.shiftId === s.id);
    for (const d of shiftDuties) {
      db.duties.push({
        ...d,
        vehicleId: mapVehicle(d.vehicleId, wzToId),
        linieId: d.linieId || null,
        trips: (d.trips || []).map((t) => ({
          ...t,
          vehicleId: mapVehicle(t.vehicleId, wzToId),
          stops: t.stops || [],
        })),
      });
      imported++;
    }
  }
  if (imported) save();
  return imported;
}

function mapVehicle(idOrNull, wzToId) {
  return idOrNull || null;
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
  DEFAULT_LINIEN,
};