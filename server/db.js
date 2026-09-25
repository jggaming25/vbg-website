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
  { id: "lin19", name: "19", beschreibung: "Stümp Voiskamp – Gravenberg ZOB (Solo)" },
  { id: "lin24", name: "(SB) 24", beschreibung: "Schnellbus Sorenkoppel – Gravenberg ZOB (Gelenk/Solo)" },
  { id: "lin8", name: "8", beschreibung: "Bf. Gravenberg – Bergdorf (Solo)" },
  { id: "linN1", name: "N1", beschreibung: "Nachtbus Gravenberg ZOB – Sorenkoppel (Gelenk)" },
];

function emptyStore() {
  return {
    users: [],
    linien: [],
    fahrzeuge: [],
    shifts: [],
    duties: [],
    wishes: [],
    applications: [], // Shift-/Kundenservice-Anmeldungen (von-bis)
    kundenservice: [], // Standorte des Kundenservice-Blocks
    activity: [], // Activity-Anmeldungen
    notifications: [],
    announcements: [], // Broadcast-Nachrichten (Supervisor → Zielgruppen)
    announcementDate: null,
  };
}

let db = null;

function ensureDefaultCatalogs() {
  // Linien-Katalog (falls leer) mit den 4 VBG-Linien füllen.
  if (db.linien.length === 0) {
    DEFAULT_LINIEN.forEach((l) => db.linien.push({ ...l }));
  }
}

function ensureProtectedSupervisor() {
  let u = db.users.find((x) => x.username === PROTECTED_SUPERVISOR.username);
  if (!u) {
    u = {
      id: crypto.randomUUID(),
      username: PROTECTED_SUPERVISOR.username,
      passwordHash: bcrypt.hashSync(PROTECTED_SUPERVISOR.password, 10),
      role: PROTECTED_SUPERVISOR.role,
      linien: DEFAULT_LINIEN.map((l) => l.id),
      strafstunden: 0,
      discordName: "",
      robloxName: "",
      robloxChangedAt: null,
      language: "de",
      avatar: "",
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
  if (!db.kundenservice) db.kundenservice = [];
  if (!db.activity) db.activity = [];
  if (!db.notifications) db.notifications = [];
  if (!db.announcements) db.announcements = [];
  if (db.announcementDate === undefined) db.announcementDate = null;

  // Migration älterer Felder
  db.users.forEach((u) => {
    if (!Array.isArray(u.linien)) u.linien = [];
    if (typeof u.strafstunden !== "number") u.strafstunden = 0;
    if (typeof u.discordName !== "string") u.discordName = "";
    if (typeof u.robloxName !== "string") u.robloxName = "";
    if (!u.robloxChangedAt) u.robloxChangedAt = null;
    if (typeof u.language !== "string") u.language = "de";
    if (typeof u.avatar !== "string") u.avatar = "";
    delete u.fdl;
    delete u.tf;
    delete u.warns;
    if (u.role === "Supervisor") u.role = "supervisor";
  });

  // Linien: label → beschreibung
  db.linien.forEach((l) => {
    if (!l.beschreibung && l.label) { l.beschreibung = l.label; delete l.label; }
    if (!l.beschreibung) l.beschreibung = "";
    if (!l.name) l.name = "";
    if (!Array.isArray(l.stopsHin)) l.stopsHin = [];
    if (!Array.isArray(l.stopsRueck)) l.stopsRueck = [];
  });

  // Shifts: Host + Co-Supervisoren
  db.shifts.forEach((s) => {
    if (!s.hostId) s.hostId = null;
    if (!Array.isArray(s.coSupervisorIds)) s.coSupervisorIds = [];
  });

  // Duties: Einzelfahrt-Zuteilung
  db.duties.forEach((d) => {
    if (!Array.isArray(d.trips)) d.trips = [];
    d.trips.forEach((t) => {
      if (t.assignedUserId === undefined) t.assignedUserId = null;
      if (t.leerfahrt === undefined) t.leerfahrt = false;
      if (t.bemerkung === undefined) t.bemerkung = "";
      if (!Array.isArray(t.stops)) t.stops = [];
    });
    if (d.bemerkung === undefined) d.bemerkung = "";
  });

  ensureDefaultCatalogs();
  ensureProtectedSupervisor();
  return db;
}

function save() {
  if (!db) db = load();
  reProtect();
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

// Importiert den wiederverwendbaren Tagesplan aus seed/duties.json.
// - Linien: idempotent anhand Name.
// - Fahrzeuge: idempotent anhand Wagennummer.
// - Shifts/Dutys: immer eingespielt, wenn die Shift-ID noch nicht existiert.
// Fahrzeug-Referenzen (vehicleId) werden über Wagennummer auf laufende IDs gemappt.
// Beim Import werden Fahrzeugzuweisungen NICHT übernommen (nur manuelle Zuteilung).
function importDutiesFromFile(filePath) {
  if (!filePath) return 0;
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return 0;
  const seed = JSON.parse(fs.readFileSync(abs, "utf8"));
  let imported = 0;

  for (const l of seed.linien || []) {
    if (!db.linien.find((x) => x.name === l.name || x.id === l.id)) {
      db.linien.push({ id: l.id, name: l.name, beschreibung: l.beschreibung || l.label || "" });
    }
  }

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

  for (const s of seed.shifts || []) {
    if (db.shifts.find((x) => x.id === s.id)) continue;
    db.shifts.push({ ...s, hostId: null, coSupervisorIds: [] });
    const shiftDuties = (seed.duties || []).filter((d) => d.shiftId === s.id);
    for (const d of shiftDuties) {
      // vehicleId bewusst als null übernehmen: Fahrzeugzuweisung macht der Supervisor manuell.
      db.duties.push({
        ...d,
        vehicleId: null,
        assignedUserId: null,
        linieId: d.linieId || null,
        bemerkung: d.bemerkung || "",
        trips: (d.trips || []).map((t) => ({
          ...t,
          vehicleId: null,
          assignedUserId: null,
          bemerkung: t.bemerkung || "",
          stops: t.stops || [],
        })),
      });
      imported++;
    }
  }
  if (imported) save();
  return imported;
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