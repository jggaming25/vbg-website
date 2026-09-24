"use strict";

// ---------- Globale Helfer ----------

function h(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function toast(msg, kind) {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "toast-wrap";
    document.body.appendChild(wrap);
  }
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const BELL_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>`;

// ---------- State ----------

const state = {
  user: null,
  view: "dashboard",
  currentShiftId: null,
  cats: { stellwerke: [], fahrzeuge: [] },
  users: [],
  shifts: [],
  notifications: [],
  notifOpen: false,
  userboxOpen: false,
  editingDutyId: null,
  lastSeen: localStorage.getItem("vbg_notif_seen") || "0",
};

// ---------- Daten laden ----------

async function loadCats() {
  const [s, f] = await Promise.all([
    api("GET", "/api/stellwerke"),
    api("GET", "/api/fahrzeuge"),
  ]);
  state.cats = { stellwerke: s.items, fahrzeuge: f.items };
}

async function loadUsers() {
  const r = await api("GET", "/api/users");
  state.users = r.users;
}

async function loadShifts() {
  const r = await api("GET", "/api/shifts");
  state.shifts = r.shifts;
}

function fzName(id) {
  const f = state.cats.fahrzeuge.find((x) => x.id === id);
  return f ? f.name : id ? id : "–";
}
function stwName(id) {
  const s = state.cats.stellwerke.find((x) => x.id === id);
  return s ? s.name : id ? id : "–";
}
function userName(id) {
  const u = state.users.find((x) => x.id === id);
  return u ? u.username : "–";
}
function effectiveVehicle(duty) {
  if (duty.vehicleId) return duty.vehicleId;
  const t = (duty.trips || []).find((x) => x.vehicleId);
  return t ? t.vehicleId : null;
}
function hasTfLic(el) {
  return state.user.tf && state.user.tf.includes(el);
}

// ---------- Rendering ----------

const app = document.getElementById("app");

function render() {
  if (!state.user) return renderLogin();
  renderShell();
}

function renderLogin() {
  app.innerHTML = `
  <div class="login-wrap">
    <div class="login-card">
      <h1>VBG <span style="color:var(--accent)">Website</span></h1>
      <p class="sub">Anmeldung – FDL / TF</p>
      <label>Benutzername</label>
      <input id="lg-user" type="text" autocomplete="username" />
      <label>Passwort</label>
      <input id="lg-pass" type="password" autocomplete="current-password" />
      <div class="row">
        <input id="lg-remember" type="checkbox" /> <span>Angemeldet bleiben</span>
      </div>
      <button class="btn" id="lg-btn">Anmelden</button>
      <div class="login-error" id="lg-err"></div>
    </div>
  </div>`;
  const u = document.getElementById("lg-user");
  const p = document.getElementById("lg-pass");
  if (u) u.focus();
  const doLogin = async () => {
    const err = document.getElementById("lg-err");
    try {
      const r = await api("POST", "/api/auth/login", {
        username: u.value,
        password: p.value,
        remember: document.getElementById("lg-remember").checked,
      });
      Auth.saveToken(r.token, document.getElementById("lg-remember").checked);
      state.user = r.user;
      afterLogin();
    } catch (e) {
      if (err) err.textContent = e.message;
    }
  };
  document.getElementById("lg-btn").onclick = doLogin;
  p.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
}

async function afterLogin() {
  try {
    await loadCats();
    if (state.user.role === "supervisor") await Promise.all([loadUsers(), loadShifts()]);
    else await loadShifts();
    await pollNotifications(true);
    render();
    startPolling();
    requestNotifPermissionIfPossible();
  } catch (e) {
    toast(e.message, "err");
  }
}

function renderShell() {
  const sup = state.user.role === "supervisor";
  app.innerHTML = `
  <div class="topbar">
    <div class="brand">VBG <span class="sg">Website</span></div>
    <nav>
      <a data-nav="dashboard" class="active" href="#">Übersicht</a>
      <a data-nav="shifts" href="#">Shifts / Dutys</a>
      <a data-nav="vehicles" href="#">Fahrzeuge</a>
      ${sup ? `<a data-nav="users" href="#">Nutzer</a>` : ""}
      ${sup ? `<a data-nav="wishes" href="#">Wünsche</a>` : ""}
      ${sup ? `<a data-nav="licenses" href="#">Lizenzen</a>` : ""}
    </nav>
    <div class="right">
      <div class="notif-wrap">
        <button class="notif-btn" id="notif-btn" title="Benachrichtigungen"></button>
        <div class="notif-drop" id="notif-drop"></div>
      </div>
      <div class="userbox">
        <button class="userbox-btn" id="ubox-btn">
          <span class="avatar">${h(state.user.username.slice(0, 2).toUpperCase())}</span>
          <span class="name">${h(state.user.username)}</span>
        </button>
        <div class="userbox-drop" id="ubox-drop">
          <div class="who">
            <b>${h(state.user.username)}</b>
            ${state.user.role === "supervisor" ? '<span class="crown">&#9813; Supervisor</span>' : ""}
            <div class="role">${state.user.suspended ? "gesperrt" : "aktiv"}</div>
          </div>
          <div class="lic">
            <b>FDL-Lizenzen:</b> ${state.user.fdl.length ? state.user.fdl.map(stwName).join(", ") : "keine"}<br>
            <b>TF-Lizenzen:</b> ${state.user.tf.length ? state.user.tf.map(fzName).join(", ") : "keine"}
          </div>
          <button id="desktop-notif-btn">Desktop-Benachrichtigungen aktivieren</button>
          <button class="danger" id="logout-btn">Abmelden</button>
        </div>
      </div>
    </div>
  </div>
  <main id="main"></main>`;

  document.querySelectorAll("nav a").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      setView(a.dataset.nav);
    };
  });

  document.getElementById("notif-btn").onclick = (e) => {
    e.stopPropagation();
    state.notifOpen = !state.notifOpen;
    document.getElementById("notif-drop").classList.toggle("open", state.notifOpen);
  };
  document.getElementById("ubox-btn").onclick = (e) => {
    e.stopPropagation();
    state.userboxOpen = !state.userboxOpen;
    document.getElementById("ubox-drop").classList.toggle("open", state.userboxOpen);
  };
  document.addEventListener("click", () => {
    document.getElementById("notif-drop").classList.remove("open");
    document.getElementById("ubox-drop").classList.remove("open");
    state.notifOpen = state.userboxOpen = false;
  });
  document.getElementById("logout-btn").onclick = doLogout;
  const dnb = document.getElementById("desktop-notif-btn");
  if (dnb) dnb.onclick = () => requestNotifPermission(true);

  renderNotifBadge();
  renderView();
}

function setView(v) {
  state.view = v;
  document.querySelectorAll("nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.nav === v);
  });
  renderView();
}

async function renderView() {
  const main = document.getElementById("main");
  try {
    if (state.view === "dashboard") await renderDashboard(main);
    else if (state.view === "shifts") await renderShifts(main);
    else if (state.view === "shiftDetail") await renderShiftDetail(main);
    else if (state.view === "vehicles") await renderVehicles(main);
    else if (state.view === "users") await renderUsers(main);
    else if (state.view === "wishes") await renderWishes(main);
    else if (state.view === "licenses") await renderLicenses(main);
  } catch (e) {
    main.innerHTML = `<div class="empty">${h(e.message)}</div>`;
  }
}

// ---------- Dashboard ----------

async function renderDashboard(main) {
  main.innerHTML = `<div class="spinner">Lade…</div>`;
  const sup = state.user.role === "supervisor";
  const shifts = state.shifts;
  let wishes = [];
  let users = [];
  if (sup) {
    try {
      const [wr, ur] = await Promise.all([
        api("GET", "/api/wishes"),
        api("GET", "/api/users"),
      ]);
      wishes = wr.wishes.filter((w) => w.status === "pending");
      users = ur.users;
    } catch (e) { /* ignore */ }
  }

  let myDuties = [];
  if (!sup) {
    const out = [];
    for (const sh of shifts) {
      const r = await api("GET", "/api/shifts/" + sh.id + "/duties");
      out.push(...r.duties.filter((d) => d.assignedUserId === state.user.id));
    }
    myDuties = out;
  }

  const activeUsers = users.filter((u) => !u.suspended).length;
  main.innerHTML = `
    <div class="card-grid">
      <div class="stat"><div class="num">${shifts.length}</div><div class="lbl">Shifts</div></div>
      ${sup ? `<div class="stat"><div class="num">${activeUsers}</div><div class="lbl">aktive Nutzer</div></div>
      <div class="stat"><div class="num">${wishes.length}</div><div class="lbl">offene Wünsche</div></div>` : `
      <div class="stat"><div class="num">${myDuties.length}</div><div class="lbl">meine Dutys</div></div>`}
      <div class="stat"><div class="num">${state.cats.fahrzeuge.length}</div><div class="lbl">Fahrzeuge</div></div>
    </div>
    <div class="container" style="margin-top:16px">
      <h2>Willkommen, ${h(state.user.username)}!</h2>
      <p class="muted">Plane Shifts, teile Dutys zu und behalte die Fahrzeuge im Blick.</p>
      <div class="flex" style="margin-top:8px">
        <button class="btn" onclick="VBG.setView('shifts')">Zu den Shifts</button>
        <button class="btn btn-ghost" onclick="VBG.setView('vehicles')">Fahrzeugübersicht</button>
      </div>
    </div>
    ${wishes.length ? `
    <div class="container">
      <h2>Offene Zuteilungswünsche</h2>
      <table>
        <tr><th>Nutzer</th><th>Duty</th><th>Shift</th><th>Fahrzeug</th><th></th></tr>
        ${wishes.map((w) => `
        <tr>
          <td>${h(w.username)}</td>
          <td>${h(w.dutyName)}</td>
          <td>${h(w.shiftName)}</td>
          <td>${h(w.vehicleName || "–")}</td>
          <td class="flex">
            <button class="btn btn-green btn-sm" onclick="VBG.acceptWish('${w.id}')">Annehmen</button>
            <button class="btn btn-danger btn-sm" onclick="VBG.denyWish('${w.id}')">Ablehnen</button>
          </td>
        </tr>`).join("")}
      </table>
    </div>` : ""}
    ${!sup && myDuties.length ? `
    <div class="container">
      <h2>Meine Dutys</h2>
      ${myDuties.map((d) => `
        <div class="duty-card ${d.cancelled ? "cancelled" : ""}">
          <div class="duty-head">
            <div>
              <div class="duty-title">${h(d.name)} ${d.cancelled ? '<span class="badge red">entfällt</span>' : ""}</div>
              <div class="duty-meta">Fahrzeug: ${h(fzName(effectiveVehicle(d)))}
                ${d.cancelNote ? " · Vermerk: " + h(d.cancelNote) : ""}</div>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="VBG.openShift('${d.shiftId}')">Shift ansehen</button>
          </div>
        </div>`).join("")}
    </div>` : ""}
  `;
}

// ---------- Shifts (Übersicht) ----------

async function renderShifts(main) {
  await loadShifts();
  const sup = state.user.role === "supervisor";
  main.innerHTML = `
    <div class="spread" style="margin-bottom:16px">
      <h1 style="margin:0;font-size:20px">Shifts &amp; Dutys</h1>
      ${sup ? `<button class="btn" onclick="VBG.showShiftForm()">+ Neue Shift</button>` : ""}
    </div>
    <div id="shift-form"></div>
    <div id="shift-list"></div>`;
  if (!state.shifts.length) {
    document.getElementById("shift-list").innerHTML =
      `<div class="empty">Noch keine Shifts. ${sup ? "Lege die erste an." : "Bitte warte auf den Supervisor."}</div>`;
    return;
  }
  document.getElementById("shift-list").innerHTML = state.shifts.map((s) => `
    <div class="container">
      <div class="spread">
        <div>
          <b style="font-size:16px">${h(s.name)}</b>
          <span class="muted"> · ${s.date ? h(s.date) : "kein Datum"}</span>
          <span class="badge sky" style="margin-left:10px">${s.dutyCount} Dutys</span>
        </div>
        <div class="flex">
          ${sup ? `<button class="btn btn-ghost btn-sm" onclick="VBG.editShift('${s.id}')">Bearbeiten</button>
          <button class="btn btn-danger btn-sm" onclick="VBG.deleteShift('${s.id}')">Löschen</button>` : ""}
          <button class="btn btn-sm" onclick="VBG.openShift('${s.id}')">Öffnen</button>
        </div>
      </div>
      ${s.notes ? `<p class="muted" style="margin:8px 0 0">${h(s.notes)}</p>` : ""}
    </div>`).join("");
}

function showShiftForm() {
  const el = document.getElementById("shift-form");
  el.innerHTML = `
    <div class="container">
      <h2>Neue Shift anlegen</h2>
      <div class="form-grid">
        <input id="sf-name" placeholder="Name (z.B. Frühschicht So)" />
        <input id="sf-date" type="date" />
      </div>
      <textarea id="sf-notes" placeholder="Notizen (optional)" style="width:100%;margin-top:10px;min-height:60px"></textarea>
      <div class="flex" style="margin-top:10px">
        <button class="btn btn-green" onclick="VBG.createShift()">Speichern</button>
        <button class="btn btn-ghost" onclick="VBG.cancelShiftForm()">Abbrechen</button>
      </div>
    </div>`;
}

function cancelShiftForm() {
  document.getElementById("shift-form").innerHTML = "";
}

function editShift(id) {
  const s = state.shifts.find((x) => x.id === id);
  document.getElementById("shift-form").innerHTML = `
    <div class="container">
      <h2>Shift bearbeiten</h2>
      <div class="form-grid">
        <input id="sf-name" value="${h(s.name)}" />
        <input id="sf-date" type="date" value="${h(s.date)}" />
      </div>
      <textarea id="sf-notes" style="width:100%;margin-top:10px;min-height:60px">${h(s.notes)}</textarea>
      <div class="flex" style="margin-top:10px">
        <button class="btn btn-green" onclick="VBG.updateShift('${s.id}')">Speichern</button>
        <button class="btn btn-ghost" onclick="VBG.cancelShiftForm()">Abbrechen</button>
      </div>
    </div>`;
}

// ---------- Shift-Detail (Duty-Planung) ----------

async function renderShiftDetail(main) {
  const shiftId = state.currentShiftId;
  main.innerHTML = `<div class="spinner">Lade Dutys…</div>`;
  const r = await api("GET", "/api/shifts/" + shiftId + "/duties");
  const shift = r.shift;
  const duties = r.duties;
  const sup = state.user.role === "supervisor";
  if (!r.duties) return main.innerHTML = `<div class="empty">Keine Dutys.</div>`;
  state.editTrip = state.editTrip || {};
  state.editStop = state.editStop || {};
  duties.forEach((d) => {
    d.editingTrip = state.editTrip[d.id] || null;
    d.trips.forEach((t) => {
      t.editingStop = state.editStop[t.id] || null;
    });
  });

  let wishes = [];
  if (sup) {
    const wr = await api("GET", "/api/wishes");
    wishes = wr.wishes.filter((w) => w.shiftId === shiftId && w.status === "pending");
  }
  if (sup) await loadUsers();

  main.innerHTML = `
    <div class="spread" style="margin-bottom:16px">
      <div>
        <button class="btn btn-ghost btn-sm" onclick="VBG.setView('shifts')">&larr; Shifts</button>
        <h1 style="margin:6px 0 0;font-size:20px">${h(shift.name)} <span class="muted">${h(shift.date)}</span></h1>
        ${shift.notes ? `<p class="muted" style="margin:4px 0 0">${h(shift.notes)}</p>` : ""}
      </div>
      ${sup ? `<button class="btn" onclick="VBG.showDutyForm('${shiftId}')">+ Duty anlegen</button>` : ""}
    </div>
    <div id="duty-form"></div>
    ${wishes.length ? `
    <div class="container">
      <h2>Zuteilungswünsche dieser Shift</h2>
      ${wishes.map((w) => `
        <div class="flex" style="justify-content:space-between;border-top:1px solid var(--border);padding:8px 0">
          <span><b>${h(w.username)}</b> → ${h(w.dutyName)} <span class="muted">(${h(w.vehicleName || "ohne Fzg")})</span></span>
          <span class="flex">
            <button class="btn btn-green btn-sm" onclick="VBG.acceptWish('${w.id}')">Zuteilen</button>
            <button class="btn btn-danger btn-sm" onclick="VBG.denyWish('${w.id}')">Ablehnen</button>
          </span>
        </div>`).join("")}
    </div>` : ""}
    ${!duties.length ? `<div class="empty">Noch keine Dutys in dieser Shift.</div>` :
      duties.map((d) => dutyCard(d, shiftId, sup)).join("")}
  `;
  bindDutyInputs();
}

function dutyCard(d, shiftId, sup) {
  const vehicleId = effectiveVehicle(d);
  const lic = state.user.fdl.concat(state.user.tf);
  const fzOpts = state.cats.fahrzeuge.map((f) =>
    `<option value="${f.id}" ${f.id === d.vehicleId ? "selected" : ""}>${h(f.name)}</option>`).join("");
  const driverOpts = `<option value="">— nicht zugeteilt —</option>` +
    state.users.filter((u) => !u.suspended && u.role === "user").map((u) =>
      `<option value="${u.id}" ${u.id === d.assignedUserId ? "selected" : ""} >${h(u.username)} <span>[TF: ${u.tf.map(fzName).join(", ")}]</span></option>`).join("");

  const canWish = !sup && !d.assignedUserId && vehicleId && hasTfLic(vehicleId);

  return `
  <div class="duty-card ${d.cancelled ? "cancelled" : ""}" id="duty-${d.id}">
    <div class="duty-head">
      <div>
        <div class="duty-title">
          ${h(d.name)}
          ${d.cancelled ? '<span class="badge red">entfällt</span>' : ""}
          ${d.assignedUserId ? `<span class="badge green">${h(userName(d.assignedUserId))}</span>` : '<span class="badge gray">frei</span>'}
        </div>
        <div class="duty-meta">
          Fahrzeug: <b>${h(fzName(vehicleId))}</b>${d.unit ? ` <span class="muted">(${h(d.unit)})</span>` : ""}
          ${d.startTime ? ` · Dienst <b>${h(d.startTime)}–${h(d.endTime)}</b>` : ""}
          · ${d.trips.length} Fahrt(en) · ${d.trips.reduce((n, t) => n + t.stops.length, 0)} Halte
        </div>
      </div>
      <div class="flex">
        ${canWish ? `<button class="btn btn-yellow btn-sm" onclick="VBG.wishDuty('${d.id}')">Duty wünschen</button>` : ""}
        ${sup && d.assignedUserId ? `<button class="btn btn-ghost btn-sm" onclick="VBG.unassignDuty('${d.id}')">Zuteilung lösen</button>` : ""}
        ${sup ? `<button class="btn btn-ghost btn-sm" onclick="VBG.deleteDuty('${d.id}')">Duty löschen</button>` : ""}
      </div>
    </div>

    ${sup ? `
    <div class="form-grid" style="margin-top:10px">
      <select data-duty="${d.id}" data-kind="vehicle" title="Fahrzeug der Duty">
        <option value="">— ohne Fahrzeug —</option>${fzOpts}
      </select>
      <select data-duty="${d.id}" data-kind="driver" title="Fahrer zuweisen">${driverOpts}</select>
      <button class="btn btn-ghost btn-sm" data-duty="${d.id}" data-kind="vehall" title="Fahrzeug auch auf alle Fahrten übernehmen">Fzg für alle Fahrten</button>
    </div>` : ""}

    <fieldset>
      <legend>Vermerke</legend>
      <textarea data-duty="${d.id}" data-kind="notes" ${sup ? "" : "disabled"} style="width:100%;min-height:52px">${h(d.notes)}</textarea>
      ${sup ? `
      <div class="flex" style="margin-top:6px">
        <label class="checkline"><input type="checkbox" data-duty="${d.id}" data-kind="cancel" ${d.cancelled ? "checked" : ""} /> Duty entfällt</label>
        <input data-duty="${d.id}" data-kind="cancel-note" placeholder="Vermerk (z.B. Bauarbeiten)" value="${h(d.cancelNote)}" style="flex:1" />
      </div>` : ""}
    </fieldset>

    ${d.trips.map((t) => tripCard(d, t, sup)).join("")}

    ${sup ? `
    <div class="form-grid" style="margin-top:12px" id="addtrip-${d.id}">
      <input id="t-${d.id}-from" placeholder="Von" />
      <input id="t-${d.id}-to" placeholder="Nach" />
      <input id="t-${d.id}-dep" placeholder="Abfahrt (z.B. 06:12)" />
      <input id="t-${d.id}-arr" placeholder="Ankunft" />
      <button class="btn btn-sm" onclick="VBG.addTrip('${d.id}')">+ Fahrt</button>
    </div>` : ""}
  </div>`;
}

function tripCard(d, t, sup) {
  const fzOpts = `<option value="">(Duty-Fzg)</option>` +
    state.cats.fahrzeuge.map((f) =>
      `<option value="${f.id}" ${f.id === t.vehicleId ? "selected" : ""}>${h(f.name)}</option>`).join("");
  return `
  <div class="trip ${t.cancelled ? "cancelled" : ""}" id="trip-${t.id}">
    <div class="trip-line">
      <b>${h(t.from)}</b> <span class="trip-arrow">→</span> <b>${h(t.to)}</b>
      <span class="muted">${t.dep ? t.dep : "–"} ${t.arr ? "→ " + t.arr : ""}</span>
      ${t.vehicleId ? `<span class="badge sky">${h(fzName(t.vehicleId))}</span>` : ""}
      ${t.cancelled ? `<span class="badge red">Fahrt entfällt</span>` : ""}
      ${sup ? `
      <span class="flex" style="margin-left:auto">
        <button class="btn btn-xs" onclick="VBG.toggleTripEdit('${d.id}','${t.id}')">Bearbeiten</button>
        <button class="btn btn-xs btn-danger" onclick="VBG.deleteTrip('${d.id}','${t.id}')">×</button>
      </span>` : ""}
    </div>
    ${t.cancelNote ? `<div class="muted" style="margin-top:4px;color:var(--red)">Entfall: ${h(t.cancelNote)}</div>` : ""}

    ${sup && d.editingTrip === t.id ? `
    <div class="form-grid" style="margin-top:8px">
      <input id="te-${t.id}-from" value="${h(t.from)}" placeholder="Von" />
      <input id="te-${t.id}-to" value="${h(t.to)}" placeholder="Nach" />
      <input id="te-${t.id}-dep" value="${h(t.dep)}" placeholder="Abfahrt" />
      <input id="te-${t.id}-arr" value="${h(t.arr)}" placeholder="Ankunft" />
    </div>
    <div class="flex" style="margin-top:8px">
      <select id="te-${t.id}-vehicle">${fzOpts}</select>
      <label class="checkline"><input type="checkbox" id="te-${t.id}-cancel" ${t.cancelled ? "checked" : ""} /> entfällt</label>
      <input id="te-${t.id}-note" placeholder="Vermerk Fahrt" value="${h(t.cancelNote)}" style="flex:1" />
      <button class="btn btn-green btn-sm" onclick="VBG.saveTrip('${d.id}','${t.id}')">Speichern</button>
    </div>` : ""}

    <ul class="stop-list">
      ${t.stops.map((s) => `
      <li class="${s.cancelled ? "cancelled" : ""}">
        <b>${h(s.station)}</b>
        <span class="muted">${s.arr} ${s.dep ? "→ " + s.dep : ""}</span>
        ${s.cancelled ? '<span class="badge red">Halt entfällt</span>' : ""}
        ${sup ? `
        <span class="flex">
          ${t.editingStop === s.id ? `
            <input id="se-${s.id}-st" value="${h(s.station)}" style="width:120px" />
            <input id="se-${s.id}-arr" value="${h(s.arr)}" placeholder="An" style="width:60px" />
            <input id="se-${s.id}-dep" value="${h(s.dep)}" placeholder="Ab" style="width:60px" />
            <label class="checkline"><input type="checkbox" id="se-${s.id}-cancel" ${s.cancelled ? "checked" : ""} /> entfällt</label>
            <button class="btn btn-xs btn-green" onclick="VBG.saveStop('${d.id}','${t.id}','${s.id}')">Ok</button>
          ` : `
            <button class="btn btn-xs" onclick="VBG.toggleStopEdit('${d.id}','${t.id}','${s.id}')">Edit</button>
          `}
          <button class="btn btn-xs btn-danger" onclick="VBG.deleteStop('${d.id}','${t.id}','${s.id}')">×</button>
        </span>` : ""}
      </li>`).join("")}
      ${sup ? `
      <li>
        <span class="flex">
          <input id="ns-${t.id}-st" placeholder="Station" style="width:130px" />
          <input id="ns-${t.id}-arr" placeholder="An" style="width:60px" />
          <input id="ns-${t.id}-dep" placeholder="Ab" style="width:60px" />
          <button class="btn btn-xs" onclick="VBG.addStop('${d.id}','${t.id}')">+ Halt</button>
        </span>
      </li>` : ""}
    </ul>
  </div>`;
}

function bindDutyInputs() {
  document.querySelectorAll("[data-kind='vehicle']").forEach((sel) => {
    sel.onchange = async () => {
      try { await api("PATCH", "/api/duties/" + sel.dataset.duty, { vehicleId: sel.value || null }); toast("Fahrzeug geändert", "ok"); } catch (e) { toast(e.message, "err"); }
      await renderView();
    };
  });
  document.querySelectorAll("[data-kind='driver']").forEach((sel) => {
    sel.onchange = async () => {
      try { await api("PATCH", "/api/duties/" + sel.dataset.duty, { assignedUserId: sel.value || null }); toast("Zuteilung gespeichert", "ok"); } catch (e) { toast(e.message, "err"); }
      await renderView();
    };
  });
  document.querySelectorAll("[data-kind='vehall']").forEach((btn) => {
    btn.onclick = async () => {
      const sel = document.querySelector(`[data-duty="${btn.dataset.duty}"][data-kind="vehicle"]`);
      try { await api("POST", "/api/duties/" + btn.dataset.duty + "/vehicle", { vehicleId: sel.value || null, scope: "all" }); toast("Fahrzeug für alle Fahrten übernommen", "ok"); } catch (e) { toast(e.message, "err"); }
      await renderView();
    };
  });
  document.querySelectorAll("textarea[data-kind='notes']").forEach((ta) => {
    ta.onchange = async () => {
      try { await api("PATCH", "/api/duties/" + ta.dataset.duty, { notes: ta.value }); } catch (e) { toast(e.message, "err"); }
    };
  });
  document.querySelectorAll("[data-kind='cancel']").forEach((cb) => {
    cb.onchange = async () => {
      try {
        const note = document.querySelector(`[data-duty="${cb.dataset.duty}"][data-kind="cancel-note"]`).value;
        await api("PATCH", "/api/duties/" + cb.dataset.duty, { cancelled: cb.checked, cancelNote: note });
        toast(cb.checked ? "Duty wurde als entfallen markiert" : "Duty wieder aktiv", "ok");
      } catch (e) { toast(e.message, "err"); }
      await renderView();
    };
  });
  document.querySelectorAll("[data-kind='cancel-note']").forEach((inp) => {
    inp.onchange = async () => {
      try { await api("PATCH", "/api/duties/" + inp.dataset.duty, { cancelNote: inp.value }); } catch (e) { toast(e.message, "err"); }
    };
  });
}

function showDutyForm(shiftId) {
  const el = document.getElementById("duty-form");
  const fzOpts = state.cats.fahrzeuge.map((f) => `<option value="${f.id}">${h(f.name)}</option>`).join("");
  el.innerHTML = `
    <div class="container">
      <h2>Neue Duty</h2>
      <div class="form-grid">
        <input id="df-name" placeholder="Name (z.B. Dienst 1)" />
        <select id="df-vehicle"><option value="">— ohne Fahrzeug —</option>${fzOpts}</select>
        <input id="df-unit" placeholder="Einheit (z.B. 628 001)" />
        <input id="df-start" placeholder="Dienstanfang (z.B. 06:10)" />
        <input id="df-end" placeholder="Dienstende (z.B. 14:30)" />
      </div>
      <textarea id="df-notes" placeholder="Vermerke (optional)" style="width:100%;margin-top:10px;min-height:50px"></textarea>
      <div class="flex" style="margin-top:10px">
        <button class="btn btn-green" onclick="VBG.createDuty('${shiftId}')">Anlegen</button>
        <button class="btn btn-ghost" onclick="VBG.hideDutyForm()">Abbrechen</button>
      </div>
    </div>`;
}
function hideDutyForm() { document.getElementById("duty-form").innerHTML = ""; }

// ---------- Fahrzeuge ----------

async function renderVehicles(main) {
  main.innerHTML = `<div class="spinner">Berechne Fahrzeugübersicht…</div>`;
  const r = await api("GET", "/api/vehicles/overview");
  main.innerHTML = `
    <h1 style="margin:0 0 6px;font-size:20px">Fahrzeugübersicht</h1>
    <p class="muted" style="margin:0 0 16px">Status aller Fahrzeuge anhand aller Dutys – shiftunabhängig.</p>
    <div class="card-grid">
      ${r.vehicles.map((v) => `
      <div class="stat">
        <div class="spread">
          <span style="font-size:16px;font-weight:700">${h(v.name)}</span>
          <span class="badge ${v.status === "im Einsatz (heute)" ? "green" : v.status === "eingeplant" ? "sky" : "gray"}">${h(v.status)}</span>
        </div>
        ${v.spawn ? `<div class="lbl" style="margin-top:8px">Spawnt bei ${h(v.spawn.from)} (${h(v.spawn.dutyName)}, ${h(v.spawn.dep)})</div>` : `<div class="lbl" style="margin-top:8px">kein Einsatz geplant</div>`}
        ${v.uses.length ? `
        <table style="margin-top:8px">
          <tr><th>Duty</th><th>Shift</th><th>Strecke</th><th>Zeit</th></tr>
          ${v.uses.map((u) => `
          <tr>
            <td>${h(u.dutyName)}</td>
            <td>${h(u.shiftName)}</td>
            <td>${h(u.from)} → ${h(u.to)}</td>
            <td>${h(u.dep)} ${h(u.arr) ? "→ " + h(u.arr) : ""}</td>
          </tr>`).join("")}
        </table>` : ""}
        <div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="VBG.openVehicleDuties('${v.id}')">Details</button></div>
      </div>`).join("")}
    </div>`;
}

async function openVehicleDuties(vehicleId) {
  const r = await api("GET", "/api/vehicles/overview");
  const v = r.vehicles.find((x) => x.id === vehicleId);
  if (!v) return;
  const main = document.getElementById("main");
  main.innerHTML = `
    <button class="btn btn-ghost btn-sm" onclick="VBG.setView('vehicles')">&larr; Übersicht</button>
    <div class="container" style="margin-top:12px">
      <h2>${h(v.name)} – alle Dutys</h2>
      ${!v.uses.length ? `<div class="empty">Kein Einsatz geplant.</div>` : v.uses.map((u) => `
        <div class="duty-card" style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <b>${h(u.dutyName)}</b>
            <div class="duty-meta">${h(u.shiftName)} ${u.shiftDate ? "· " + h(u.shiftDate) : ""}</div>
            <div class="muted">${h(u.from)} → ${h(u.to)} · ${h(u.dep)} ${h(u.arr) ? "→ " + h(u.arr) : ""}</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="VBG.openShift('${u.shiftId}')">Shift öffnen</button>
        </div>`).join("")}
    </div>`;
}

// ---------- Nutzerverwaltung (Supervisor) ----------

async function renderUsers(main) {
  await loadUsers();
  main.innerHTML = `
    <div class="spread" style="margin-bottom:16px">
      <h1 style="margin:0;font-size:20px">Nutzerverwaltung</h1>
      <button class="btn" onclick="VBG.showUserForm()">+ Nutzer anlegen</button>
    </div>
    <div id="user-form"></div>
    <div class="container">
      <table>
        <tr><th>Nutzer</th><th>Rolle</th><th>FDL-Lizenzen</th><th>TF-Lizenzen</th><th>Status</th><th></th></tr>
        ${state.users.map((u) => `
        <tr>
          <td><b>${h(u.username)}</b>${u.protected ? ' <span class="badge violet">geschützt</span>' : ""}</td>
          <td>${u.role === "supervisor" ? '<span class="crown">&#9813; Supervisor</span>' : "User"}</td>
          <td>${u.fdl.length ? u.fdl.map(stwName).map(esc).join(", ") : '<span class="muted">–</span>'}</td>
          <td>${u.tf.length ? u.tf.map(fzName).map(esc).join(", ") : '<span class="muted">–</span>'}</td>
          <td>${u.suspended ? '<span class="badge red">gesperrt</span>' : '<span class="badge green">aktiv</span>'}</td>
          <td class="flex">
            ${u.protected ? '<span class="muted">unlöschbar / nicht sperrbar</span>' : `
            <button class="btn btn-ghost btn-sm" onclick="VBG.showLicForm('${u.id}')">Lizenzen</button>
            <button class="btn btn-ghost btn-sm" onclick="VBG.showPwForm('${u.id}')">Passwort</button>
            <button class="btn btn-sm ${u.suspended ? "btn-green" : "btn-yellow"}" onclick="VBG.toggleSuspend('${u.id}')">${u.suspended ? "Entsperren" : "Sperren"}</button>
            <button class="btn btn-danger btn-sm" onclick="VBG.deleteUser('${u.id}')">Löschen</button>`}
          </td>
        </tr>`).join("")}
      </table>
    </div>`;
}
function esc(x){ return String(x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function showUserForm() {
  const stw = state.cats.stellwerke.map((s) =>
    `<label class="checkline"><input type="checkbox" name="fdl" value="${s.id}">${h(s.name)}</label>`).join("");
  const fz = state.cats.fahrzeuge.map((f) =>
    `<label class="checkline"><input type="checkbox" name="tf" value="${f.id}">${h(f.name)}</label>`).join("");
  document.getElementById("user-form").innerHTML = `
    <div class="container">
      <h2>Neuen Nutzer anlegen</h2>
      <div class="form-grid">
        <input id="uf-user" placeholder="Benutzername" />
        <input id="uf-pass" type="password" placeholder="Passwort" />
      </div>
      <fieldset><legend>FDL-Lizenzen (Stellwerke)</legend>${stw || '<span class="muted">keine vorhanden</span>'}</fieldset>
      <fieldset><legend>TF-Lizenzen (Fahrzeuge)</legend>${fz || '<span class="muted">keine vorhanden</span>'}</fieldset>
      <div class="flex" style="margin-top:10px">
        <button class="btn btn-green" onclick="VBG.createUser()">Anlegen</button>
        <button class="btn btn-ghost" onclick="VBG.hideUserForm()">Abbrechen</button>
      </div>
    </div>`;
}
function hideUserForm() { document.getElementById("user-form").innerHTML = ""; }

function showLicForm(id) {
  const u = state.users.find((x) => x.id === id);
  const stw = state.cats.stellwerke.map((s) =>
    `<label class="checkline"><input type="checkbox" name="fdl" value="${s.id}" ${u.fdl.includes(s.id) ? "checked" : ""}>${h(s.name)}</label>`).join("");
  const fz = state.cats.fahrzeuge.map((f) =>
    `<label class="checkline"><input type="checkbox" name="tf" value="${f.id}" ${u.tf.includes(f.id) ? "checked" : ""}>${h(f.name)}</label>`).join("");
  document.getElementById("user-form").innerHTML = `
    <div class="container">
      <h2>Lizenzen für ${h(u.username)}</h2>
      <fieldset><legend>FDL-Lizenzen (Stellwerke)</legend>${stw || '<span class="muted">keine</span>'}</fieldset>
      <fieldset><legend>TF-Lizenzen (Fahrzeuge)</legend>${fz || '<span class="muted">keine</span>'}</fieldset>
      <div class="flex" style="margin-top:10px">
        <button class="btn btn-green" onclick="VBG.saveLicenses('${id}')">Speichern</button>
        <button class="btn btn-ghost" onclick="VBG.hideUserForm()">Abbrechen</button>
      </div>
    </div>`;
}

function showPwForm(id) {
  const u = state.users.find((x) => x.id === id);
  document.getElementById("user-form").innerHTML = `
    <div class="container">
      <h2>Passwort für ${h(u.username)}</h2>
      <input id="pw-pass" type="password" placeholder="Neues Passwort" style="width:100%" />
      <div class="flex" style="margin-top:10px">
        <button class="btn btn-green" onclick="VBG.savePassword('${id}')">Speichern</button>
        <button class="btn btn-ghost" onclick="VBG.hideUserForm()">Abbrechen</button>
      </div>
    </div>`;
}

// ---------- Wünsche ----------

async function renderWishes(main) {
  const r = await api("GET", "/api/wishes");
  const wishes = r.wishes;
  main.innerHTML = `
    <h1 style="margin:0 0 6px;font-size:20px">Zuteilungswünsche</h1>
    <p class="muted" style="margin:0 0 16px">Fahrer wünschen hier Dutys, für die sie die passende TF-Lizenz haben.</p>
    ${!wishes.filter((w) => w.status === "pending").length ? `<div class="empty">Keine offenen Wünsche.</div>` : ""}
    <div class="container">
      <table>
        <tr><th>Status</th><th>Nutzer</th><th>Duty</th><th>Shift</th><th>Fahrzeug</th><th>Zeit</th><th></th></tr>
        ${wishes.map((w) => `
        <tr>
          <td><span class="badge ${w.status === "pending" ? "yellow" : w.status === "accepted" ? "green" : "red"}">${h(w.status)}</span></td>
          <td>${h(w.username)}</td>
          <td>${h(w.dutyName)}</td>
          <td>${h(w.shiftName)}</td>
          <td>${h(w.vehicleName || "–")}</td>
          <td class="muted">${fmtTime(w.createdAt)}</td>
          <td class="flex">
            ${w.status === "pending" ? `
            <button class="btn btn-green btn-sm" onclick="VBG.acceptWish('${w.id}')">Zuteilen</button>
            <button class="btn btn-danger btn-sm" onclick="VBG.denyWish('${w.id}')">Ablehnen</button>` : `
            <button class="btn btn-ghost btn-sm" onclick="VBG.deleteWish('${w.id}')">Entfernen</button>`}
          </td>
        </tr>`).join("")}
      </table>
    </div>`;
}

// ---------- Lizenzen (Kataloge) ----------

async function renderLicenses(main) {
  await loadCats();
  const stw = state.cats.stellwerke.map((s) => `
    <tr><td><b>${h(s.name)}</b></td><td class="flex"><button class="btn btn-danger btn-sm" onclick="VBG.delStw('${s.id}')">Löschen</button></td></tr>`).join("");
  const fz = state.cats.fahrzeuge.map((f) => `
    <tr><td><b>${h(f.name)}</b></td><td class="flex"><button class="btn btn-danger btn-sm" onclick="VBG.delFz('${f.id}')">Löschen</button></td></tr>`).join("");
  main.innerHTML = `
    <h1 style="margin:0 0 6px;font-size:20px">Lizenz-Kataloge</h1>
    <p class="muted" style="margin:0 0 16px">Supervisor kann beliebig viele Stellwerke (FDL) und Fahrzeuge (TF) hinzufügen.</p>
    <div class="card-grid">
      <div class="container">
        <h2>FDL – Stellwerke</h2>
        <table>${stw}</table>
        <div class="flex" style="margin-top:10px">
          <input id="stw-name" placeholder="z.B. NE" style="flex:1" />
          <button class="btn" onclick="VBG.addStw()">+ Hinzufügen</button>
        </div>
      </div>
      <div class="container">
        <h2>TF – Fahrzeuge</h2>
        <table>${fz}</table>
        <div class="flex" style="margin-top:10px">
          <input id="fz-name" placeholder="z.B. 411 (ICE-T)" style="flex:1" />
          <button class="btn" onclick="VBG.addFz()">+ Hinzufügen</button>
        </div>
      </div>
    </div>`;
}

// ---------- Benachrichtigungen ----------

function renderNotifBadge() {
  const unread = state.notifications.filter((n) => !n.read).length;
  const btn = document.getElementById("notif-btn");
  if (!btn) return;
  btn.innerHTML = BELL_SVG + (unread ? `<span class="badge">${unread}</span>` : "");
  const drop = document.getElementById("notif-drop");
  drop.innerHTML = `
    <div class="head">
      <span>Benachrichtigungen</span>
      <button class="btn btn-ghost btn-xs" onclick="VBG.readAllNotifs(event)">Alle gelesen</button>
    </div>
    ${!state.notifications.length ? `<div class="notif-empty">Keine Benachrichtigungen</div>` :
      state.notifications.slice(0, 50).map((n) => `
      <div class="notif-item ${n.read ? "" : "unread"}" onclick="VBG.readNotif('${n.id}', event)">
        <span class="tag ${n.type}">${h(n.type)}</span>
        <div>${h(n.message)}</div>
        <div class="time">${fmtTime(n.createdAt)}</div>
      </div>`).join("")}`;
}

let polling = false;
function startPolling() {
  if (polling) return;
  polling = true;
  setInterval(() => pollNotifications(), 30000);
}

async function pollNotifications(initial) {
  if (!state.user) return;
  try {
    const r = await api("GET", "/api/notifications");
    const fresh = r.notifications.filter((n) => n.createdAt > state.lastSeen);
    state.lastSeen = r.notifications.length ? r.notifications[0].createdAt : state.lastSeen;
    localStorage.setItem("vbg_notif_seen", state.lastSeen);
    if (!initial && fresh.length && document.hasFocus()) {
      fresh.slice(0, 5).forEach((n) => showDesktop(n)); 
    }
    state.notifications = r.notifications;
    if (state.view) {
      const btn = document.getElementById("notif-btn");
      if (btn) renderNotifBadge();
    }
  } catch (e) { /* offline usw. */ }
}

function showDesktop(n) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification("VBG Website", { body: n.message, tag: n.id });
  } catch (e) { /* ignore */ }
}

function requestNotifPermissionIfPossible() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission();
  }
}
function requestNotifPermission(force) {
  if (!("Notification" in window)) return toast("Desktop-Benachrichtigungen werden nicht unterstützt", "err");
  Notification.requestPermission().then((perm) => {
    toast(perm === "granted" ? "Desktop-Benachrichtigungen aktiviert" : "Keine Berechtigung", perm === "granted" ? "ok" : "err");
  });
}

// ---------- Aktionen (VBG-Public-API) ----------

const VBG = {
  setView,
  openShift: (id) => { state.currentShiftId = id; setView("shiftDetail"); },
  openVehicleDuties,

  // Shifts
  showShiftForm, cancelShiftForm, editShift,
  async createShift() {
    try {
      await api("POST", "/api/shifts", {
        name: v("sf-name"), date: v("sf-date"), notes: v("sf-notes"),
      });
      toast("Shift angelegt", "ok");
    } catch (e) { toast(e.message, "err"); }
    await loadShifts(); await renderView();
  },
  async updateShift(id) {
    try {
      await api("PATCH", "/api/shifts/" + id, { name: v("sf-name"), date: v("sf-date"), notes: v("sf-notes") });
      toast("Shift gespeichert", "ok");
    } catch (e) { toast(e.message, "err"); }
    await loadShifts(); await renderView();
  },
  async deleteShift(id) {
    if (!confirm("Shift wirklich löschen? Alle Dutys dieser Shift werden entfernt.")) return;
    try { await api("DELETE", "/api/shifts/" + id); toast("Shift gelöscht", "ok"); } catch (e) { toast(e.message, "err"); }
    await loadShifts(); await renderView();
  },

  // Dutys
  showDutyForm, hideDutyForm,
  async createDuty(shiftId) {
    try {
      await api("POST", "/api/shifts/" + shiftId + "/duties", {
        name: v("df-name"), vehicleId: v("df-vehicle") || null, notes: v("df-notes"),
        unit: v("df-unit"), startTime: v("df-start"), endTime: v("df-end"),
      });
      toast("Duty angelegt", "ok");
    } catch (e) { toast(e.message, "err"); }
    await renderView();
  },
  async deleteDuty(id) {
    if (!confirm("Duty wirklich löschen?")) return;
    try { await api("DELETE", "/api/duties/" + id); toast("Duty gelöscht", "ok"); } catch (e) { toast(e.message, "err"); }
    await renderView();
  },

  // Fahrten
  async addTrip(dutyId) {
    try {
      await api("POST", `/api/duties/${dutyId}/trips`, {
        from: v(`t-${dutyId}-from`), to: v(`t-${dutyId}-to`), dep: v(`t-${dutyId}-dep`), arr: v(`t-${dutyId}-arr`),
      });
      toast("Fahrt hinzugefügt", "ok");
    } catch (e) { toast(e.message, "err"); }
    await renderView();
  },
  toggleTripEdit(dutyId, tripId) {
    state.editTrip = state.editTrip || {};
    state.editStop = state.editStop || {};
    state.editTrip[dutyId] = state.editTrip[dutyId] === tripId ? null : tripId;
    if (state.editTrip[dutyId]) delete state.editStop[tripId];
    renderView();
  },
  async saveTrip(dutyId, tripId) {
    try {
      await api("PATCH", `/api/duties/${dutyId}/trips/${tripId}`, {
        from: v(`te-${tripId}-from`), to: v(`te-${tripId}-to`),
        dep: v(`te-${tripId}-dep`), arr: v(`te-${tripId}-arr`),
        vehicleId: v(`te-${tripId}-vehicle`) || null,
        cancelled: chk(`te-${tripId}-cancel`),
        cancelNote: v(`te-${tripId}-note`),
      });
      state.editTrip = state.editTrip || {};
      delete state.editTrip[dutyId];
      toast("Fahrt gespeichert", "ok");
    } catch (e) { toast(e.message, "err"); }
    await renderView();
  },
  async deleteTrip(dutyId, tripId) {
    if (!confirm("Fahrt löschen?")) return;
    try { await api("DELETE", `/api/duties/${dutyId}/trips/${tripId}`); toast("Fahrt gelöscht", "ok"); } catch (e) { toast(e.message, "err"); }
    await renderView();
  },

  // Halte
  async addStop(dutyId, tripId) {
    try {
      await api("POST", `/api/duties/${dutyId}/trips/${tripId}/stops`, {
        station: v(`ns-${tripId}-st`), arr: v(`ns-${tripId}-arr`), dep: v(`ns-${tripId}-dep`),
      });
      toast("Halt hinzugefügt", "ok");
    } catch (e) { toast(e.message, "err"); }
    await renderView();
  },
  toggleStopEdit(dutyId, tripId, stopId) {
    state.editStop = state.editStop || {};
    state.editTrip = state.editTrip || {};
    state.editStop[tripId] = state.editStop[tripId] === stopId ? null : stopId;
    if (state.editStop[tripId] === null) delete state.editStop[tripId];
    if (state.editStop[tripId]) delete state.editTrip[dutyId];
    renderView();
  },
  async saveStop(dutyId, tripId, stopId) {
    try {
      await api("PATCH", `/api/duties/${dutyId}/trips/${tripId}/stops/${stopId}`, {
        station: v(`se-${stopId}-st`), arr: v(`se-${stopId}-arr`), dep: v(`se-${stopId}-dep`),
        cancelled: chk(`se-${stopId}-cancel`),
      });
      state.editStop = state.editStop || {};
      delete state.editStop[tripId];
      toast("Halt gespeichert", "ok");
    } catch (e) { toast(e.message, "err"); }
    await renderView();
  },
  async deleteStop(dutyId, tripId, stopId) {
    if (!confirm("Halt löschen?")) return;
    try { await api("DELETE", `/api/duties/${dutyId}/trips/${tripId}/stops/${stopId}`); toast("Halt gelöscht", "ok"); } catch (e) { toast(e.message, "err"); }
    await renderView();
  },

  // Zuteilung
  async unassignDuty(id) {
    try { await api("PATCH", "/api/duties/" + id, { assignedUserId: null }); toast("Zuteilung gelöst", "ok"); } catch (e) { toast(e.message, "err"); }
    await renderView();
  },
  async wishDuty(id) {
    try { await api("POST", "/api/duties/" + id + "/wish"); toast("Duty-Wunsch gesendet – Supervisor benachrichtigt", "ok"); } catch (e) { toast(e.message, "err"); }
    await renderView();
  },

  async acceptWish(id) {
    try { await api("POST", "/api/wishes/" + id + "/accept"); toast("Zugewiesen", "ok"); } catch (e) { toast(e.message, "err"); }
    await renderView();
  },
  async denyWish(id) {
    try { await api("POST", "/api/wishes/" + id + "/deny"); toast("Abgelehnt", "ok"); } catch (e) { toast(e.message, "err"); }
    await renderView();
  },
  async deleteWish(id) {
    try { await api("DELETE", "/api/wishes/" + id); } catch (e) { toast(e.message, "err"); }
    await renderView();
  },

  // Nutzer
  showUserForm, hideUserForm,
  async createUser() {
    const fdl = checkedVals("fdl"), tf = checkedVals("tf");
    try {
      await api("POST", "/api/users", { username: v("uf-user"), password: v("uf-pass"), fdl, tf });
      toast("Nutzer angelegt", "ok");
    } catch (e) { toast(e.message, "err"); }
    await loadUsers(); await renderView();
  },
  showLicForm, showPwForm,
  async saveLicenses(id) {
    try {
      await api("PATCH", "/api/users/" + id, { fdl: checkedVals("fdl"), tf: checkedVals("tf") });
      toast("Lizenzen gespeichert", "ok");
    } catch (e) { toast(e.message, "err"); }
    await loadUsers(); await renderView();
  },
  async savePassword(id) {
    try { await api("PATCH", "/api/users/" + id, { password: v("pw-pass") }); toast("Passwort gesetzt", "ok"); } catch (e) { toast(e.message, "err"); }
  },
  async toggleSuspend(id) {
    try { await api("POST", "/api/users/" + id + "/suspend"); await loadUsers(); await renderView(); } catch (e) { toast(e.message, "err"); }
  },
  async deleteUser(id) {
    if (!confirm("Nutzer wirklich löschen?") || !confirm("Wirklich? Nicht rückgängig machbar.")) return;
    try { await api("DELETE", "/api/users/" + id); toast("Nutzer gelöscht", "ok"); } catch (e) { toast(e.message, "err"); }
    await loadUsers(); await renderView();
  },

  // Kataloge
  async addStw() {
    try { await api("POST", "/api/stellwerke", { name: v("stw-name") }); toast("Stellwerk hinzugefügt", "ok"); } catch (e) { toast(e.message, "err"); }
    await loadCats(); await renderView();
  },
  async delStw(id) {
    if (!confirm("Stellwerk löschen?")) return;
    try { await api("DELETE", "/api/stellwerke/" + id); toast("Gelöscht", "ok"); } catch (e) { toast(e.message, "err"); }
    await loadCats(); await renderView();
  },
  async addFz() {
    try { await api("POST", "/api/fahrzeuge", { name: v("fz-name") }); toast("Fahrzeug hinzugefügt", "ok"); } catch (e) { toast(e.message, "err"); }
    await loadCats(); await renderView();
  },
  async delFz(id) {
    if (!confirm("Fahrzeug löschen?")) return;
    try { await api("DELETE", "/api/fahrzeuge/" + id); toast("Gelöscht", "ok"); } catch (e) { toast(e.message, "err"); }
    await loadCats(); await renderView();
  },

  // Notifications
  async readNotif(id, ev) {
    if (ev) ev.stopPropagation();
    try { await api("POST", "/api/notifications/" + id + "/read"); } catch (e) { /* ignore */ }
    state.notifications.find((n) => n.id === id).read = true;
    renderNotifBadge();
  },
  async readAllNotifs(ev) {
    if (ev) ev.stopPropagation();
    try { await api("POST", "/api/notifications/read-all"); } catch (e) { /* ignore */ }
    state.notifications.forEach((n) => (n.read = true));
    renderNotifBadge();
  },
};

function v(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : "";
}
function chk(id) {
  const el = document.getElementById(id);
  return el ? el.checked : false;
}
function checkedVals(name) {
  return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map((x) => x.value);
}

// ---------- Boot ----------

async function doLogout() {
  try { await api("POST", "/api/auth/logout"); } catch (e) { /* ignore */ }
  Auth.clear();
  state.user = null;
  state.notifications = [];
  polling = false;
  render();
}

async function boot() {
  const token = Auth.getToken();
  if (token) {
    try {
      const r = await api("GET", "/api/auth/me");
      state.user = r.user;
      await loadCats();
      if (state.user.role === "supervisor") await Promise.all([loadUsers(), loadShifts()]);
      else await loadShifts();
      await pollNotifications(true);
      render();
      startPolling();
    } catch (e) {
      state.user = null;
      render();
    }
  } else {
    render();
  }
}

window.VBG = VBG;
boot();

window.addEventListener("vbg:logout", () => {
  state.user = null;
  render();
});