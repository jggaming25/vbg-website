"use strict";

// ============================================================
// VBG Website – Frontend (Modell: Linien-Lizenzen, Strafstunden,
// Anmeldungen von-bis, Shiftplan, Kundenservice, Activity,
// Account, Gerätesperre, Supervisor-Nachrichten)
// ============================================================

// ---------- Gerätesperre (nur PC/Laptop/Tablet/Surface) ----------
(function deviceLock() {
  const UA = navigator.userAgent;
  const konsole = /xbox|playstation|nintendo\s?(switch)?|gamecube/i.test(UA);
  const handy = /iPhone|iPod|Android.*Mobile|Windows Phone|Opera Mini|BlackBerry|IEMobile|Openwave/i.test(UA);
  if (konsole || handy) {
    document.addEventListener("DOMContentLoaded", function () {
      document.body.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#10151c;color:#e8eef4;padding:30px;text-align:center">
          <div style="max-width:480px">
            <div style="font-size:52px">🚫</div>
            <h2 style="margin:10px 0 8px">Dieses Gerät wird nicht unterstützt</h2>
            <p style="color:#93a3b4;line-height:1.6">Die VBG-Website läuft nur auf Windows- und Linux-PCs,
            Apple- und Windows-Surfaces sowie Laptops – nicht auf Handys oder Spielkonsolen.</p>
          </div>
        </div>`;
    });
  }
})();

(function () {
  "use strict";

  // ---------- Mini-Übersetzung (Standard: Deutsch) ----------
  const I18N = {
    nav_uebersicht: ["Übersicht", "Overview"],
    nav_shifts: ["Shifts", "Shifts"],
    nav_shiftplan: ["Shiftplan", "Duty plan"],
    nav_anmeldung: ["Anmeldung", "Sign up"],
    nav_activity: ["Activity", "Activity"],
    nav_supervisor: ["Supervisor", "Supervisor"],
    nav_account: ["Account", "Account"],
  };
  function t(key) {
    const pair = I18N[key];
    if (!pair) return key;
    const lang = (state.user && state.user.language) || "de";
    return lang === "en" ? pair[1] : pair[0];
  }

  // ---------- Helfer ----------
  function h(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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

  function timeToMin(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim());
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
  }
  function durMin(von, bis) {
    const a = timeToMin(von), b = timeToMin(bis);
    return (b <= a ? b + 1440 : b) - a;
  }
  function pauseMin(arr, dep) {
    const a = timeToMin(arr), b = timeToMin(dep);
    return Math.max(0, (b <= a ? b + 1440 : b) - a);
  }
  function fmtMin(m) {
    m = Math.max(0, Math.round(m));
    const hh = Math.floor(m / 60), mm = m % 60;
    return hh > 0 ? hh + " h " + (mm ? mm + " min" : "") : mm + " min";
  }

  // ---------- Konstanten ----------
  const ROLE_LABELS = { supervisor: "Supervisor", senior: "Senior Busfahrer", user: "Busfahrer" };
  const VEHICLE_STATUS = {
    einsatzbereit: { label: "Einsatzbereit", cls: "green" },
    nicht_einsatzbereit: { label: "Nicht einsatzbereit", cls: "red" },
    sonderfahrzeug: { label: "Sonderfahrzeug", cls: "yellow" },
    ersatzwagen: { label: "Ersatzwagen", cls: "sky" },
    fahrschule: { label: "Fahrschule", cls: "violet" },
    reserve: { label: "Reserve", cls: "gray" },
  };

  // ---------- State ----------
  const state = {
    user: null,
    view: "dashboard",
    superTab: "users",
    cats: { linien: [], fahrzeuge: [] },
    users: [],
    shifts: [],
    myApps: [],
    notifications: [],
    notifOpen: false,
    // Shiftplan
    planShiftId: null,
    plan: null, // { shift, duties, supervisoren }
    planExpandedStops: {},
    expandedDuties: {},
    // Anmeldung
    anmeldungShiftId: "",
    anmeldungArt: "bus",
    // Activity
    actMe: null,
    actAll: null,
    // Supervisor
    appsAll: [],
    wishesAll: [],
    profile: null,
    latestAnnounce: null,
    // Filter
    appFilter: { nutzer: "", shift: "" },
    activityRange: "monat",
    nichtDienlich: "vehicles", // unused Platzhalter
  };

  function isSup() { return state.user && state.user.role === "supervisor"; }
  function isDriver() { return state.user && (state.user.role === "user" || state.user.role === "senior"); }
  function isTemplateShift(s) {
    return s && (s.id === "tpl-tagesplan" || /staff\s*shift/i.test(s.name || ""));
  }
  function realShifts() { return state.shifts.filter((s) => !isTemplateShift(s)); }

  // ---------- Daten laden ----------
  async function loadCats() {
    try {
      const [l, f] = await Promise.all([api("GET", "/api/linien"), api("GET", "/api/fahrzeuge")]);
      state.cats = { linien: l.items || [], fahrzeuge: f.items || [] };
    } catch (e) { /* ignoriert */ }
  }
  async function loadUsers() {
    try { const r = await api("GET", "/api/users"); state.users = r.users || []; } catch (e) {}
  }
  async function loadShifts() {
    try { const r = await api("GET", "/api/shifts"); state.shifts = r.shifts || []; } catch (e) {}
  }
  async function loadMyApps() {
    try { const r = await api("GET", "/api/my/applications"); state.myApps = r.applications || []; } catch (e) {}
  }
  async function loadNotifs() {
    try {
      const r = await api("GET", "/api/notifications?onlyUnread=1");
      state.notifications = r.notifications || [];
      renderTopbarBadge();
    } catch (e) {}
  }
  async function loadPlan() {
    if (!state.planShiftId) { state.plan = null; return; }
    try {
      const r = await api("GET", "/api/shifts/" + state.planShiftId + "/duties");
      state.plan = r;
    } catch (e) { state.plan = null; }
  }

  function refreshAll() {
    return Promise.all([loadCats(), loadShifts(), loadMyApps()]);
  }

  // ---------- Anzeige-Helfer ----------
  function linieName(l) { return l ? l.name || l.beschreibung || "–" : "–"; }
  function linieNameId(id) {
    const l = state.cats.linien.find((x) => x.id === id);
    return linieName(l);
  }
  function linieClsId(id) {
    const name = linieNameId(id);
    const map = { "19": "sky", "(SB) 24": "green", "24": "green", "8": "yellow", "N1": "violet" };
    return map[name] || "gray";
  }
  function fzName(id) {
    const f = state.cats.fahrzeuge.find((x) => x.id === id);
    return f ? (f.wagennummer || f.kennzeichen || f.typ || "–") : id ? "Fzg " + id.slice(0, 6) : "–";
  }
  function userName(id) {
    const u = state.users.find((x) => x.id === id);
    return u ? u.username : id ? "?" : "–";
  }
  function roleBadge(role) {
    const cls = role === "supervisor" ? "violet" : role === "senior" ? "sky" : "gray";
    return `<span class="badge ${cls}">${h(ROLE_LABELS[role] || role)}</span>`;
  }
  function licBadges(ids) {
    return (ids || []).map((id) => {
      const l = state.cats.linien.find((x) => x.id === id);
      return `<span class="badge ${linieClsId(id)}">${h(linieName(l))}</span>`;
    }).join(" ") || '<span class="muted">–</span>';
  }

  // ---------- Haupt-Render ----------
  function render() {
    const app = document.getElementById("app");
    if (!state.user) { app.innerHTML = renderLogin(); return; }
    app.innerHTML = `
      ${renderTopbar()}
      <div id="announce-banner"></div>
      <main>${renderView()}</main>`;
    renderTopbarBadge();
  }

  function renderLogin() {
    return `
    <div class="login-wrap">
      <div class="login-card">
        <h1>VBG <span style="color:var(--accent)">Organisation</span></h1>
        <p class="sub">Fahrplan-Org &amp; Einsatzplanung</p>
        <div>
          <label>Benutzername</label>
          <input id="login-user" type="text" autocomplete="username" onkeydown="if(event.key==='Enter')VBG.doLogin()"/>
          <label>Passwort</label>
          <input id="login-pw" type="password" autocomplete="current-password" onkeydown="if(event.key==='Enter')VBG.doLogin()"/>
          <div class="row"><input id="login-remember" type="checkbox"/><label style="margin:0">Angemeldet bleiben</label></div>
          <button class="btn" onclick="VBG.doLogin()">Anmelden</button>
          <div id="login-error" class="login-error"></div>
        </div>
      </div>
    </div>`;
  }

  function renderTopbar() {
    const u = state.user || {};
    const tabs = [
      { id: "dashboard", label: t("nav_uebersicht") },
      { id: "shifts", label: t("nav_shifts") },
      { id: "shiftplan", label: t("nav_shiftplan") },
      { id: "anmeldung", label: t("nav_anmeldung") },
      { id: "activity", label: t("nav_activity") },
    ];
    if (isSup()) tabs.push({ id: "supervisor", label: t("nav_supervisor") });
    const links = tabs
      .map((tb) => `<a class="${state.view === tb.id ? "active" : ""}" onclick="VBG.setView('${tb.id}')">${h(tb.label)}</a>`)
      .join("");

    return `
    <header class="topbar">
      <div class="brand">VBG <span class="sg">•</span> Orga</div>
      <nav>${links}</nav>
      <div class="right">
        ${isSup() ? `
          <div class="notif-wrap">
            <button class="notif-btn" title="Nachricht senden" onclick="VBG.openAnnounce()">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14L4 6l4-2 3 4 4-4 3 2-2 8H6z"/><path d="M4 6l6 8"/></svg>
            </button>
          </div>` : ""}
        <div class="notif-wrap">
          <button class="notif-btn" onclick="VBG.toggleNotif(event)">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
            <span id="notif-badge" class="badge" style="display:none;position:absolute;top:-5px;right:-5px;background:var(--red);color:#fff;min-width:18px;height:18px;border-radius:9px;padding:0 4px;font-size:11px;align-items:center;justify-content:center"></span>
          </button>
          <div id="notif-drop" class="notif-drop"></div>
        </div>
        <div class="userbox">
          <button class="userbox-btn" onclick="VBG.setView('account')">
            <span class="avatar">${h(avatarLetter(u))}</span>
            <span class="name">${h(u.username || "")}</span>
          </button>
        </div>
      </div>
    </header>`;
  }

  function avatarLetter(u) {
    if (u && u.avatar) return u.avatar.slice(0, 1).toUpperCase();
    return ((u && u.username) || "?").slice(0, 1).toUpperCase();
  }

  function renderTopbarBadge() {
    const el = document.getElementById("notif-badge");
    if (!el) return;
    const unread = (state.notifications || []).filter((n) => !n.read).length;
    if (unread > 0) { el.style.display = "flex"; el.textContent = unread > 99 ? "99+" : unread; }
    else el.style.display = "none";
  }

  // ---------- View-Dispatch ----------
  function renderView() {
    switch (state.view) {
      case "dashboard": return renderDashboard();
      case "shifts": return renderShifts();
      case "shiftplan": return renderShiftplanView();
      case "anmeldung": return renderAnmeldung();
      case "activity": return renderActivity();
      case "supervisor": return renderSupervisor();
      case "account": return renderAccount();
      default: return renderDashboard();
    }
  }

  // ---------- Übersicht ----------
  function renderDashboard() {
    const aktive = state.users.filter((u) => !u.suspended).length;
    const fzGesamt = state.cats.fahrzeuge.length;
    const fzEinsatz = state.cats.fahrzeuge.filter((f) => f.status === "einsatzbereit").length;
    const shiftsReal = realShifts();
    const kuendigung = state.users.filter((u) => u.kündigung && !u.suspended);
    const offeneApps = [];

    return `
      <h2>Übersicht</h2>
      <div class="card-grid">
        <div class="stat"><div class="num">${shiftsReal.length}</div><div class="lbl">Shifts</div></div>
        <div class="stat"><div class="num">${aktive}</div><div class="lbl">Aktive Nutzer</div></div>
        <div class="stat"><div class="num">${fzGesamt}</div><div class="lbl">Fahrzeuge</div>
          <div class="lbl">${fzEinsatz} einsatzbereit</div></div>
        ${isSup() ? `<div class="stat"><div class="num">${offeneApps.length ? "–" : "–"}</div><div class="lbl">Anmeldungen</div></div>` : ""}
      </div>

      ${isSup() && kuendigung.length ? `
        <div class="container" style="border-color:var(--red)">
          <h2>Kündigung droht</h2>
          ${kuendigung.map((u) => `
            <div class="flex">
              <span>${h(u.username)}</span>
              <span class="badge red">${u.strafstunden} Strafstunden</span>
              <button class="btn btn-sm" onclick="VBG.setView('supervisor')">Nutzer-Tab öffnen</button>
            </div>`).join("")}
        </div>` : ""}

      <div class="container" style="margin-top:18px">
        <h2>Schnellzugriff</h2>
        <div class="flex">
          <button class="btn" onclick="VBG.setView('shiftplan')">Zum Shiftplan</button>
          <button class="btn btn-ghost" onclick="VBG.setView('anmeldung')">Anmeldung</button>
          <button class="btn btn-ghost" onclick="VBG.setView('activity')">Activity</button>
          ${isSup() ? `<button class="btn btn-ghost" onclick="VBG.setView('supervisor')">Supervisor-Bereich</button>` : ""}
          <button class="btn btn-ghost" onclick="VBG.setView('account')">Account</button>
        </div>
      </div>`;
  }

  // ---------- Shifts ----------
  function renderShifts() {
    const shiftsReal = realShifts();
    const tpl = state.shifts.find((s) => s.id === "tpl-tagesplan");

    return `
      <div class="spread"><h2>Shifts</h2>
        ${isSup() ? `<button class="btn" onclick="VBG.showShiftForm()">+ Neue Shift</button>` : ""}
      </div>

      ${isSup() && tpl ? `
        <div class="container" style="border-color:var(--accent)">
          <b>Tagesplan</b>
          <div class="muted" style="margin:4px 0 10px">${h(tpl.notes || "Wiederverwendbarer Tagesplan")} – ${tpl.dutyCount || 0} Dutys</div>
          <button class="btn btn-yellow" onclick="VBG.newShiftFromTpl()">Als neue Shift übernehmen (Dutys werden automatisch geladen)</button>
        </div>` : ""}

      ${shiftsReal.length === 0 ? `<div class="empty">Noch keine Shifts vorhanden.</div>` : ""}
      ${shiftsReal.map((s) => `
        <div class="duty-card">
          <div class="duty-head">
            <div>
              <div class="duty-title">${h(s.name)}</div>
              <div class="duty-meta">
                ${s.date ? h(s.date) + " · " : ""}${s.startTime ? h(s.startTime) + "–" + h(s.endTime) : "Zeiten offen"}
                · ${s.dutyCount || 0} Dutys
                ${s.hostName ? ` · Host: <b>${h(s.hostName)}</b>` : ""}
                ${(s.coSupervisorNames || []).length ? ` · Co-Supervisor: ${s.coSupervisorNames.map((n) => h(n)).join(", ")}` : ""}
              </div>
            </div>
            <div class="flex">
              <button class="btn btn-sm" onclick="VBG.openPlan('${s.id}')">Shiftplan öffnen</button>
              ${isSup() ? `
                <button class="btn btn-ghost btn-sm" onclick="VBG.editShift('${s.id}')">Bearbeiten</button>
                <button class="btn btn-danger btn-sm" onclick="VBG.deleteShift('${s.id}')">Löschen</button>` : ""}
            </div>
          </div>
        </div>`).join("")}

      <div id="shift-form"></div>`;
  }

  function shiftFormHtml(s) {
    const supers = state.users.filter((u) => u.role === "supervisor");
    const sId = s ? s.id : "";
    return `
      <div class="container">
        <h2>${s ? "Shift bearbeiten" : "Neue Shift"}</h2>
        <div class="form-grid">
          <label>Name
            <input id="sf-name" value="${h(s ? s.name : "")}" placeholder="z. B. Tagesbetrieb 26.09."/></label>
          <label>Datum
            <input id="sf-date" type="date" value="${h(s ? s.date || "" : "")}"/></label>
          <label>Startzeit
            <input id="sf-start" type="time" value="${h(s ? s.startTime || "" : "")}"/></label>
          <label>Endzeit
            <input id="sf-end" type="time" value="${h(s ? s.endTime || "" : "")}"/></label>
        </div>

        <label style="display:block;margin-top:12px">Notizen<textarea id="sf-notes" rows="4" placeholder="z. B. besondere Umläufe, Linienwechsel, Bemerkungen…" style="width:100%;margin-top:6px;resize:vertical">${h(s ? s.notes || "" : "")}</textarea></label>

        <fieldset><legend>Host (Haupt-Supervisor)</legend>
          <select id="sf-host">${supers.map((u) => `<option value="${u.id}" ${(s && s.hostId === u.id) || (!s && u.id === state.user.id) ? "selected" : ""}>${h(u.username)}</option>`).join("")}</select>
        </fieldset>

        <fieldset><legend>Bis zu 2 weitere Supervisoren (Co-Supervisor)</legend>
          <div>
            ${supers.map((u) => {
              const checked = s ? (s.coSupervisorIds || []).includes(u.id) : false;
              return `<label class="checkline"><input type="checkbox" data-co="${u.id}" ${checked ? "checked" : ""}/> ${h(u.username)}</label>`;
            }).join("")}
          </div>
        </fieldset>

        ${!s ? `<label class="checkline"><input id="sf-tpl" type="checkbox" checked/> Dutys automatisch aus dem Tagesplan laden</label>` : ""}

        <div class="flex" style="margin-top:10px">
          <button class="btn btn-green" onclick="VBG.saveShift('${sId}')">Speichern</button>
          <button class="btn btn-ghost" onclick="VBG.hideShiftForm()">Abbrechen</button>
        </div>
      </div>`;
  }

  function renderShiftFormInline(s) {
    document.getElementById("shift-form").innerHTML = shiftFormHtml(s);
  }

  // ---------- Shiftplan ----------
  function renderShiftplanView() {
    const shiftsReal = realShifts();
    const selector = `
      <div class="spread">
        <h2>Shiftplan</h2>
        <select style="min-width:260px" onchange="VBG.selectPlanShift(this.value)">
          <option value="">— Shift wählen —</option>
          ${shiftsReal.map((s) => `<option value="${s.id}" ${s.id === state.planShiftId ? "selected" : ""}>${h(s.name)} ${s.date ? "(" + h(s.date) + ")" : ""}</option>`).join("")}
        </select>
      </div>`;

    if (!state.planShiftId) {
      return selector + `<div class="container"><div class="empty">Wähle eine Shift, um den Shiftplan zu sehen.</div></div>`;
    }

    if (!state.plan) {
      loadPlan().then(() => render());
      return selector + `<div class="spinner">Lade Shiftplan…</div>`;
    }

    const plan = state.plan;
    const shift = plan.shift;
    const duties = plan.duties || [];

    const kunden = KUNDENSERVICE_STATE.items || [];

    let html = selector;

    // Host / Co-Supervisoren (für alle sichtbar)
    html += `
      <div class="container">
        <div class="spread">
          <div><b>${h(shift.name)}</b>
            ${shift.date ? `<span class="muted"> · ${h(shift.date)}</span>` : ""}
            ${shift.startTime ? `<span class="muted"> · ${h(shift.startTime)}–${h(shift.endTime)}</span>` : ""}
          </div>
          <div class="muted">
            Host: <b>${h(shift.hostName || "–")}</b>
            ${(shift.coSupervisorNames || []).length ? ` · Co: ${shift.coSupervisorNames.map((n) => h(n)).join(", ")}` : ""}
          </div>
        </div>
      </div>`;

    // ---- Kundenservice-Block ----
    html += `
      <div class="container">
        <div class="spread"><h2 style="margin:0">Kundenservice</h2>
          ${isSup() ? `<button class="btn btn-sm" onclick="VBG.addStandort()">+ Standort</button>` : ""}
        </div>
        <p class="muted" style="margin:6px 0 12px">Anmeldung jederzeit möglich – mindestens 30 Minuten am Stück.
        Pro Person und Shift gilt nur EINE Funktion (Kundenservice <b>oder</b> Busfahren).</p>
        ${kunden.length === 0 ? `<div class="empty">Keine Standorte vorhanden.</div>` : `
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px">
          ${kunden.map((k) => `
            <div class="duty-card" style="margin:0">
              <div class="duty-head">
                <b>${h(k.name)}</b>
                ${isSup() ? `<span>
                  <button class="btn btn-ghost btn-xs" onclick="VBG.renameStandort('${k.id}')">Umbenennen</button>
                  <button class="btn btn-danger btn-xs" onclick="VBG.delStandort('${k.id}')">×</button>
                </span>` : ""}
              </div>
              <div style="margin-top:8px">
                <button class="btn btn-sm" onclick="VBG.kundenserviceSignup('${k.id}')">Dafür anmelden</button>
              </div>
            </div>`).join("")}
          </div>`}
        <div id="standort-form"></div>
      </div>`;

    // ---- Dutys ----
    if (duties.length === 0) {
      html += `<div class="container"><div class="empty">Diese Shift hat noch keine Dutys.</div>
        ${isSup() ? `<div style="text-align:center"><button class="btn btn-yellow" onclick="VBG.reloadFromTpl()">Aus Tagesplan nachladen</button></div>` : ""}</div>`;
    } else {
      duties.forEach((d) => { html += renderDutyCard(d); });
    }

    return html;
  }

  function renderDutyCard(d) {
    const isSup_ = isSup();
    const trips = (d.trips || []).filter((x) => !x.cancelled);
    const cancelledTrips = (d.trips || []).filter((x) => x.cancelled);
    const allTrips = d.trips || [];
    const assoz = isSup_
      ? `<span><button class="btn btn-ghost btn-xs" onclick="VBG.toggleDutyStops('${d.id}')">Haltestellen</button></span>`
      : "";
    const linieHinweis = d.linieName ? `<span class="badge ${linieClsId(d.linieId)}">${h(d.linieName)}</span>` : "";

    let rows = "";
    allTrips.forEach((tr, i) => {
      const isLast = i === allTrips.length - 1;
      const next = isLast ? null : allTrips[i + 1];
      rows += renderTripRow(d, tr, i);

      // Pause zwischen den Fahrten
      if (next && !tr.cancelled && !next.cancelled) {
        const p = pauseMin(tr.arr, next.dep);
        rows += `
          <tr class="pause-row" ${isSup_ ? `onclick="VBG.toggleDutyStops('${d.id}')" style="cursor:pointer"` : ""}>
            <td colspan="7" style="padding:3px 10px">
              <span class="pause-label" ${p <= 10 ? 'style="color:var(--red)"' : 'style="color:var(--muted)"'}>Pause · ${fmtMin(p)}</span>
              <span class="muted" style="font-size:11px">→ ${h(next.from)} (${h(next.dep)})</span>
            </td>
          </tr>`;
      }
    });

    const fahrtzeit = d.fahrSummeMin || 0;
    const spanne = d.spanneMin || 0;
    const pausen = d.pausenMin != null ? d.pausenMin : Math.max(0, spanne - fahrtzeit);

    return `
      <div class="duty-card ${d.cancelled ? "cancelled" : ""}" id="duty-${d.id}">
        <div class="duty-head">
          <div>
            <div class="duty-title">
              <span style="text-decoration:${d.cancelled ? "line-through" : "none"}">${h(d.name)}</span>
              ${d.cancelled ? `<span class="badge red">ausgefallen</span>` : ""}
              ${linieHinweis}
              ${d.kurs ? `<span class="muted">Kurs ${h(d.kurs)}</span>` : ""}
            </div>
            <div class="duty-meta">
              ${d.unit ? `Einheit ${h(d.unit)} · ` : ""}Dauer: <b>${fmtMin(spanne)}</b>
              (Fahrzeit ${fmtMin(fahrtzeit)} · Pausen ${fmtMin(pausen)})
              · benötigte Lizenz: <b>${h(d.linieName || "–")}</b>
              ${d.startTime ? ` · ${h(d.startTime)}–${h(d.endTime)}` : ""}
              ${d.assignedUsername ? ` · Fahrer: <b>${h(d.assignedUsername)}</b>` : ""}
            </div>
            ${d.bemerkung ? `<div class="duty-meta" style="color:var(--yellow)">⚠ ${h(d.bemerkung)}</div>` : ""}
          </div>
          ${isSup_ ? `<div class="flex">
              ${assoz}
              <button class="btn btn-ghost btn-xs" onclick="VBG.editDutyTimes('${d.id}')">Zeiten</button>
              ${!d.cancelled
                ? `<button class="btn btn-yellow btn-xs" onclick="VBG.toggleDutyCancel('${d.id}')">Ausfallen</button>`
                : `<button class="btn btn-green btn-xs" onclick="VBG.toggleDutyCancel('${d.id}')">Wieder aktiv</button>`}
              <button class="btn btn-danger btn-xs" onclick="VBG.deleteDuty('${d.id}')">×</button>
            </div>` : ""}
        </div>

        ${isSup_ ? `<div class="flex" style="margin-top:10px">
            <label class="muted" style="font-size:12px">Zuteilung (Duty):</label>
            <select style="max-width:190px" onchange="VBG.assignDuty('${d.id}', this.value)">
              <option value="">— ohne —</option>
              ${state.users.filter((u) => u.role !== "supervisor").map((u) => `<option value="${u.id}" ${d.assignedUserId === u.id ? "selected" : ""}>${h(u.username)}</option>`).join("")}
            </select>
            <label class="muted" style="font-size:12px">Fahrzeug:</label>
            <select style="max-width:150px" onchange="VBG.assignDutyVehicle('${d.id}', this.value)">
              <option value="">— ohne —</option>
              ${state.cats.fahrzeuge.map((f) => `<option value="${f.id}" ${d.vehicleId === f.id ? "selected" : ""}>${h(f.wagennummer || f.typ)}</option>`).join("")}
            </select>
            <label class="muted" style="font-size:12px">Bemerkung:</label>
            <input style="max-width:220px" id="duty-bem-${d.id}" value="${h(d.bemerkung || "")}" placeholder="Bemerkung zur Duty…"
              onchange="VBG.saveDutyBemerk('${d.id}')"/>
          </div>
          <div class="muted" style="font-size:11px;margin-top:4px">Ausfall einzelner Fahrten unten am jeweiligen Trip.</div>` : ""}

        <table style="margin-top:10px">
          <thead><tr>
            <th>Fahrt</th><th>Von</th><th>Nach</th><th>Ab</th><th>An</th><th>Fahrzeug</th><th>Bemerkungen</th>
            ${isSup_ ? `<th style="width:190px">Aktionen</th>` : ""}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function renderTripRow(d, tr, idx) {
    const isSup_ = isSup();
    const stopsOpen = !!state.planExpandedStops[tr.id] || !!state.expandedDuties[d.id];
    const stopsHtml = `
      <div class="stop-box">
        ${(tr.stops || []).length ? `
        <ul class="stop-list">${(tr.stops || []).map((s) => `
          <li class="${s.cancelled ? "cancelled" : ""}">
            <span>${h(s.station)}</span>
            <span class="muted">an ${h(s.arr)}</span>
            ${s.cancelled ? `<span class="badge red" style="font-size:10px">ausf.</span>` : ""}
            ${isSup_ ? `<button class="btn btn-xs btn-danger" onclick="VBG.toggleStopCancel('${d.id}','${tr.id}','${s.id}')" title="Ausfallen">✕</button>` : ""}
          </li>`).join("")}
        </ul>`
        : `<div class="muted" style="font-size:12px;padding:2px 0">Keine Haltestellen</div>`}
        ${isSup_ ? `<div class="flex"><button class="btn btn-xs" onclick="VBG.addStop('${d.id}','${tr.id}')">+ Halt</button></div>` : ""}
      </div>`;

    return `
      <tr class="${tr.cancelled ? "cancelled-row" : ""} ${tr.leerfahrt ? "leer-row" : ""}" data-trip="${tr.id}">
        <td>
          ${tr.leerfahrt ? `<span class="badge gray">Leer</span>` : `<span class="muted" style="font-size:11px">${idx + 1}.</span>`}
          ${stopsOpen ? stopsHtml : ""}
        </td>
        <td>${h(tr.from)}</td>
        <td>${h(tr.to)}</td>
        <td><b>${h(tr.dep)}</b></td>
        <td>${h(tr.arr)}</td>
        <td>
          ${isSup_ && tr.leerfahrt ? fzName(tr.vehicleId)
            : isSup_
            ? `<select style="min-width:110px" onchange="VBG.assignTripVehicle('${d.id}','${tr.id}', this.value)">
                <option value="">—</option>
                ${state.cats.fahrzeuge.map((f) => `<option value="${f.id}" ${tr.vehicleId === f.id ? "selected" : ""}>${h(f.wagennummer || f.typ)}</option>`).join("")}
              </select>`
            : fzName(tr.vehicleId)}
          </td>
        <td>${h(tr.bemerkung || "")}</td>
        ${isSup_ ? `<td>
            <div class="flex" style="gap:6px">
              <select style="min-width:120px" onchange="VBG.assignTrip('${d.id}','${tr.id}', this.value)" title="Einzelfahrt-Zuteilung">
                <option value="">Fahrer…</option>
                ${state.users.filter((u) => u.role !== "supervisor").map((u) => `<option value="${u.id}" ${tr.assignedUserId === u.id ? "selected" : ""}>${h(u.username)}</option>`).join("")}
              </select>
              ${tr.assignedUsername ? `<span class="muted" style="font-size:11px">${h(tr.assignedUsername)}</span>` : ""}
              <button class="btn btn-xs" onclick="VBG.toggleTripEdit('${d.id}','${tr.id}');VBG.toggleStops('${tr.id}')" title="Bearbeiten">✎</button>
              ${!tr.cancelled
                ? `<button class="btn btn-yellow btn-xs" onclick="VBG.toggleTripCancel('${d.id}','${tr.id}')">Ausf.</button>`
                : `<button class="btn btn-green btn-xs" onclick="VBG.toggleTripCancel('${d.id}','${tr.id}')">Aktiv</button>`}
            </div>
          </td>` : ""}
      </tr>`;
  }

  // ---------- Anmeldung ----------
  const KUNDENSERVICE_STATE = { items: [] };
  async function loadKundenservice() {
    try { const r = await api("GET", "/api/kundenservice"); KUNDENSERVICE_STATE.items = r.items || []; }
    catch (e) { KUNDENSERVICE_STATE.items = []; }
  }

  function renderAnmeldung() {
    const shiftsReal = realShifts();
    const u = state.user;
    const gesperrtBus = (u.strafstunden || 0) >= 3;

    const einzelne = (state.myApps || []).find((a) => a.status === "pending") ? "" : "";
    return `
      <h2>Anmeldung</h2>

      <div class="container">
        <div class="form-grid">
          <label>Shift<select id="an-shift" onchange="VBG.setAnmeldungShift(this.value)">
            <option value="">— wählen —</option>
            ${shiftsReal.map((s) => `<option value="${s.id}" ${s.id === state.anmeldungShiftId ? "selected" : ""}>${h(s.name)}${s.date ? " (" + h(s.date) + ")" : ""}</option>`).join("")}
          </select></label>
          <label>Art<select id="an-art" onchange="VBG.setAnmeldungArt(this.value)">
            <option value="bus" ${state.anmeldungArt !== "kundenservice" ? "selected" : ""}>Busfahren</option>
            <option value="kundenservice" ${state.anmeldungArt === "kundenservice" ? "selected" : ""}>Kundenservice</option>
          </select></label>
          ${state.anmeldungArt === "kundenservice" ? `<label>Standort<select id="an-standort">
            <option value="">— wählen —</option>
            ${KUNDENSERVICE_STATE.items.map((k) => `<option value="${k.id}">${h(k.name)}</option>`).join("")}
          </select></label>` : ""}
          <label>Von (Uhrzeit)<input id="an-von" type="time"/></label>
          <label>Bis (Uhrzeit)<input id="an-bis" type="time"/></label>
          <label style="display:block;margin-top:10px">Hinweis<textarea id="an-hinweis" rows="3" placeholder="freiwillig, z. B. nur Vormittag, kein Gelenkbus…" style="width:100%;margin-top:6px;resize:vertical"></textarea></label>
        </div>

        <div class="muted" style="margin:10px 0">
          Mindestdauer: <b>${state.anmeldungArt === "kundenservice" ? "30 Minuten" : "1 h 15 min"}</b>
          ${gesperrtBus && state.anmeldungArt === "bus" ? ` · <b style="color:var(--red)">Ab 3 Strafstunden nur noch Kundenservice möglich.</b>` : ""}
        </div>

        <button class="btn btn-green" onclick="VBG.submitAnmeldung()">Anmelden</button>
      </div>

      <div class="container">
        <h2>Meine Anmeldungen</h2>
        ${state.myApps.length === 0 ? `<div class="empty">Noch keine Anmeldungen.</div>` : `
        <table>
          <thead><tr><th>Shift</th><th>Art</th><th>Von–Bis</th><th>Hinweis</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${state.myApps.map((a) => `
              <tr>
                <td>${h(a.shiftName || "?")}</td>
                <td>${a.art === "kundenservice" ? "Kundenservice" : "Bus"}${a.standortName ? " – " + h(a.standortName) : ""}</td>
                <td>${h(a.von)}–${h(a.bis)}</td>
                <td>${h(a.hinweis || "")}</td>
                <td><span class="badge ${a.status === "accepted" ? "green" : a.status === "denied" ? "red" : "yellow"}">${a.status === "accepted" ? "angenommen" : a.status === "denied" ? "abgelehnt" : "ausstehend"}</span></td>
                <td>${a.status === "pending" ? `<button class="btn btn-danger btn-xs" onclick="VBG.withdrawApp('${a.id}')">Zurückziehen</button>` : ""}</td>
              </tr>`).join("")}
          </tbody>
        </table>`}
      </div>`;
  }

  // ---------- Activity ----------
  async function loadActivityMe() {
    try { return await api("GET", "/api/activity/me"); } catch (e) { return null; }
  }
  async function loadActivityMeMonth() {
    try { return await api("GET", "/api/activity/me?zeitraum=monat"); } catch (e) { return null; }
  }
  async function loadActivityAll() {
    try { return await api("GET", "/api/activity/all?zeitraum=" + state.activityRange); } catch (e) { return null; }
  }

  function renderActivity() {
    return activityMeView();
  }

  function activityMeView() {
    const me = state.actMe;
    const month = state.actMeMonth;
    if (!me || !month) {
      Promise.all([loadActivityMe(), loadActivityMeMonth()]).then(([r, m]) => {
        state.actMe = r; state.actMeMonth = m; render();
      });
      return `<h2>Activity</h2><div class="spinner">Lade…</div>`;
    }
    const bereit = me.fahrMin >= 60;
    const MOENTLICHES_ZIEL = 240; // mind. 4 h gefahrene Zeit pro Kalendermonat
    const monFahr = month.fahrMin || 0;
    const monOk = monFahr >= MOENTLICHES_ZIEL;
    const monRest = Math.max(0, MOENTLICHES_ZIEL - monFahr);
    return `
      <h2>Activity</h2>
      <div class="card-grid">
        <div class="stat"><div class="num">${fmtMin(me.activityMin || 0)}</div><div class="lbl">Activity-Zeit (60 % deiner Fahrzeit)</div></div>
        <div class="stat"><div class="num">${fmtMin(me.fahrMin || 0)}</div><div class="lbl">Reine Fahrzeit (ohne Pausen)</div></div>
        <div class="stat"><div class="num">${(me.signups || []).length}</div><div class="lbl">Activity-Anmeldungen</div></div>
      </div>
      <div class="container" style="border-color:${monOk ? "var(--green)" : "var(--yellow)"}">
        <b>Monatsziel: mind. ${fmtMin(MOENTLICHES_ZIEL)} gefahrene Zeit</b>
        <div class="muted" style="margin-top:4px">
          Diesen Monat: <b>${fmtMin(monFahr)}</b>
          ${monOk
            ? `<span class="badge green" style="margin-left:8px">Ziel erreicht ✓</span>`
            : `<span class="badge yellow" style="margin-left:8px">Noch ${fmtMin(monRest)} bis zum Ziel</span>`}
        </div>
      </div>
      <div class="container">
        <p class="muted">Du kannst dich für Activity anmelden, sobald du mindestens 60&nbsp;Minuten reine Fahrzeit
        (ohne Pausen) erreicht hast – darauf bekommst du 60&nbsp;% als Activity-Zeit angerechnet.</p>
        <button class="btn btn-yellow" ${bereit ? "" : "disabled"} onclick="VBG.signupActivity()">
          ${bereit ? "Für Activity anmelden" : "Noch nicht verfügbar (braucht 60 min Fahrzeit)"}
        </button>
      </div>`;
  }

  function activityAllView() {
    const rows = state.actAll;
    if (!rows) {
      loadActivityAll().then((r) => { state.actAll = r; render(); });
      return `<h2>Activity – alle Nutzer</h2><div class="spinner">Lade…</div>`;
    }
    const MOENTLICHES_ZIEL = 240; // mind. 4 h gefahrene Zeit pro Kalendermonat
    const mono = state.activityRange === "monat";
    const gefaehrdet = mono ? rows.rows.filter((r) => r.role !== "supervisor" && (r.fahrMin || 0) < MOENTLICHES_ZIEL) : [];
    const gefaehrdetHtml = mono ? `
      <div class="container" style="border-color:${gefaehrdet.length ? "var(--red)" : "var(--green)"}">
        <h2 style="margin:0">Monatsziel (mind. ${fmtMin(MOENTLICHES_ZIEL)} gefahrene Zeit)</h2>
        ${gefaehrdet.length === 0
          ? `<p class="muted" style="margin:8px 0 0">Alle Busfahrer erreichen das Monatsziel. Keiner gefährdet. ✓</p>`
          : `<div style="margin-top:8px">${gefaehrdet.map((r, i) => `
              <div class="flex" style="padding:6px 0;border-top:1px solid var(--border)">
                <span><b>${h(r.username)}</b> <span class="muted">(${h(r.roleLabel || "")})</span></span>
                <span class="badge red">Gefährdet</span>
                <span class="muted">${fmtMin(r.fahrMin || 0)} gefahren – noch ${fmtMin(MOENTLICHES_ZIEL - (r.fahrMin || 0))} bis Monatsziel</span>
              </div>`).join("")}
            <p class="muted" style="margin:10px 0 0">Bewertung pro Kalendermonat; unterhalb von ${fmtMin(MOENTLICHES_ZIEL)} gilt eine Person als gefährdet.</p>
          </div>`}
      </div>` : "";
    return `
      <h2>Activity – alle Nutzer</h2>
      <div class="flex" style="margin-bottom:14px">
        <label class="muted">Zeitraum:
          <select onchange="VBG.setActivityRange(this.value)">
            <option value="woche" ${state.activityRange === "woche" ? "selected" : ""}>Woche</option>
            <option value="monat" ${state.activityRange === "monat" ? "selected" : ""}>Monat</option>
            <option value="jahr" ${state.activityRange === "jahr" ? "selected" : ""}>Jahr</option>
            <option value="alle" ${state.activityRange === "alle" ? "selected" : ""}>Alle</option>
          </select>
        </label>
      </div>
      ${gefaehrdetHtml}
      <div class="container">
        <table>
          <thead><tr><th>Nutzer</th><th>Rolle</th><th>Reine Fahrzeit</th><th>Activity (60 %)</th><th>Anmeldungen</th></tr></thead>
          <tbody>
            ${rows.rows.map((r) => `
              <tr>
                <td>${h(r.username)}</td>
                <td>${h(r.roleLabel || "")}</td>
                <td>${fmtMin(r.fahrMin || 0)}</td>
                <td>${fmtMin(r.activityMin || 0)}</td>
                <td>${r.signups || 0}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  // ---------- Supervisor ----------
  function renderSupervisor() {
    const tabs = [
      { id: "users", label: "Nutzer" },
      { id: "linien", label: "Lizenzen & Linien" },
      { id: "anmeldungen", label: "Anmeldungen" },
      { id: "activity", label: "Activity" },
    ];
    const tabHtml = `<div class="tabs">${tabs.map((tb) => `<button class="tab ${state.superTab === tb.id ? "active" : ""}" onclick="VBG.setSuperTab('${tb.id}')">${tb.label}</button>`).join("")}</div>`;
    let body = "";
    if (state.superTab === "users") body = superUsersView();
    else if (state.superTab === "linien") body = superLinienView();
    else if (state.superTab === "anmeldungen") body = superAnmeldungenView();
    else if (state.superTab === "activity") body = activityAllView();
    return `<h2>Supervisor</h2>${tabHtml}${body}`;
  }

  function superUsersView() {
    const rows = (state.users || []).map((u) => `
      <tr class="${u.kündigung ? "warn-hot" : ""}">
        <td><b>${h(u.username)}</b>
          ${u.protected ? `<span class="crown" title="geschützt">♛</span>` : ""}
          ${u.suspended ? `<span class="badge red">gesperrt</span>` : ""}
          ${u.kündigung ? `<span class="badge red">Kündigung droht</span>` : ""}
          <div class="muted" style="font-size:11px">${h(u.discordName || "–")}${u.robloxName ? " · " + h(u.robloxName) : ""}</div>
        </td>
        <td>${roleBadge(u.role)}</td>
        <td>${licBadges(u.linien)}</td>
        <td><b>${u.strafstunden || 0}</b>
          <div class="flex" style="gap:4px">
            <button class="btn btn-xs btn-yellow" onclick="VBG.strafe('${u.id}',+0.5)">+0,5</button>
            <button class="btn btn-xs btn-yellow" onclick="VBG.strafe('${u.id}',+1)">+1</button>
            <button class="btn btn-xs" onclick="VBG.strafe('${u.id}',-1)">−1</button>
            <button class="btn btn-xs" onclick="VBG.strafe('${u.id}',-0.5)">−0,5</button>
          </div>
        </td>
        <td>
          <button class="btn btn-ghost btn-xs" onclick="VBG.editUser('${u.id}')">Bearbeiten</button>
          <button class="btn btn-ghost btn-xs" onclick="VBG.resetPw('${u.id}')">Passwort</button>
          ${u.protected ? "" : `
          <button class="btn btn-xs ${u.suspended ? "btn-green" : "btn-yellow"}" onclick="VBG.toggleSuspend('${u.id}')">${u.suspended ? "Entsperren" : "Sperren"}</button>
          <button class="btn btn-danger btn-xs" onclick="VBG.deleteUser('${u.id}')">Löschen</button>`}
        </td>
      </tr>`).join("");

    return `
      <div class="spread"><h3 style="margin:0">Nutzer</h3>
        <button class="btn" onclick="VBG.showUserForm()">+ Nutzer anlegen</button>
      </div>
      <div id="user-form"></div>
      <div class="container">
        <table>
          <thead><tr><th>Nutzer</th><th>Rolle</th><th>Lizenzen</th><th>Strafstunden</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function superLinienView() {
    return `
      <div class="spread"><h3 style="margin:0">Lizenzen &amp; Linien</h3>
        <button class="btn" onclick="VBG.showLinieForm()">+ Neue Linie</button>
      </div>
      <div id="linie-form"></div>
      <div class="container">
        <p class="muted">Lizenzen werden den Personen im Tab <b>Nutzer</b> zugewiesen.
        Hier legst du die Linien mit Namen und Beschreibung an bzw. änderst sie.</p>
        <table>
          <thead><tr><th>Name</th><th>Beschreibung</th><th>Haltestellen</th><th></th></tr></thead>
          <tbody>
            ${state.cats.linien.map((l) => `
              <tr>
                <td><b>${h(l.name)}</b></td>
                <td>${h(l.beschreibung || "")}</td>
                <td ${(l.stopsHin || []).length || (l.stopsRueck || []).length ? `title="${h(stopSummary(l))}"` : ""}>${(l.stopsHin || []).length} Hin · ${(l.stopsRueck || []).length} Rück</td>
                <td>
                  <button class="btn btn-ghost btn-xs" onclick="VBG.editLinie('${l.id}')">Bearbeiten</button>
                  <button class="btn btn-danger btn-xs" onclick="VBG.delLinie('${l.id}')">Löschen</button>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  function superAnmeldungenView() {
    const apps = state.appsAll || [];
    const wishes = state.wishesAll || [];
    const shiftsReal = realShifts();
    return `
      <h3>Anmeldungen</h3>
      <div class="container">
        <div class="form-grid" style="margin-bottom:10px">
          <label>Filter Nutzer<input id="af-user" value="${h(state.appFilter.nutzer)}" onchange="VBG.setAppFilterNutzer(this.value)"/></label>
          <label>Filter Shift<select id="af-shift" onchange="VBG.setAppFilterShift(this.value)">
            <option value="">— alle —</option>
            ${shiftsReal.map((s) => `<option value="${s.id}" ${state.appFilter.shift === s.id ? "selected" : ""}>${h(s.name)}</option>`).join("")}
          </select></label>
          <button class="btn btn-ghost" style="align-self:end" onclick="VBG.resetAppFilter()">Filter zurücksetzen</button>
        </div>
        ${apps.length ? `
        <table>
          <thead><tr><th>Nutzer</th><th>Shift</th><th>Von–Bis</th><th>Hinweis</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${apps.map((a) => `
              <tr>
                <td>${h(a.username)}${a.kündigung ? ` <span class="badge red" style="font-size:10px">Kündigung</span>` : ""}</td>
                <td>${h(a.shiftName || "?")}${a.art === "kundenservice" ? ` <span class="badge sky" style="font-size:10px">KS</span>` : ""}${a.standortName ? " · " + h(a.standortName) : ""}</td>
                <td>${h(a.von)}–${h(a.bis)}</td>
                <td>${h(a.hinweis || "")}</td>
                <td><span class="badge ${a.status === "accepted" ? "green" : a.status === "denied" ? "red" : "yellow"}">${a.status === "accepted" ? "angenommen" : a.status === "denied" ? "abgelehnt" : "ausstehend"}</span></td>
                <td>
                  <div class="flex" style="gap:4px">
                    ${a.status === "pending" ? `
                      <button class="btn btn-green btn-xs" onclick="VBG.acceptApp('${a.id}')">Annehmen</button>
                      <button class="btn btn-danger btn-xs" onclick="VBG.denyApp('${a.id}')">Ablehnen</button>` : ""}
                    <button class="btn btn-ghost btn-xs" onclick="VBG.delApp('${a.id}')">Entfernen</button>
                  </div>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>` : `<div class="empty">Keine Anmeldungen ${apps === undefined ? "(Filter?)" : ""}.</div>`}
      </div>

      <h3>Wünsche</h3>
      <div class="container">
        <p class="muted">Wünsche von Fahrern für bestimmte Dutys – sie können hier angenommen (zugeteilt) oder abgelehnt werden.</p>
        ${wishes.length ? `
        <table>
          <thead><tr><th>Nutzer</th><th>Duty</th><th>Linie</th><th>Zeit</th><th>Aktion</th></tr></thead>
          <tbody>
            ${wishes.map((w) => `
              <tr>
                <td>${h(w.username)}</td>
                <td>${h(w.dutyName)}</td>
                <td>${h(w.linie || "–")}</td>
                <td class="muted">${h(w.shiftStart)}–${h(w.shiftEnd)}</td>
                <td><div class="flex" style="gap:4px">
                  <button class="btn btn-green btn-xs" onclick="VBG.acceptWish('${w.id}')">Zuteilen</button>
                  <button class="btn btn-danger btn-xs" onclick="VBG.denyWish('${w.id}')">Ablehnen</button>
                </div></td>
              </tr>`).join("")}
          </tbody>
        </table>` : `<div class="empty">Keine offenen Wünsche.</div>`}
      </div>`;
  }

  // ---------- Account ----------
  const DESKTOP_KEY = "vbg_desktop_notif";
  function desktopEnabled() { return localStorage.getItem(DESKTOP_KEY) === "1"; }

  function renderAccount() {
    const u = state.user;
    const prof = state.profile || null;
    const robloxEditable = prof ? prof.robloxEditable : (u && u.robloxEditable);
    const isSelf = true;
    void isSelf;
    return `
      <h2>Account</h2>
      <div class="container">
        <div class="spread">
          <div>
            <h2 style="margin:0">${h(u.username)}</h2>
            ${roleBadge(u.role)}
            <span class="muted">${h(u.discordName ? "Discord: " + u.discordName : "")}</span>
          </div>
          <span class="avatar" style="width:64px;height:64px;font-size:26px">${h(avatarLetter(u))}</span>
        </div>

        <div class="form-grid" style="margin-top:14px">
          <label>Discord Name<input id="acc-discord" value="${h(u.discordName || "")}" placeholder="z. B. jg_gaming"/></label>
          <label>Roblox Name<input id="acc-roblox" value="${h(u.robloxName || "")}" placeholder="z. B. jggaming2518"
            ${!robloxEditable ? "disabled" : ""}/></label>
          <label>Sprache der Website<select id="acc-lang">
            <option value="de" ${u.language !== "en" ? "selected" : ""}>Deutsch</option>
            <option value="en" ${u.language === "en" ? "selected" : ""}>English</option>
          </select></label>
        </div>
        ${!robloxEditable ? `<div class="muted" style="margin-top:6px">Roblox-Name ist nur alle 6 Monate änderbar – ein Supervisor kann ihn im Nutzer-Tab anpassen.</div>` : ""}
        <div style="margin-top:12px">
          <button class="btn btn-green" onclick="VBG.saveProfile()">Profil speichern</button>
        </div>
      </div>

      <div class="container">
        <h2>Eigene Lizenzen</h2>
        ${prof && prof.linien && prof.linien.length ? `
          ${prof.linien.map((l) => `<span class="badge ${linieClsId(l.id)}" style="margin:0 8px 8px 0">${h(l.name)} – ${h(l.beschreibung || "")}</span>`).join("")}`
        : `<div class="muted">Noch keine Lizenzen zugewiesen.</div>`}
      </div>

      <div class="container">
        <div class="spread"><h2 style="margin:0">Meine Zuteilungen (Shiftplan)</h2>
          <button class="btn btn-ghost btn-sm" onclick="VBG.setView('shiftplan')">Zum Shiftplan</button>
        </div>
        <h3 style="margin:14px 0 6px">Duty-Zuteilungen</h3>
        ${prof && prof.zuteilungen && prof.zuteilungen.length ? `
          <table>
            <thead><tr><th>Duty</th><th>Linie</th><th>Beginn</th><th>Ende</th></tr></thead>
            <tbody>${prof.zuteilungen.map((z) => `
              <tr><td>${h(z.name)}</td><td>${h(z.linie)}</td><td>${h(z.start)}</td><td>${h(z.end)}</td></tr>`).join("")}
            </tbody>
          </table>` : `<div class="muted">Keine Duty-Zuteilungen.</div>`}
        <h3 style="margin:14px 0 6px">Einzelfahrt-Zuteilungen</h3>
        ${prof && prof.einzelfahrten && prof.einzelfahrten.length ? `
          <table>
            <thead><tr><th>Duty</th><th>Fahrt</th><th>Ab</th><th>An</th></tr></thead>
            <tbody>${prof.einzelfahrten.map((z) => `
              <tr><td>${h(z.dutyName)}</td><td>${h(z.from)} → ${h(z.to)}</td><td>${h(z.dep)}</td><td>${h(z.arr)}</td></tr>`).join("")}
            </tbody>
          </table>` : `<div class="muted">Keine Einzelfahrt-Zuteilungen.</div>`}
      </div>

      <div class="container">
        <div class="spread">
          <div><h2 style="margin:0">Desktop-Benachrichtigungen</h2>
            <span class="muted">${desktopEnabled() ? "Aktiv" : "Aus"}</span></div>
          <button class="btn ${desktopEnabled() ? "btn-yellow" : "btn-green"}" onclick="VBG.toggleDesktop()">
            ${desktopEnabled() ? "Deaktivieren" : "Aktivieren"}
          </button>
        </div>
        <p class="muted">Erhalte eine System-Benachrichtigung, wenn eine neue (nicht dringende) Nachricht vom Supervisor eintrifft.</p>
      </div>

      <div class="container">
        <button class="btn btn-danger" onclick="VBG.doLogout()">Abmelden</button>
      </div>`;
  }

  // ---------- Nachrichten (Supervisor) ----------
  function openAnnounceModal() {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal">
        <h2>Nachricht senden</h2>
        <label>Text<textarea id="ann-text" rows="3" placeholder="Nachricht an die Auswahl…"></textarea></label>
        <fieldset><legend>Zielgruppe</legend>
          <label class="checkline"><input type="checkbox" value="user" checked/> Busfahrer</label>
          <label class="checkline"><input type="checkbox" value="senior" checked/> Senior Busfahrer</label>
          <label class="checkline"><input type="checkbox" value="supervisor" checked/> Supervisor</label>
        </fieldset>
        <label class="checkline"><input id="ann-dringend" type="checkbox"/> Dringend (rotes Overlay + Warnton)</label>
        <div class="flex" style="margin-top:12px">
          <button class="btn btn-green" onclick="VBG.sendAnnounce()">Senden</button>
          <button class="btn btn-ghost" onclick="this.closest('.modal-backdrop').remove()">Abbrechen</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  }

  // ---------- Announcements (Banner + dringend-Overlay) ----------
  let lastAnnounceKey = "";
  let urgentShown = false;
  async function checkAnnouncements() {
    if (!state.user) return;
    try {
      const r = await api("GET", "/api/announcements/latest");
      const { latest, unseen } = r;
      if (!latest) { hideBanner(); state.latestAnnounce = null; return; }
      state.latestAnnounce = latest;
      const key = latest.id + "_" + (latest.read ? "r" : "u");
      renderAnnounceBanner(latest, unseen);

      if (unseen && latest.dringend === true && latest.id !== lastAnnounceKey) {
        lastAnnounceKey = latest.id;
        showUrgentOverlay(latest);
      }
    } catch (e) {}
  }

  function renderAnnounceBanner(latest, unseen) {
    const slot = document.getElementById("announce-banner");
    if (!slot) return;
    if (!unseen) { slot.innerHTML = ""; return; }
    slot.innerHTML = `
      <div class="announce-banner">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path></svg>
        <span><b>${h(latest.von || "Supervisor")}:</b> ${h(latest.message)}</span>
        <button class="btn btn-sm btn-green" onclick="VBG.markAnnounceSeen()">Gelesen</button>
      </div>`;
  }
  function hideBanner() {
    const slot = document.getElementById("announce-banner");
    if (slot) slot.innerHTML = "";
  }

  async function markAnnounceSeen() {
    const n = state.latestAnnounce;
    if (!n) return;
    try {
      await api("POST", "/api/notifications/" + n.id + "/read", {});
      hideBanner();
      lastAnnounceKey = n.id;
      loadNotifs();
      // Re-Poll setzt unseen auf false
      setTimeout(checkAnnouncements, 500);
    } catch (e) { toast(e.message, "err"); }
  }

  // Dringendes Overlay mit 10-Sekunden-Sperre + Warnton (< 3,5 s)
  function playUrgent() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const playTone = (freq, start, dur, vol) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine"; o.frequency.value = freq;
        o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
        g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
        o.start(ctx.currentTime + start); o.stop(ctx.currentTime + start + dur + 0.05);
      };
      playTone(660, 0, 0.28, 0.25);
      playTone(520, 0.32, 0.28, 0.25);
      playTone(660, 0.64, 0.4, 0.2);
      setTimeout(() => ctx.close(), 3200);
    } catch (e) {}
  }

  function showUrgentOverlay(ann) {
    if (urgentShown) return;
    urgentShown = true;
    playUrgent();
    const overlay = document.createElement("div");
    overlay.className = "urgent-overlay";
    overlay.innerHTML = `
      <div class="urgent-card">
        <div style="font-size:30px">⚠️</div>
        <h2>Dringende Nachricht</h2>
        <p>${h(ann.message)}</p>
        <div class="muted">von ${h(ann.von || "Supervisor")}</div>
        <button id="urgent-close" class="btn btn-danger" disabled>Verstanden (${10} s)</button>
      </div>`;
    document.body.appendChild(overlay);
    const btn = overlay.querySelector("#urgent-close");
    let rest = 10;
    const iv = setInterval(() => {
      rest--;
      if (rest <= 0) {
        clearInterval(iv);
        btn.disabled = false;
        btn.textContent = "Verstanden";
      } else btn.textContent = "Verstanden (" + rest + " s)";
    }, 1000);
    btn.onclick = () => {
      clearInterval(iv);
      overlay.remove();
      urgentShown = false;
      markAnnounceSeen();
    };
  }

  // ---------- Notifications ----------
  function toggleNotif(e) {
    e.stopPropagation();
    markSeenAllLocal();
    state.notifOpen = !state.notifOpen;
    renderNotifDrop();
  }
  function markSeenAllLocal() {
    state.notifications.forEach((n) => (n.read = true));
  }
  function renderNotifDrop() {
    const drop = document.getElementById("notif-drop");
    if (!drop) return;
    if (!state.notifOpen) { drop.classList.remove("open"); return; }
    drop.classList.add("open");
    drop.innerHTML = `
      <div class="head"><span>Benachrichtigungen</span>
        <button class="btn btn-ghost btn-xs" onclick="VBG.readAllNotifs(event)">Alle Gelesen</button>
      </div>
      ${state.notifications.length === 0 ? `<div class="notif-empty">Keine neuen Benachrichtigungen.</div>`
        : state.notifications.map((n) => `
          <div class="notif-item ${n.read ? "" : "unread"}" onclick="VBG.readNotif('${n.id}', event)">
            ${n.type ? `<span class="tag ${n.type}">${h(n.type)}</span> ` : ""}
            <span>${h(n.message)}</span>
            <div class="time">${fmtTime(n.createdAt)}</div>
          </div>`).join("")}`;
    renderTopbarBadge();
  }

  // ---------- Kern-Aktionen ----------
  async function doLogin() {
    const username = document.getElementById("login-user").value.trim();
    const password = document.getElementById("login-pw").value;
    const remember = document.getElementById("login-remember").checked;
    try {
      const r = await api("POST", "/api/auth/login", { username, password, remember });
      Auth.saveToken(r.token, remember);
      state.user = r.user;
      document.documentElement.lang = (state.user.language === "en") ? "en" : "de";
      await bootstrapAfterLogin();
    } catch (e) {
      const el = document.getElementById("login-error");
      if (el) el.textContent = e.message;
    }
  }

  async function bootstrapAfterLogin() {
    await refreshAll();
    if (isSup()) await loadUsers();
    await loadNotifs();
    await loadKundenservice();
    await checkAnnouncements();
    state.plan = null;
    state.view = "dashboard";
    render();
    startPolling();
  }

  function setView(v) {
    state.view = v;
    if (v === "shiftplan") { /* bleibt */ }
    if (v === "anmeldung") { /* */ }
    if (v === "supervisor" && isSup()) { loadUsers().then(() => { loadAppsAll(); render(); }); return; }
    if (v === "account") { loadProfile().then(() => render()); return; }
    state.notifOpen = false;
    render();
  }

  function setSuperTab(tab) {
    state.superTab = tab;
    if (tab === "users") { loadUsers().then(() => render()); return; }
    if (tab === "anmeldungen") { loadAppsAll().then(() => render()); return; }
    if (tab === "activity") { state.actAll = null; loadActivityAll().then((r) => { state.actAll = r; render(); }); return; }
    render();
  }

  async function loadAppsAll() {
    try {
      const q = new URLSearchParams();
      if (state.appFilter.nutzer) q.set("nutzer", state.appFilter.nutzer);
      if (state.appFilter.shift) q.set("shift", state.appFilter.shift);
      const [apps, wishes] = await Promise.all([
        api("GET", "/api/applications" + (q.toString() ? "?" + q.toString() : "")),
        api("GET", "/api/wishes"),
      ]);
      state.appsAll = apps.applications || [];
      state.wishesAll = wishes.wishes || [];
    } catch (e) { state.appsAll = []; state.wishesAll = []; }
  }

  // ---- Shifts ----
  function showShiftForm() {
    renderShiftFormInline(null);
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }
  function hideShiftForm() {
    const el = document.getElementById("shift-form");
    if (el) el.innerHTML = "";
  }
  function editShift(id) {
    const s = state.shifts.find((x) => x.id === id);
    renderShiftFormInline(s);
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }
  function newShiftFromTpl() {
    renderShiftFormInline(null);
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    toast("Neue Shift anlegen – Dutys werden automatisch aus dem Tagesplan geladen.", "ok");
  }
  async function saveShift(id) {
    const name = document.getElementById("sf-name").value.trim();
    if (!name) { toast("Name fehlt", "err"); return; }
    const hostId = document.getElementById("sf-host").value;
    const coSupervisorIds = [];
    document.querySelectorAll("[data-co]").forEach((c) => { if (c.checked) coSupervisorIds.push(c.value); });
    const body = {
      name,
      date: document.getElementById("sf-date").value,
      startTime: document.getElementById("sf-start").value,
      endTime: document.getElementById("sf-end").value,
      notes: document.getElementById("sf-notes").value,
      hostId,
      coSupervisorIds,
    };
    try {
      if (id) {
        await api("PATCH", "/api/shifts/" + id, body);
        toast("Shift aktualisiert", "ok");
      } else {
        body.fromTemplate = document.getElementById("sf-tpl").checked;
        const r = await api("POST", "/api/shifts", body);
        toast(`Shift erstellt – ${r.copiedDuties || 0} Dutys automatisch geladen`, "ok");
      }
      hideShiftForm();
      await refreshAll();
      state.planShiftId = id || "";
      render();
    } catch (e) { toast(e.message, "err"); }
  }
  async function deleteShift(id) {
    if (!confirm("Shift wirklich löschen? Alle Dutys und Anmeldungen werden entfernt.")) return;
    try { await api("DELETE", "/api/shifts/" + id); toast("Gelöscht", "ok"); await refreshAll(); render(); }
    catch (e) { toast(e.message, "err"); }
  }

  // ---- Shiftplan ----
  function selectPlanShift(id) {
    state.planShiftId = id;
    state.plan = null;
    render();
  }
  function openPlan(id) { state.planShiftId = id; state.plan = null; setView("shiftplan"); }
  function reloadFromTpl() {
    // Dutys aus Tagesplan nachladen → Shift neu anlegen Variante: direkt auf die Shift laden
    toast("Nutze „Neue Shift“ mit aktiviertem Tagesplan-Häkchen.", "");
  }
  function toggleStops(tripId) {
    if (state.planExpandedStops[tripId]) delete state.planExpandedStops[tripId];
    else state.planExpandedStops[tripId] = true;
    render();
  }
  function toggleDutyStops(dutyId) {
    if (state.expandedDuties[dutyId]) delete state.expandedDuties[dutyId];
    else state.expandedDuties[dutyId] = true;
    render();
  }

  async function assignDuty(dutyId, userId) {
    try {
      await api("PATCH", "/api/duties/" + dutyId, { assignedUserId: userId || null });
      toast(userId ? "Zuteilung (Duty) gesetzt" : "Zuteilung entfernt", "ok");
      await loadPlan(); render();
    } catch (e) { toast(e.message, "err"); await loadPlan(); render(); }
  }
  async function assignDutyVehicle(dutyId, vehicleId) {
    try {
      await api("PATCH", "/api/duties/" + dutyId, { vehicleId: vehicleId || null });
      toast("Fahrzeug gesetzt", "ok");
      await loadPlan(); render();
    } catch (e) { toast(e.message, "err"); }
  }
  async function saveDutyBemerk(dutyId) {
    const bemerkung = document.getElementById("duty-bem-" + dutyId).value;
    try { await api("PATCH", "/api/duties/" + dutyId, { bemerkung }); toast("Bemerkung gespeichert", "ok"); }
    catch (e) { toast(e.message, "err"); }
  }
  function editDutyTimes(dutyId) {
    const d = state.plan.duties.find((x) => x.id === dutyId);
    const s = prompt("Duty-Anfang (HH:MM), z. B. " + (d.startTime || "05:00"), d.startTime || "");
    if (s === null) return;
    const e = prompt("Duty-Ende (HH:MM), z. B. " + (d.endTime || "21:00"), d.endTime || "");
    if (e === null) return;
    api("PATCH", "/api/duties/" + dutyId, { startTime: s, endTime: e })
      .then(() => { toast("Zeiten angepasst", "ok"); return loadPlan(); })
      .then(() => render())
      .catch((er) => toast(er.message, "err"));
  }
  async function toggleDutyCancel(dutyId) {
    const d = state.plan.duties.find((x) => x.id === dutyId);
    try {
      await api("PATCH", "/api/duties/" + dutyId, { cancelled: !d.cancelled });
      toast(d.cancelled ? "Duty wieder aktiv" : "Duty ausgefallen", "ok");
      await loadPlan(); render();
    } catch (e) { toast(e.message, "err"); }
  }
  async function deleteDuty(dutyId) {
    if (!confirm("Löschen?")) return;
    try { await api("DELETE", "/api/duties/" + dutyId); toast("Gelöscht", "ok"); await loadPlan(); render(); }
    catch (e) { toast(e.message, "err"); }
  }

  async function assignTrip(dutyId, tripId, userId) {
    try {
      await api("PATCH", "/api/duties/" + dutyId + "/trips/" + tripId, { assignedUserId: userId || null });
      toast(userId ? "Einzelfahrt zugeteilt" : "Zuteilung entfernt", "ok");
      await loadPlan(); render();
    } catch (e) { toast(e.message, "err"); await loadPlan(); render(); }
  }
  async function assignTripVehicle(dutyId, tripId, vehicleId) {
    try {
      await api("PATCH", "/api/duties/" + dutyId + "/trips/" + tripId, { vehicleId: vehicleId || null });
      toast("Fahrzeug gesetzt", "ok");
      await loadPlan(); render();
    } catch (e) { toast(e.message, "err"); }
  }
  async function toggleTripCancel(dutyId, tripId) {
    const d = state.plan.duties.find((x) => x.id === dutyId);
    const tr = (d.trips || []).find((x) => x.id === tripId);
    try {
      await api("PATCH", "/api/duties/" + dutyId + "/trips/" + tripId, { cancelled: !tr.cancelled });
      toast(tr.cancelled ? "Fahrt wieder aktiv" : "Fahrt ausgefallen (durchgestrichen)", "ok");
      await loadPlan(); render();
    } catch (e) { toast(e.message, "err"); }
  }
  function toggleTripEdit(dutyId, tripId) {
    const d = state.plan.duties.find((x) => x.id === dutyId);
    const tr = (d.trips || []).find((x) => x.id === tripId);
    const from = prompt("Von (Haltestelle)", tr.from || "");
    if (from === null) return;
    const to = prompt("Nach (Haltestelle)", tr.to || "");
    if (to === null) return;
    const dep = prompt("Abfahrt (HH:MM)", tr.dep || "");
    if (dep === null) return;
    const arr = prompt("Ankunft (HH:MM)", tr.arr || "");
    if (arr === null) return;
    const bemerkung = prompt("Bemerkung (Fahrt)", tr.bemerkung || "");
    if (bemerkung === null) return;
    api("PATCH", "/api/duties/" + dutyId + "/trips/" + tripId, { from, to, dep, arr, bemerkung })
      .then(() => { toast("Fahrt aktualisiert", "ok"); return loadPlan(); })
      .then(() => render())
      .catch((er) => toast(er.message, "err"));
  }
  function toggleStopCancel(dutyId, tripId, stopId) {
    api("GET", "/api/duties/" + dutyId).then((r) => {
      const tr = (r.duty.trips || []).find((x) => x.id === tripId);
      const st = (tr.stops || []).find((x) => x.id === stopId);
      return api("PATCH", "/api/duties/" + dutyId + "/trips/" + tripId + "/stops/" + stopId, { cancelled: !st.cancelled });
    }).then(() => { toast("Halt aktualisiert", "ok"); return loadPlan(); })
      .then(() => render())
      .catch((e) => toast(e.message, "err"));
  }
  function addStop(dutyId, tripId) {
    const station = prompt("Haltestelle");
    if (!station) return;
    const arr = prompt("Ankunft (optional)", "") || "";
    api("POST", "/api/duties/" + dutyId + "/trips/" + tripId + "/stops", { station, arr })
      .then(() => { toast("Halt hinzugefügt", "ok"); return loadPlan(); })
      .then(() => render())
      .catch((e) => toast(e.message, "err"));
  }

  // ---- Anmeldung ----
  async function submitAnmeldung() {
    const shiftId = document.getElementById("an-shift").value;
    const von = document.getElementById("an-von").value;
    const bis = document.getElementById("an-bis").value;
    const art = state.anmeldungArt;
    const standortId = art === "kundenservice" ? document.getElementById("an-standort").value : undefined;
    const hinweis = document.getElementById("an-hinweis").value;
    if (!shiftId || !von || !bis) { toast("Shift, Von und Bis ausfüllen", "err"); return; }
    if ((state.user.strafstunden || 0) >= 3 && art === "bus") { toast("Ab 3 Strafstunden nur noch Kundenservice", "err"); return; }
    try {
      await api("POST", "/api/applications", { shiftId, von, bis, art, standortId: standortId || undefined, hinweis });
      toast("Anmeldung erstellt", "ok");
      await loadMyApps();
      render();
    } catch (e) { toast(e.message, "err"); }
  }
  async function withdrawApp(id) {
    try { await api("DELETE", "/api/my/applications/" + id); toast("Zurückgezogen", "ok"); await loadMyApps(); render(); }
    catch (e) { toast(e.message, "err"); }
  }

  // ---- Kundenservice im Shiftplan ----
  function addStandort() {
    const name = prompt("Neuer Kundenservice-Standort");
    if (!name) return;
    api("POST", "/api/kundenservice", { name })
      .then(() => { toast("Standort angelegt", "ok"); return loadKundenservice(); })
      .then(() => render())
      .catch((e) => toast(e.message, "err"));
  }
  function renameStandort(id) {
    const k = KUNDENSERVICE_STATE.items.find((x) => x.id === id);
    const name = prompt("Name", k ? k.name : "");
    if (!name) return;
    api("PATCH", "/api/kundenservice/" + id, { name })
      .then(() => { toast("Umbenannt", "ok"); return loadKundenservice(); })
      .then(() => render())
      .catch((e) => toast(e.message, "err"));
  }
  function delStandort(id) {
    if (!confirm("Standort löschen?")) return;
    api("DELETE", "/api/kundenservice/" + id)
      .then(() => { toast("Gelöscht", "ok"); return loadKundenservice(); })
      .then(() => render())
      .catch((e) => toast(e.message, "err"));
  }
  function kundenserviceSignup(id) {
    if (!state.planShiftId) { toast("Erst eine Shift wählen", "err"); return; }
    state.view = "anmeldung";
    state.anmeldungArt = "kundenservice";
    state.anmeldungShiftId = state.planShiftId;
    render();
    setTimeout(() => {
      const sel = document.getElementById("an-standort");
      if (sel) sel.value = id;
      toast("Kundenservice-Anmeldung für diese Shift – mindestens 30 Minuten.", "ok");
    }, 60);
  }

  // ---- Activity ----
  async function signupActivity() {
    try {
      await api("POST", "/api/activity/signup", {});
      toast("Für Activity angemeldet!", "ok");
      const r = await loadActivityMe();
      state.actMe = r;
      render();
    } catch (e) { toast(e.message, "err"); }
  }

  // ---- Supervisor: Nutzer ----
  function showUserForm() {
    const el = document.getElementById("user-form");
    el.innerHTML = `
      <div class="container">
        <h2>Nutzer anlegen</h2>
        <p class="muted">Ein Einmal-Passwort wird automatisch erzeugt. Nur Benutzername, Rolle und ggf. Lizenzen angeben.</p>
        <div class="form-grid">
          <label>Benutzername<input id="nu-name" placeholder="z. B. max_bus"/></label>
          <label>Rolle<select id="nu-role">
            <option value="user">Busfahrer</option>
            <option value="senior">Senior Busfahrer</option>
            <option value="supervisor">Supervisor</option>
          </select></label>
        </div>
        <fieldset><legend>Lizenzen</legend>
          ${state.cats.linien.map((l) => `<label class="checkline"><input type="checkbox" value="${l.id}"> ${h(l.name)} – ${h(l.beschreibung || "")}</label>`).join("")}
        </fieldset>
        <div class="flex" style="margin-top:8px">
          <button class="btn btn-green" onclick="VBG.createUser()">Anlegen</button>
          <button class="btn btn-ghost" onclick="document.getElementById('user-form').innerHTML=''">Abbrechen</button>
        </div>
        <div id="user-pw-result"></div>
      </div>`;
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }
  async function createUser() {
    const username = document.getElementById("nu-name").value.trim();
    const role = document.getElementById("nu-role").value;
    const linien = [];
    document.querySelectorAll("#user-form .checkline input:checked").forEach((c) => linien.push(c.value));
    if (!username) { toast("Benutzername fehlt", "err"); return; }
    try {
      const r = await api("POST", "/api/users", { username, role, linien });
      const box = document.getElementById("user-pw-result");
      box.innerHTML = `
        <div style="margin-top:12px;background:var(--panel2);border:1px solid var(--green);border-radius:8px;padding:14px">
          <b style="color:var(--green)">Nutzer angelegt – Zugangsdaten (für Copy-Paste):</b>
          <pre style="background:#0c1117;padding:10px;border-radius:6px;margin-top:8px;line-height:1.7">bn:   ${h(username)}
pw:   ${h(r.einmalPasswort)}
rolle: ${h(ROLE_LABELS[role] || role)}</pre>
          <button class="btn btn-sm" onclick="VBG.copyPwResult()">In Zwischenablage kopieren</button>
        </div>`;
      toast("Nutzer angelegt", "ok");
      await loadUsers();
    } catch (e) { toast(e.message, "err"); }
  }
  function copyPwResult() {
    const pre = document.querySelector("#user-pw-result pre");
    const text = pre ? pre.textContent : "";
    navigator.clipboard && navigator.clipboard.writeText(text).then(() => toast("Kopiert", "ok")).catch(() => toast("Kopieren fehlgeschlagen", "err"));
  }
  function editUser(id) {
    const u = state.users.find((x) => x.id === id);
    const el = document.getElementById("user-form");
    const robloxReadonly = u.robloxEditable === undefined ? false : !u.robloxEditable;
    el.innerHTML = `
      <div class="container">
        <h2>Nutzer bearbeiten: ${h(u.username)}</h2>
        <div class="form-grid">
          <label>Rolle<select id="eu-role">
            <option value="user" ${u.role === "user" ? "selected" : ""}>Busfahrer</option>
            <option value="senior" ${u.role === "senior" ? "selected" : ""}>Senior Busfahrer</option>
            <option value="supervisor" ${u.role === "supervisor" ? "selected" : ""}>Supervisor</option>
          </select></label>
          <label>Discord Name<input id="eu-discord" value="${h(u.discordName || "")}"/></label>
          <label>Roblox Name<input id="eu-roblox" value="${h(u.robloxName || "")}" ${robloxReadonly && !u.protected ? "disabled" : ""}/>
            <span class="muted" style="font-size:11px">${robloxReadonly ? "noch nicht abgelaufen (6 Monate)" : "änderbar"}</span>
          </label>
          <label>Sprache<select id="eu-lang"><option value="de" ${u.language !== "en" ? "selected" : ""}>Deutsch</option><option value="en" ${u.language === "en" ? "selected" : ""}>English</option></select></label>
        </div>
        <fieldset><legend>Lizenzen</legend>
          ${state.cats.linien.map((l) => `<label class="checkline"><input type="checkbox" value="${l.id}" ${(u.linien || []).includes(l.id) ? "checked" : ""}> ${h(l.name)} – ${h(l.beschreibung || "")}</label>`).join("")}
        </fieldset>
        ${u.protected ? `<p class="muted">Geschützter Supervisor – Rolle/Lizenzen/Sperre werden hier nicht verändert.</p>` : ""}
        <div class="flex" style="margin-top:8px">
          <button class="btn btn-green" onclick="VBG.saveUserEdit('${u.id}')">Speichern</button>
          <button class="btn btn-ghost" onclick="document.getElementById('user-form').innerHTML=''">Abbrechen</button>
        </div>
      </div>`;
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }
  async function saveUserEdit(id) {
    const body = {
      role: document.getElementById("eu-role").value,
      discordName: document.getElementById("eu-discord").value,
      language: document.getElementById("eu-lang").value,
    };
    const rbx = document.getElementById("eu-roblox");
    if (!rbx.disabled) body.robloxName = rbx.value;
    if (!document.querySelector("#user-form .container .muted")) {
      const linien = [];
      document.querySelectorAll("#user-form .checkline input:checked").forEach((c) => linien.push(c.value));
      body.linien = linien;
    }
    try {
      await api("PATCH", "/api/users/" + id, body);
      toast("Gespeichert", "ok");
      document.getElementById("user-form").innerHTML = "";
      await loadUsers();
      setSuperTab("users");
    } catch (e) { toast(e.message, "err"); }
  }
  async function strafe(id, delta) {
    try {
      const r = await api("POST", "/api/users/" + id + "/strafstunden", { delta });
      toast("Strafstunden: " + r.user.strafstunden, "ok");
      await loadUsers(); render();
    } catch (e) { toast(e.message, "err"); }
  }
  async function resetPw(id) {
    const u = state.users.find((x) => x.id === id);
    const neu = prompt("Neues Passwort für " + u.username + " (leer = zufällig):", "");
    if (neu === null) return;
    if (neu === "") {
      // Zufallspasswort über Backend-Set (server generiert kein reset; nutze einfaches lokal generiertes)
      const chars = "abcdefghjkmnpqrstuvwxyz23456789";
      let pw = "";
      for (let i = 0; i < 10; i++) pw += chars[Math.floor(Math.random() * chars.length)];
      await api("PATCH", "/api/users/" + id, { password: pw });
      toast("Neues Passwort: " + pw, "ok");
    } else {
      await api("PATCH", "/api/users/" + id, { password: neu });
      toast("Passwort gesetzt", "ok");
    }
    await loadUsers();
  }
  async function toggleSuspend(id) {
    const u = state.users.find((x) => x.id === id);
    try { await api("PATCH", "/api/users/" + id, { suspended: !u.suspended }); await loadUsers(); render(); }
    catch (e) { toast(e.message, "err"); }
  }
  async function deleteUser(id) {
    if (!confirm("Nutzer wirklich löschen?")) return;
    try { await api("DELETE", "/api/users/" + id); toast("Gelöscht", "ok"); await loadUsers(); render(); }
    catch (e) { toast(e.message, "err"); }
  }

  // ---- Supervisor: Linien ----
  function showLinieForm() {
    const el = document.getElementById("linie-form");
    el.innerHTML = `
      <div class="container">
        <h2>Neue Linie / Lizenz</h2>
        <div class="form-grid">
          <label>Name<input id="nl-name" placeholder="z. B. (SB) 24"/></label>
          <label>Beschreibung<input id="nl-desc" placeholder="z. B. Schnellbus, Nachtbus, …"/></label>
        </div>
        <div id="stops-ed-hin"></div>
        <div id="stops-ed-rueck"></div>
        <div class="flex" style="margin-top:8px">
          <button class="btn btn-green" onclick="VBG.createLinie()">Anlegen</button>
          <button class="btn btn-ghost" onclick="document.getElementById('linie-form').innerHTML=''">Abbrechen</button>
        </div>
      </div>`;
    renderStopsEditor("hin", []);
    renderStopsEditor("rueck", []);
  }
  function renderStopsEditor(dir, values) {
    const wrap = document.getElementById("stops-ed-" + dir);
    if (!wrap) return;
    const title = dir === "hin" ? "Hinweg – Haltestellen & Fahrzeiten" : "Rückweg – Haltestellen & Fahrzeiten";
    const rows = values.length ? values : [{ station: "", min: 0 }];
    wrap.innerHTML = `
      <fieldset style="margin-top:12px"><legend>${title}</legend>
        ${rows.map((r, i) => `
          <div style="display:flex;gap:8px;margin:6px 0;align-items:center">
            <span class="muted" style="min-width:18px">${i + 1}.</span>
            <input data-st-dir="${dir}" data-st-i="${i}" class="st-station" style="flex:1" placeholder="Haltestelle (${i === 0 ? "Start" : "Zwischenhalt"})" value="${h(r.station || "")}"/>
            <input data-st-dir="${dir}" data-st-i="${i}" class="st-min" type="number" min="0" step="1" style="width:110px" placeholder="Min." value="${r.min || 0}"/>
            <button class="btn btn-ghost btn-xs" onclick="VBG.removeStopRow('${dir}', ${i})" title="Haltestelle entfernen">×</button>
          </div>`).join("")}
        <button class="btn btn-sm" onclick="VBG.addStopRow('${dir}')">+ Haltestelle</button>
        <span class="muted" style="margin-left:10px;font-size:12px">Min. = Fahrzeit ab Starthaltepunkt</span>
      </fieldset>`;
  }
  function stopValues(dir) {
    return stopValuesRaw(dir).filter((x) => x.station);
  }
  function stopValuesRaw(dir) {
    return Array.from(document.querySelectorAll('.st-station[data-st-dir="' + dir + '"]')).map((el, i) => ({
      station: (el.value || "").trim(),
      min: parseInt((document.querySelectorAll('.st-min[data-st-dir="' + dir + '"]')[i] || {}).value, 10) || 0,
    }));
  }
  function addStopRow(dir) {
    renderStopsEditor(dir, stopValuesRaw(dir).concat([{ station: "", min: 0 }]));
  }
  function removeStopRow(dir, i) {
    const v = stopValuesRaw(dir);
    v.splice(i, 1);
    renderStopsEditor(dir, v);
  }
  async function createLinie() {
    const name = document.getElementById("nl-name").value.trim();
    const beschreibung = document.getElementById("nl-desc").value.trim();
    if (!name) { toast("Name fehlt", "err"); return; }
    try {
      await api("POST", "/api/linien", { name, beschreibung, stopsHin: stopValues("hin"), stopsRueck: stopValues("rueck") });
      toast("Linie angelegt", "ok"); document.getElementById("linie-form").innerHTML = ""; await loadCats(); render();
    } catch (e) { toast(e.message, "err"); }
  }
  function editLinie(id) {
    const l = state.cats.linien.find((x) => x.id === id);
    const el = document.getElementById("linie-form");
    el.innerHTML = `
      <div class="container">
        <h2>Linie bearbeiten</h2>
        <div class="form-grid">
          <label>Name<input id="el-name" value="${h(l.name)}"/></label>
          <label>Beschreibung<input id="el-desc" value="${h(l.beschreibung || "")}" placeholder="z. B. Schnellbus, Nachtbus"/></label>
        </div>
        <div id="stops-ed-hin"></div>
        <div id="stops-ed-rueck"></div>
        <div class="flex" style="margin-top:8px">
          <button class="btn btn-green" onclick="VBG.saveLinie('${l.id}')">Speichern</button>
          <button class="btn btn-ghost" onclick="document.getElementById('linie-form').innerHTML=''">Abbrechen</button>
        </div>
      </div>`;
    renderStopsEditor("hin", l.stopsHin || []);
    renderStopsEditor("rueck", l.stopsRueck || []);
  }
  async function saveLinie(id) {
    const name = document.getElementById("el-name").value.trim();
    const beschreibung = document.getElementById("el-desc").value.trim();
    try {
      await api("PATCH", "/api/linien/" + id, { name, beschreibung, stopsHin: stopValues("hin"), stopsRueck: stopValues("rueck") });
      toast("Gespeichert", "ok"); document.getElementById("linie-form").innerHTML = ""; await loadCats(); render();
    } catch (e) { toast(e.message, "err"); }
  }
  function stopSummary(l) {
    const a = l.stopsHin || [];
    const b = l.stopsRueck || [];
    const line = (arr) => arr.map((s) => s.station).join(" → ");
    return `${a.length} Hin · ${b.length} Rück${a.length ? " | Hin: " + line(a) : ""}${b.length ? " | Rück: " + line(b) : ""}`;
  }
  async function delLinie(id) {
    if (!confirm("Linie löschen? (Nutzern zugewiesene Lizenzen bleiben erhalten)") ) return;
    try { await api("DELETE", "/api/linien/" + id); toast("Gelöscht", "ok"); await loadCats(); render(); }
    catch (e) { toast(e.message, "err"); }
  }

  // ---- Supervisor: Anmeldungen ----
  async function acceptApp(id) {
    try { await api("POST", "/api/applications/" + id + "/accept"); toast("Angenommen", "ok"); await loadAppsAll(); render(); }
    catch (e) { toast(e.message, "err"); }
  }
  async function denyApp(id) {
    try { await api("POST", "/api/applications/" + id + "/deny"); toast("Abgelehnt", "ok"); await loadAppsAll(); render(); }
    catch (e) { toast(e.message, "err"); }
  }
  async function delApp(id) {
    try { await api("DELETE", "/api/applications/" + id); toast("Entfernt", "ok"); await loadAppsAll(); render(); }
    catch (e) { toast(e.message, "err"); }
  }
  async function acceptWish(id) {
    try { await api("POST", "/api/wishes/" + id + "/accept"); toast("Zugeteilt", "ok"); await loadAppsAll(); render(); }
    catch (e) { toast(e.message, "err"); }
  }
  async function denyWish(id) {
    try { await api("POST", "/api/wishes/" + id + "/deny"); toast("Abgelehnt", "ok"); await loadAppsAll(); render(); }
    catch (e) { toast(e.message, "err"); }
  }

  // ---- Nachrichten ----
  function openAnnounce() { openAnnounceModal(); }
  async function sendAnnounce() {
    const text = document.getElementById("ann-text").value.trim();
    if (!text) { toast("Text fehlt", "err"); return; }
    const zielgruppe = [];
    document.querySelectorAll(".modal-backdrop [type=checkbox][value]").forEach((c) => { if (c.checked) zielgruppe.push(c.value); });
    if (!zielgruppe.length) { toast("Zielgruppe wählen", "err"); return; }
    const dringend = document.getElementById("ann-dringend").checked;
    try {
      await api("POST", "/api/announcements", { text, zielgruppe, dringend });
      toast("Nachricht gesendet", "ok");
      document.querySelector(".modal-backdrop").remove();
      setTimeout(checkAnnouncements, 500);
    } catch (e) { toast(e.message, "err"); }
  }

  // ---- Notifications ----
  async function readNotif(id, ev) {
    if (ev) ev.stopPropagation();
    try { await api("POST", "/api/notifications/" + id + "/read", {}); markSeenAllLocal(); renderNotifDrop(); }
    catch (e) {}
  }
  async function readAllNotifs(ev) {
    if (ev) ev.stopPropagation();
    try { await api("POST", "/api/notifications/read-all", {}); markSeenAllLocal(); loadNotifs(); renderNotifDrop(); }
    catch (e) {}
  }

  // ---- Account ----
  async function loadProfile() {
    try { state.profile = await api("GET", "/api/me/profile"); state.user = { ...state.user, ...state.profile.user }; }
    catch (e) {}
  }
  async function saveProfile() {
    const discordName = document.getElementById("acc-discord").value.trim();
    const robloxName = document.getElementById("acc-roblox").value.trim();
    const language = document.getElementById("acc-lang").value;
    const body = { discordName, language };
    const rbx = document.getElementById("acc-roblox");
    if (!rbx.disabled) body.robloxName = robloxName;
    try {
      await api("PATCH", "/api/me/profile", body);
      toast("Profil gespeichert", "ok");
      document.documentElement.lang = language === "en" ? "en" : "de";
      state.user.language = language;
      await loadProfile();
      render();
    } catch (e) { toast(e.message, "err"); }
  }
  async function toggleDesktop() {
    if (desktopEnabled()) {
      localStorage.removeItem(DESKTOP_KEY);
      toast("Desktop-Benachrichtigungen deaktiviert", "ok");
      render();
      return;
    }
    if (!("Notification" in window)) { toast("Dieser Browser unterstützt keine Desktop-Benachrichtigungen", "err"); return; }
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      localStorage.setItem(DESKTOP_KEY, "1");
      toast("Desktop-Benachrichtigungen aktiv", "ok");
    } else toast("Berechtigung nicht erteilt", "err");
    render();
  }

  // ---- Inline-Handler-Helfer (für onchange etc.) ----
  function setAnmeldungShift(v) { state.anmeldungShiftId = v; }
  function setAnmeldungArt(v) { state.anmeldungArt = v; render(); }
  function setActivityRange(v) { state.activityRange = v; state.actAll = null; render(); }
  function setAppFilterNutzer(v) { state.appFilter.nutzer = v; state.appsAll = null; render(); }
  function setAppFilterShift(v) { state.appFilter.shift = v; state.appsAll = null; render(); }
  function resetAppFilter() { state.appFilter = { nutzer: "", shift: "" }; state.appsAll = null; render(); }

  // ---- Outro ----
  function doLogout() {
    try { api("POST", "/api/auth/logout"); } catch (e) {}
    Auth.clear();
    state.user = null;
    state.plan = null;
    state.myApps = [];
    state.notifications = [];
    render();
  }

  // ---------- Polling ----------
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (!state.user) return;
      await loadNotifs();
      await checkAnnouncements();
      if (state.view === "shiftplan" && state.planShiftId) {
        await loadPlan();
        const main = document.querySelector("main");
        if (main) main.innerHTML = renderView();
      }
      if (state.view === "account") await loadProfile();
      if (state.view === "supervisor" && state.superTab === "anmeldungen") await loadAppsAll();
    }, 20000);
  }

  // ---------- Init ----------
  async function init() {
    const token = Auth.getToken();
    if (!token) { render(); return; }
    try {
      const me = await api("GET", "/api/auth/me");
      state.user = me.user;
      document.documentElement.lang = (state.user.language === "en") ? "en" : "de";
      await bootstrapAfterLogin();
      render();
    } catch (e) {
      Auth.clear();
      render();
    }
  }

  window.VBG = {
    setView, setSuperTab, doLogin, doLogout,
    setAnmeldungShift, setAnmeldungArt, setActivityRange,
    setAppFilterNutzer, setAppFilterShift, resetAppFilter,
    toggleNotif, readNotif, readAllNotifs,
    openAnnounce, sendAnnounce, markAnnounceSeen,
    showShiftForm, hideShiftForm, editShift, newShiftFromTpl, saveShift, deleteShift,
    selectPlanShift, openPlan, reloadFromTpl, toggleStops, toggleDutyStops,
    assignDuty, assignDutyVehicle, saveDutyBemerk, editDutyTimes, toggleDutyCancel, deleteDuty,
    assignTrip, assignTripVehicle, toggleTripCancel, toggleTripEdit, toggleStopCancel, addStop,
    submitAnmeldung, withdrawApp,
    addStandort, renameStandort, delStandort, kundenserviceSignup,
    signupActivity,
    showUserForm, createUser, copyPwResult, editUser, saveUserEdit, strafe, resetPw, toggleSuspend, deleteUser,
    showLinieForm, createLinie, editLinie, saveLinie, delLinie,
    addStopRow, removeStopRow,
    acceptApp, denyApp, delApp, acceptWish, denyWish,
    saveProfile, toggleDesktop,
  };

  init();
})();