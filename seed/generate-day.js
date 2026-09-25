// Generiert den VBG-Tagesplan (kein festes Datum, wiederverwendbar) in seed/duties.json.
// Basis: Organisationsplan-Sheets (19, (SB)24, 8, N1, Einsetzer, Fahrzeugplan, Umlauf-Codes)
// Aufruf: node seed/generate-day.js
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const uid = () => crypto.randomUUID();

// ---------- Linien-Katalog (Lizenzen) ----------
const LINIEN = [
  { id: "lin19", name: "19", label: "Linie 19" },
  { id: "lin24", name: "(SB) 24", label: "Linie 24 (Schnellbus)" },
  { id: "lin8", name: "8", label: "Linie 8" },
  { id: "linN1", name: "N1", label: "Linie N1 (Nacht)" },
];

// ---------- Fahrzeug-Flotte (Fahrzeugplan + Shiftplan-Standorte) ----------
const FLEET = [
  { w: "2088", kz: "-", typ: "MB Integro O560", art: "Solo", status: "sonderfahrzeug", ort: "Defekt Bth Neuenburg", bemerkung: "Sonderfahrzeug (derzeit nicht einsatzbereit)" },
  { w: "2003", kz: "GV-VB 2003", typ: "Mercedes-Benz O530 MÜ", art: "Solo", status: "einsatzbereit", ort: "Betriebshof Gravenberg", bemerkung: "" },
  { w: "1101", kz: "GV-VB 1101", typ: "MAN A37", art: "Solo", status: "einsatzbereit", ort: "Reserve Bus Gravenberg", bemerkung: "" },
  { w: "1102", kz: "GV-VB 1102", typ: "MAN A37", art: "Solo", status: "einsatzbereit", ort: "Reserve Bus Neuenburg", bemerkung: "" },
  { w: "1103", kz: "GV-VB 1103", typ: "Mercedes-Benz O530 Facelift", art: "Solo", status: "einsatzbereit", ort: "Betriebshof Gravenberg", bemerkung: "" },
  { w: "1104", kz: "GV-VB 1104", typ: "Mercedes-Benz O530 Facelift", art: "Solo", status: "einsatzbereit", ort: "Betriebshof Gravenberg", bemerkung: "" },
  { w: "1401", kz: "GV-VB 1401", typ: "Mercedes-Benz C2 Solo", art: "Solo", status: "einsatzbereit", ort: "Betriebshof Gravenberg", bemerkung: "" },
  { w: "1402", kz: "GV-VB 1402", typ: "Mercedes-Benz C2 Solo", art: "Solo", status: "einsatzbereit", ort: "Betriebshof Gravenberg", bemerkung: "" },
  { w: "1403", kz: "GV-VB1403", typ: "Mercedes-Benz C2 Solo", art: "Solo", status: "einsatzbereit", ort: "Betriebshof Neuenburg", bemerkung: "Reserve" },
  { w: "1404", kz: "GV-VB 1404", typ: "Mercedes-Benz C2Ü Solo", art: "Solo", status: "einsatzbereit", ort: "Betriebshof Gravenberg", bemerkung: "Auch Fahrschulbus" },
  { w: "1405", kz: "GV-VB 1405", typ: "Mercedes-Benz C2Ü Solo", art: "Solo", status: "einsatzbereit", ort: "Betriebshof Gravenberg", bemerkung: "" },
  { w: "2201", kz: "GV-VB 2201", typ: "Mercedes-Benz C2 Solo", art: "Solo", status: "einsatzbereit", ort: "Betriebshof Gravenberg", bemerkung: "" },
  { w: "2202", kz: "GV-VB 2202", typ: "Mercedes-Benz C2 Solo", art: "Solo", status: "einsatzbereit", ort: "Betriebshof Gravenberg", bemerkung: "" },
  { w: "2501", kz: "GV-VB 2501", typ: "Mercedes-Benz C2 Solo", art: "Solo", status: "einsatzbereit", ort: "Betriebshof Gravenberg", bemerkung: "" },
  { w: "2502", kz: "GV-VB 2502", typ: "Mercedes-Benz C2 Solo", art: "Solo", status: "einsatzbereit", ort: "Betriebshof Gravenberg", bemerkung: "" },
  { w: "2004", kz: "GV-VB 2004", typ: "MAN NG 313", art: "Gelenk", status: "nicht_einsatzbereit", ort: "Defekt Bth Neuenburg", bemerkung: "Derzeitiger Display-Defekt" },
  { w: "2005", kz: "GV-VB 2005", typ: "MAN NG 313", art: "Gelenk", status: "nicht_einsatzbereit", ort: "Defekt Bth Neuenburg", bemerkung: "Derzeitiger Display-Defekt" },
  { w: "1201", kz: "GV-VB 1201", typ: "MAN A23", art: "Gelenk", status: "nicht_einsatzbereit", ort: "Betriebshof Neuenburg", bemerkung: "Nicht einsatzbereit" },
  { w: "1460", kz: "GV-VB 1460", typ: "Mercedes-Benz C2 G", art: "Gelenk", status: "nicht_einsatzbereit", ort: "Defekt Bth Neuenburg", bemerkung: "" },
  { w: "1461", kz: "GV-VB 1461", typ: "Mercedes-Benz C2 G", art: "Gelenk", status: "einsatzbereit", ort: "Betriebshof Neuenburg", bemerkung: "" },
  { w: "1462", kz: "GV-VB 1462", typ: "Mercedes-Benz C2 G", art: "Gelenk", status: "nicht_einsatzbereit", ort: "Defekt Bth Neuenburg", bemerkung: "" },
  { w: "2560", kz: "GV-VB 2560", typ: "Mercedes-Benz C2 G", art: "Gelenk", status: "einsatzbereit", ort: "Betriebshof Neuenburg", bemerkung: "" },
  { w: "2561", kz: "GV-VB 2561", typ: "Mercedes-Benz C2 G", art: "Gelenk", status: "einsatzbereit", ort: "Betriebshof Gravenberg", bemerkung: "" },
  { w: "2605", kz: "GV-VB 2605", typ: "Mercedes-Benz C2 G", art: "Gelenk", status: "einsatzbereit", ort: "Betriebshof Neuenburg", bemerkung: "" },
  { w: "2606", kz: "GV-VB 2606", typ: "Mercedes-Benz C2 G", art: "Gelenk", status: "einsatzbereit", ort: "Betriebshof Gravenberg", bemerkung: "" },
];

// ---------- Haltestellen-Fahrpläne (Offsets in Minuten, aus den Sheets) ----------

const STOPS = {
  "19_sv_gvz": [
    ["Stümp Voiskamp", 0], ["Stümp Ortsende", 1], ["Neuenburg Schule", 2], ["Neuenburg Stadt", 3],
    ["Neuenburg West", 4], ["Nb, Betriebshof VBG", 5], ["Nb, Media Schwarz", 6],
    ["Neuenburg Neue Siedlung", 7], ["Neuenburg Sütelkamp", 8], ["Sütel Wendeplatz", 9],
    ["Löbstein", 10], ["Kreiskrankenhaus", 11], ["Altstadt Süd", 12], ["Altstadt Markt", 13],
    ["Neurrupiner Straße", 14], ["Gravenberg ZOB", 15],
  ],
  "19_gvz_sv": [
    ["Gravenberg ZOB", 0], ["Neurrupiner Straße", 1], ["Altstadt Markt", 2], ["Altstadt Süd", 3],
    ["Kreiskrankenhaus", 4], ["Löbstein", 5], ["Sütel Wendeplatz", 6], ["Neuenburg Sütelkamp", 7],
    ["Neuenburg Neue Siedlung", 8], ["Nb, Media Schwarz", 9], ["Nb, Betriebshof VBG", 10],
    ["Neuenburg West", 11], ["Neuenburg Stadt", 12], ["Neuenburg Schule", 13],
    ["Stümp Ortsende", 14], ["Stümp Voiskamp", 15],
  ],
  "24_sk_gvz": [
    ["Sorenkoppel", 0], ["Sorenkoppel Ost", 1], ["Neuenburg Schule", 2], ["Neuenburg Stadt", 3],
    ["Neuenburg West", 4], ["Nb, Betriebshof VBG", 5], ["Nb, Media Schwarz", 6],
    ["Abzweig Sütel", 7], ["Abzweig Kreiskrankenhaus", 8], ["Altstadt Markt", 9], ["Gravenberg ZOB", 10],
  ],
  "24_gvz_sk": [
    ["Gravenberg ZOB", 0], ["Altstadt Markt", 1], ["Abzweig Kreiskrankenhaus", 2], ["Abzweig Sütel", 3],
    ["Nb, Media Schwarz", 4], ["Nb, Betriebshof VBG", 5], ["Neuenburg West", 6], ["Neuenburg Stadt", 7],
    ["Neuenburg Schule", 8], ["Sorenkoppel West", 9], ["Sorenkoppel", 10],
  ],
  "8_bg_bd": [
    ["Bf. Gravenberg", 0], ["Betriebshof Gravenberg", 1], ["Gravenberg ZOB", 3], ["Kasseler Straße", 4],
    ["Kreisverkehr", 4], ["Stadtpark", 5], ["Ortsende", 5], ["Bergdorf", 6],
  ],
  "8_bd_bg": [
    ["Bergdorf", 0], ["Ortsende", 1], ["Stadtpark", 1], ["Kreisverkehr", 2], ["Kasseler Straße", 2],
    ["Gravenberg ZOB", 3], ["Betriebshof Gravenberg", 4], ["Bf. Gravenberg", 5],
  ],
  "n1_gvz_sk": [
    ["Gravenberg ZOB", 0], ["Altstadt Markt", 2], ["Altstadt Süd", 4], ["Kreiskrankenhaus", 5],
    ["Löbstein", 6], ["Abzweig Sütel", 8], ["Neuenburg Neue Siedlung", 10], ["Neuenburg Sütelkamp", 11],
    ["Sütel Wendeplatz", 12], ["Nb, Media Schwarz", 13], ["Nb, Betriebshof VBG", 14],
    ["Neuenburg West", 15], ["Neuenburg Stadt", 16], ["Sorenkoppel West", 18], ["Neuenburg Sorenkoppel", 20],
  ],
  "n1_sk_gvz": [
    ["Neuenburg Sorenkoppel", 0], ["Sorenkoppel Ost", 1], ["Neuenburg Stadt", 2], ["Neuenburg West", 3],
    ["Nb, Betriebshof VBG", 4], ["Nb, Media Schwarz", 5], ["Neuenburg Neue Siedlung", 6],
    ["Neuenburg Sütelkamp", 7], ["Sütel Wendeplatz", 8], ["Abzweig Sütel", 9],
    ["Abzweig Kreiskrankenhaus", 10], ["Altstadt Süd", 11], ["Altstadt Markt", 12],
    ["Neurrupiner Straße", 13], ["Gravenberg ZOB", 14],
  ],
};

// ---------- Helfer ----------
function pad(n) { return String(n).padStart(2, "0"); }
function hhmm(h, m) { return pad(Math.floor(h)) + ":" + pad(m % 60); }
function addMin(h, m) {
  let t = h * 60 + m;
  const H = Math.floor(t / 60) % 24;
  return { h: H, m: t % 60 };
}
function fmtHM(h, m) { const a = addMin(h, m); return hhmm(a.h, a.m); }

function tripStops(key, baseH, baseM) {
  return STOPS[key].map(([st, off]) => {
    const a = addMin(baseH, baseM + off);
    return { id: uid(), station: st, arr: hhmm(a.h, a.m), dep: hhmm(a.h, a.m), cancelled: false };
  });
}

// Baut eine Fahr = Duty-internen Trip (Fahrzeug wird NICHT zugewiesen – das
// macht der Supervisor später manuell im Shiftplan).
function makeTrip(line, kurs, from, to, depH, depM, stopKey, opts) {
  const dep = fmtHM(depH, depM);
  const arr = fmtHM(depH, depM + STOPS[stopKey][STOPS[stopKey].length - 1][1]);
  return {
    id: uid(), from, to, dep, arr,
    vehicleId: null,
    assignedUserId: null,
    bemerkung: (opts && opts.bemerkung) || "",
    leerfahrt: !!(opts && opts.leerfahrt),
    cancelled: false, cancelNote: "",
    zugNr: "", stops: (opts && opts.leerfahrt) ? [] : tripStops(stopKey, depH, depM),
  };
}

// Liest die Leerfahrt-Fahrzeit aus dem Fahrplan: Offset der Betriebshof-Haltestelle
// innerhalb der Kurs-Route (= Zeit Hof ↔ erste/letzte Haltestelle laut Referenz-Sheet).
function hofMin(stopKey) {
  const stops = STOPS[stopKey] || [];
  const bh = stops.find(([st]) => /Betriebshof/i.test(st));
  return bh ? bh[1] : 10;
}

// Führt wiederkehrende Kurse stundenweise durch und hängt Trips in eine Duty
function repeatCourse(duty, planRun) {
  // planRun: {hours:{from,to}, plan:[{line,kurs,from,to,depMin,stopKey,sonder?}]}
  const hrs = planRun.hours || { from: 5, to: 22 };
  for (let h = hrs.from; h < hrs.to; h++) {
    for (let i = 0; i < planRun.plan.length; i++) {
      const t = planRun.plan[i];
      // Umlauf-Turn: startet der Eintrag "vor" seinem Vorgänger (z. B. Rückfahrt
      // :00 nach Hinweg :30), gehört er in die Folgestunde – sonst lägen die Zeiten
      // rückwärts (05:30 → 05:00). Turn = +1 Stunde ab dem Zurücksprung.
      const dH = i > 0 && t.depMin < planRun.plan[i - 1].depMin ? h + 1 : h;
      duty.trips.push(makeTrip(t.line, t.kurs, t.from, t.to, dH, t.depMin, t.stopKey));
    }
  }
}

// Hängt eine Leerfahrt (Hof → erste Haltestelle bzw. letzte Haltestelle → Hof) an.
// Zeit ergibt sich aus den Fahrplanzeiten: hofMin Minuten laut Route.
function addLeerfahrt(duty, hin) {
  const t0 = duty.trips[0];
  const tl = duty.trips[duty.trips.length - 1];
  if (!t0 || !tl) return;
  if (hin && t0.dep) {
    const [h, m] = t0.dep.split(":").map(Number);
    const min = Math.max(1, hofMin(duty._firstStopKey));
    const hh = fmtHM(h, m - min);
    duty.trips.unshift({
      id: uid(),
      from: "Hof (Betriebshof Neuenburg)",
      to: t0.from,
      dep: hh, arr: t0.dep,
      vehicleId: null, assignedUserId: null,
      bemerkung: "Leerfahrt zum Einsatzbeginn",
      leerfahrt: true,
      cancelled: false, cancelNote: "", zugNr: "", stops: [],
    });
  } else if (!hin && tl.arr) {
    const [h, m] = tl.arr.split(":").map(Number);
    const min = Math.max(1, hofMin(duty._lastStopKey));
    const hh = fmtHM(h, m + min);
    duty.trips.push({
      id: uid(),
      from: tl.to,
      to: "Hof (Betriebshof Neuenburg)",
      dep: tl.arr, arr: hh,
      vehicleId: null, assignedUserId: null,
      bemerkung: "Leerfahrt zurück zum Hof",
      leerfahrt: true,
      cancelled: false, cancelNote: "", zugNr: "", stops: [],
    });
  }
}

// ---------- Kurse definieren ----------

// Linie 19 – 4 Solo-Kurse, stündlich :00/:15/:30/:45 (laut Sheets)
const line19 = [
  { kurs: "19 Kurs 1", fz: "2003", plan: [
    { line: "19", kurs: 1, from: "Stümp Voiskamp", to: "Gravenberg ZOB", depMin: 0, stopKey: "19_sv_gvz" },
    { line: "19", kurs: 2, from: "Gravenberg ZOB", to: "Stümp Voiskamp", depMin: 30, stopKey: "19_gvz_sv" },
  ] },
  { kurs: "19 Kurs 2", fz: "1101", plan: [
    { line: "19", kurs: 2, from: "Gravenberg ZOB", to: "Stümp Voiskamp", depMin: 0, stopKey: "19_gvz_sv" },
    { line: "19", kurs: 1, from: "Stümp Voiskamp", to: "Gravenberg ZOB", depMin: 30, stopKey: "19_sv_gvz" },
  ] },
  { kurs: "19 Kurs 3", fz: "1102", plan: [
    { line: "19", kurs: 1, from: "Stümp Voiskamp", to: "Gravenberg ZOB", depMin: 30, stopKey: "19_sv_gvz" },
    { line: "19", kurs: 2, from: "Gravenberg ZOB", to: "Stümp Voiskamp", depMin: 0, stopKey: "19_gvz_sv" },
  ] },
  { kurs: "19 Kurs 3b", fz: "1103", plan: [
    { line: "19", kurs: 2, from: "Gravenberg ZOB", to: "Stümp Voiskamp", depMin: 15, stopKey: "19_gvz_sv" },
    { line: "19", kurs: 1, from: "Stümp Voiskamp", to: "Gravenberg ZOB", depMin: 45, stopKey: "19_sv_gvz" },
  ] },
];

// Linie 24 (Schnellbus) – 2 Gelenk-Kurse, 15-Minuten-Takt
const line24 = [
  { kurs: "(SB) 24 Kurs 1", fz: "1461", plan: [
    { line: "24", kurs: 1, from: "Sorenkoppel", to: "Gravenberg ZOB", depMin: 0, stopKey: "24_sk_gvz" },
    { line: "24", kurs: 2, from: "Gravenberg ZOB", to: "Sorenkoppel", depMin: 15, stopKey: "24_gvz_sk" },
    { line: "24", kurs: 1, from: "Sorenkoppel", to: "Gravenberg ZOB", depMin: 30, stopKey: "24_sk_gvz" },
    { line: "24", kurs: 2, from: "Gravenberg ZOB", to: "Sorenkoppel", depMin: 45, stopKey: "24_gvz_sk" },
  ] },
  { kurs: "(SB) 24 Kurs 2", fz: "2560", plan: [
    { line: "24", kurs: 2, from: "Gravenberg ZOB", to: "Sorenkoppel", depMin: 0, stopKey: "24_gvz_sk" },
    { line: "24", kurs: 1, from: "Sorenkoppel", to: "Gravenberg ZOB", depMin: 15, stopKey: "24_sk_gvz" },
    { line: "24", kurs: 2, from: "Gravenberg ZOB", to: "Sorenkoppel", depMin: 30, stopKey: "24_gvz_sk" },
    { line: "24", kurs: 1, from: "Sorenkoppel", to: "Gravenberg ZOB", depMin: 45, stopKey: "24_sk_gvz" },
  ] },
];

// Linie 8 – 2 Solo-Kurse, 10/20-Minuten-Takt
const line8 = [
  { kurs: "8 Kurs 1", fz: "1401", plan: [
    { line: "8", kurs: 1, from: "Bf. Gravenberg", to: "Bergdorf", depMin: 0, stopKey: "8_bg_bd" },
    { line: "8", kurs: 2, from: "Bergdorf", to: "Bf. Gravenberg", depMin: 10, stopKey: "8_bd_bg" },
    { line: "8", kurs: 1, from: "Bf. Gravenberg", to: "Bergdorf", depMin: 20, stopKey: "8_bg_bd" },
    { line: "8", kurs: 2, from: "Bergdorf", to: "Bf. Gravenberg", depMin: 30, stopKey: "8_bd_bg" },
    { line: "8", kurs: 2, from: "Bf. Gravenberg", to: "Bergdorf", depMin: 40, stopKey: "8_bg_bd" },
    { line: "8", kurs: 2, from: "Bergdorf", to: "Bf. Gravenberg", depMin: 50, stopKey: "8_bd_bg" },
  ] },
  { kurs: "8 Kurs 2", fz: "1402", plan: [
    { line: "8", kurs: 1, from: "Bergdorf", to: "Bf. Gravenberg", depMin: 0, stopKey: "8_bd_bg" },
    { line: "8", kurs: 2, from: "Bf. Gravenberg", to: "Bergdorf", depMin: 10, stopKey: "8_bg_bd" },
    { line: "8", kurs: 1, from: "Bergdorf", to: "Bf. Gravenberg", depMin: 20, stopKey: "8_bd_bg" },
    { line: "8", kurs: 2, from: "Bf. Gravenberg", to: "Bergdorf", depMin: 30, stopKey: "8_bg_bd" },
    { line: "8", kurs: 1, from: "Bergdorf", to: "Bf. Gravenberg", depMin: 40, stopKey: "8_bd_bg" },
    { line: "8", kurs: 2, from: "Bf. Gravenberg", to: "Bergdorf", depMin: 50, stopKey: "8_bg_bd" },
  ] },
];

// Linie N1 (Nachtbus) – 1 Gelenk-Kurs, 23:20–04:20
const lineN1 = {
  kurs: "N1 Kurs 1", fz: "2561", plan: [
    { line: "N1", kurs: 1, from: "Gravenberg ZOB", to: "Neuenburg Sorenkoppel", depMin: 20, stopKey: "n1_gvz_sk" },
    { line: "N1", kurs: 2, from: "Neuenburg Sorenkoppel", to: "Gravenberg ZOB", depMin: 1, stopKey: "n1_sk_gvz" },
  ], hours: { from: 23, to: 29 } // 23:20 … 04:20 (via +24h-Fortführung)
};

// Einsetzer 1 (Sonderfahrt 004) – Gelenk, 15-Minuten-Takt am Sorenkoppel
const einsetzer = {
  kurs: "Einsetzer 1", fz: "2605", plan: [
    { line: "4", kurs: 1, from: "Sorenkoppel", to: "Abzweig Sütel", depMin: 5, stopKey: "24_sk_gvz", sonder: "004" },
    { line: "4", kurs: 1, from: "Abzweig Sütel", to: "Sorenkoppel", depMin: 20, stopKey: "24_gvz_sk", sonder: "004" },
    { line: "4", kurs: 1, from: "Sorenkoppel", to: "Abzweig Sütel", depMin: 35, stopKey: "24_sk_gvz", sonder: "004" },
    { line: "4", kurs: 1, from: "Abzweig Sütel", to: "Sorenkoppel", depMin: 50, stopKey: "24_gvz_sk", sonder: "004" },
  ], hours: { from: 5, to: 22 }
};

// ---------- Flotte mit stabilen IDs aufbauen ----------
const vehicles = FLEET.map((f) => ({
  id: uid(), wagennummer: f.w, kennzeichen: f.kz, typ: f.typ, art: f.art,
  status: f.status, ort: f.ort, bemerkung: f.bemerkung,
}));
const FZ_BY_WAGEN = {};
vehicles.forEach((v) => (FZ_BY_WAGEN[v.wagennummer] = v.id));

// ---------- Duties bauen ----------

function buildDuties(shiftId) {
  const duties = [];

  const mk = (course, lineId, planRun) => {
    const duty = {
      id: uid(), shiftId,
      linieId: lineId, kurs: course.kurs,
      name: course.kurs,
      vehicleId: null,
      startTime: "", endTime: "",
      notes: planRun.notes || "",
      bemerkung: "",
      linienwechsel: planRun.wechsel || "",
      cancelled: false, cancelNote: "", assignedUserId: null, trips: [], createdAt: "",
    };
    duty._firstStopKey = planRun.plan[0].stopKey;
    duty._lastStopKey = planRun.plan[planRun.plan.length - 1].stopKey;
    repeatCourse(duty, planRun);
    const hasSonder = planRun.plan.some((t) => t.sonder);
    if (duty.trips.length) {
      // Leerfahrten: Hof → erste Haltestelle (nachts analog), letzte Haltestelle → Hof
      addLeerfahrt(duty, true);
      addLeerfahrt(duty, false);
      duty.startTime = duty.trips[0].dep;
      duty.endTime = duty.trips[duty.trips.length - 1].arr;
    }
    if (hasSonder) duty.notes = "Sonderziel-Code 004";
    return duty;
  };

  const standard = { hours: { from: 5, to: 22 } }; // 05:00 – 21:xx
  line19.forEach((k) => duties.push(mk(k, "lin19", { ...standard, plan: k.plan })));
  line24.forEach((k) => duties.push(mk(k, "lin24", { ...standard, plan: k.plan, wechsel: "Umlauf kann am GVZ auf Linie 19 wechseln" })));
  line8.forEach((k) => duties.push(mk(k, "lin8", { ...standard, plan: k.plan })));
  const n1 = mk({ kurs: "N1 Kurs 1", fz: lineN1.fz }, "linN1", { hours: lineN1.hours, plan: lineN1.plan });
  duties.push(n1);
  const es = mk({ kurs: "Einsetzer 1", fz: einsetzer.fz }, "lin19", { hours: einsetzer.hours, plan: einsetzer.plan });
  duties.push(es);

  return duties;
}

// ---------- Ausgabe ----------
const SHIFT_ID = "tpl-tagesplan";
const shift = {
  id: SHIFT_ID,
  name: "Tagesplan VBG",
  date: "",
  startTime: "05:00",
  endTime: "04:20",
  notes: "Wiederverwendbarer Tagesplan (ohne Datum). Über „Aus Tagesplan kopieren” für eine Shift übernehmen.",
  createdBy: null,
  createdAt: new Date().toISOString(),
};

const duties = buildDuties(SHIFT_ID);

const out = { shift, shifts: [shift], linien: LINIEN, fahrzeuge: vehicles, duties };

const file = path.join(__dirname, "duties.json");
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log("Geschrieben:", file);
console.log("Fahrzeuge:", vehicles.length, "| Dutys:", duties.length);

// kurze Übersicht
const byLine = {};
duties.forEach((d) => { const k = d.linieId; byLine[k] = (byLine[k] || 0) + 1; });
console.log("Dutys je Linie:", byLine);
console.log("Trip-Beispiel:", duties[0].name, duties[0].trips[0].dep, duties[0].trips[0].from, "→", duties[0].trips[0].to, "|", duties[0].trips[0].arr);