// Seed-Skript: liest die Google-Sheets-HTML-Exportdatei der TF Dutys
// und legt die Dutys als Startdaten in data.json an (eine Shift "Organisationsplan").
//
// Aufruf:  node server/seed.js [Pfad-zur-HTML]
// Die HTML-Datei der Dutys wird als Pfad/Argument übergeben.

const fs = require("fs");
const path = require("path");
const db = require("./db");

let SRC = process.argv[2] || "";

function resolveSource() {
  if (SRC) return SRC;
  const tmp = path.join(process.env.TEMP || "C:\\Users\\jgenz\\AppData\\Local\\Temp");
  const hit = fs
    .readdirSync(tmp)
    .filter((f) => /tf duty/i.test(f) && f.toLowerCase().endsWith(".html"))
    .sort((a, b) => fs.statSync(path.join(tmp, b)).size - fs.statSync(path.join(tmp, a)).size)[0];
  return hit ? path.join(tmp, hit) : "";
}

function decode(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cellTexts(rowHtml) {
  const out = [];
  const tdRe = /<\s*td\b[^>]*>([\s\S]*?)<\s*\/td\s*>/g;
  let m;
  while ((m = tdRe.exec(rowHtml)) !== null) {
    out.push(decode(m[1].replace(/<[^>]*>/g, "").trim()));
  }
  return out;
}

function vehicleTypeOf(label) {
  if (!label) return null;
  const l = label.replace(/\./g, "").trim();
  if (/^628/.test(l)) return "628";
  if (/^429/.test(l)) return "429";
  if (/^245/.test(l)) return "245 (Dosto)";
  return null;
}

const DRIVE_TYPES = new Set(["Zugft.", "Gast", "Lz", "RF"]);

function parseHtml(html) {
  const duties = [];
  let current = null;
  const rowRe = /<\s*tr\b[^>]*>([\s\S]*?)<\s*\/tr\s*>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const cells = cellTexts(m[1]);
    if (!cells.length) continue;

    const dutyName = cells.find((c) => /^Duty-Nr\.\s*\d+$/.test(c));
    if (dutyName) {
      const nr = parseInt(dutyName.replace(/\D+/g, ""), 10);
      if (current) duties.push(current);
      current = { nr, unit: null, startTime: "", endTime: "", trips: [] };
      continue;
    }
    if (!current) continue;

    const bi = cells.indexOf("Beginn:");
    if (bi !== -1) current.startTime = cells[bi + 1] || "";
    const ei = cells.indexOf("Ende:");
    if (ei !== -1) current.endTime = cells[ei + 1] || "";

    // Datenzeile: 0=Lücke,1=Nr,2=BG,3=Tätigkeit,4=Zug-Nr,5=Fz.Typ,7=Von,8=Nach,9=Beginn,10=Ende,18=Kommentar
    const taet = cells[3] || "";
    const label = cells[5] || "";
    const von = cells[7] || "";
    const nach = cells[8] || "";
    if (von && nach) {
      const vtype = vehicleTypeOf(label);
      if (!current.unit && label && vtype) current.unit = label;
      if (DRIVE_TYPES.has(taet) && vtype) {
        current.trips.push({
          from: von,
          to: nach,
          dep: cells[9] || "",
          arr: cells[10] || "",
          vehicleId: vtype,
          zugNr: cells[4] || "",
          cancelled: false,
          cancelNote: "",
          stops: [],
        });
      }
    }
  }
  if (current) duties.push(current);
  return duties;
}

// Exportiert die aktuellen Daten shoptspezifisch als committbare JSON-Datei
// (seed/duties.json): Fahrzeuge werden als NAMEN statt IDs gespeichert, damit
// der Import die Katalog-IDs eines frischen Systems korrekt auflösen kann.
function runExport() {
  const data = db.load();
  if (!data.duties.length) {
    console.error("Keine Dutys in data.json vorhanden – zuerst importieren (node server/seed.js <html>).");
    process.exit(1);
  }
  const fzNameOf = (id) => { const f = data.fahrzeuge.find((x) => x.id === id); return f ? f.name : null; };
  const seed = {
    shifts: data.shifts.map((s) => ({ ...s })),
    duties: data.duties.map((d) => ({
      ...d,
      vehicleId: fzNameOf(d.vehicleId),
      trips: (d.trips || []).map((t) => ({ ...t, vehicleId: fzNameOf(t.vehicleId) })),
    })),
  };
  const out = path.join(__dirname, "..", "seed", "duties.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(seed, null, 2), "utf8");
  console.log(`Exportiert: ${out} (${seed.shifts.length} Shifts, ${seed.duties.length} Dutys)`);
}

function run() {
  if (process.argv.includes("--export")) {
    runExport();
    return;
  }
  SRC = resolveSource();
  if (!fs.existsSync(SRC)) {
    console.error("Datei nicht gefunden: " + SRC);
    console.error("Aufruf: node server/seed.js <Pfad zur HTML-Datei>");
    process.exit(1);
  }

  const data = db.load();
  let shift = data.shifts.find((s) => s.name === "Organisationsplan");
  if (shift && data.duties.filter((d) => d.shiftId === shift.id).length) {
    console.log("Dutys wurden bereits geseedet – nichts zu tun. (data.json löschen zum neu seeden)");
    return;
  }

  if (!shift) {
    shift = {
      id: db.uid(),
      name: "Organisationsplan",
      date: "",
      notes: "TF-Dutys aus dem Organisationsplan (Seed)",
      createdBy: null,
      createdAt: new Date().toISOString(),
    };
    data.shifts.push(shift);
  }

  const htm = fs.readFileSync(SRC, "utf8");
  const parsed = parseHtml(htm);

  let tripSum = 0;
  const fzIdBy = {};
  data.fahrzeuge.forEach((f) => (fzIdBy[f.name] = f.id));

  for (const d of parsed) {
    const firstType = d.trips[0] ? d.trips[0].vehicleId : null;
    const duty = {
      id: db.uid(),
      shiftId: shift.id,
      name: "Duty " + d.nr,
      vehicleId: firstType ? fzIdBy[firstType] : null,
      unit: d.unit || "",
      startTime: d.startTime,
      endTime: d.endTime,
      notes: "",
      cancelled: false,
      cancelNote: "",
      assignedUserId: null,
      trips: d.trips.map((t) => ({
        id: db.uid(),
        from: t.from,
        to: t.to,
        dep: t.dep,
        arr: t.arr,
        vehicleId: fzIdBy[t.vehicleId] || null,
        zugNr: t.zugNr || "",
        cancelled: false,
        cancelNote: "",
        stops: [],
      })),
      createdAt: new Date().toISOString(),
    };
    data.duties.push(duty);
    tripSum += duty.trips.length;
    console.log(
      `Duty ${String(d.nr).padStart(2, " ")}  Fzg ${(duty.vehicleId || "?").padEnd(12)} ` +
        `${(duty.unit || "").padEnd(14)} ${duty.startTime || "    "}-${duty.endTime || "  "}  ` +
        `${String(duty.trips.length).padStart(2, " ")} Fahrten`
    );
  }

  db.save();
  console.log("------------------------------------------");
  console.log(`Fertig: ${parsed.length} Dutys, ${tripSum} Fahrten in Shift "${shift.name}"`);
  console.log("Vorhandene Fahrzeug-Typen im Katalog: " + data.fahrzeuge.map((f) => f.name).join(", "));
  ["31", "32"].forEach((n) => {
    if (!parsed.some((d) => String(d.nr) === n)) {
      console.warn(`Hinweis: Duty ${n} ist in der Quelldatei nicht vorhanden.`);
    }
  });
}

run();