// Digital logbooks -- the account panel and start screen: sign-in by email,
// and what each role does with the central logbook repository
// (supabase/README.md):
//  - everyone: open the logbook library on this device;
//  - owners: My garage (their cars, each with its public link);
//  - scrutineers: issue a logbook from the open logbook, find a logbook,
//    and work the events they're on the staff of (to inspect / inspected);
//  - Frog Racing admins and technical directors: sanctioning bodies, their
//    scrutineers and licenses, and their events.
// A public link (?logbook=<token>) shows that logbook as its owner allows,
// without signing in.
// Rendered into #accountPanel (added by tools/build-index.js), with its own
// state. The shared app (with CFG.startHidden) keeps the logbook editor
// hidden until this panel shows it, through window.RollcageApp.
(function () {
  const cfg = window.LOGBOOK_SERVER;
  const holder = document.getElementById("accountPanel");
  const app = window.RollcageApp;
  if (!cfg || !holder || !window.supabase) return;
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
    // Implicit flow: the sign-in link works even when the email opens it in
    // another browser than the one that asked for it.
    auth: { flowType: "implicit", persistSession: true, detectSessionInUrl: true },
  });

  const ui = {
    session: null,
    roles: null,          // my_roles(): { email, admin, accreditations, expired }
    garage: [],           // my_garage()
    bodies: [],
    accreditations: [],
    events: [],           // my_events()
    event: null,          // the event open: event_bundle()
    mode: "home",         // the home screen, or a mode: create, library, event, admin (see MODES)
    open: { device: true, garage: true, find: false, events: true, admin: true },
    signIn: { email: "", sent: false, code: "", busy: false },
    message: null,        // { kind: "pass" | "fail", text }
    issued: null,         // the last logbook issued here
    found: null,          // search_logbooks() results
    publicView: null,     // ?logbook= : { token, data }
  };

  // ---- DOM helpers (text only: nothing from the server is parsed as HTML) --
  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k === "value") node.value = v;
      else if (k === "checked") node.checked = !!v;
      else node.setAttribute(k, v === true ? "" : v);
    });
    (children || []).flat(3).forEach((c) => { if (c != null && c !== false) node.append(c.nodeType ? c : String(c)); });
    return node;
  }
  const say = (kind, text) => { ui.message = { kind, text }; render(); };
  const fail = (e) => say("fail", (e && (e.message || e.error_description)) || String(e));
  const field = (label, input) => h("div", { class: "field" }, [h("label", {}, [label]), input]);
  const input = (attrs, onchange) => h("input", Object.assign({ type: "text", oninput: (e) => onchange(e.target.value) }, attrs));
  const dateInput = (value, onchange) => h("input", { type: "date", value, onchange: (e) => onchange(e.target.value) });
  const select = (options, value, onchange) => h("select", { onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h("option", { value: v, selected: v === value }, [label])));
  const btn = (label, onclick, cls) => h("button", { type: "button", class: "btn " + (cls || ""), onclick }, [label]);
  const actions = (...children) => h("div", { class: "account-actions" }, children);
  const desc = (...children) => h("p", { class: "element-desc" }, children);
  function section(key, title, body) {
    const open = ui.open[key];
    return h("div", { class: "account-section" }, [
      h("button", { type: "button", class: "account-section-head", "aria-expanded": String(open), onclick: () => { ui.open[key] = !open; render(); } }, [(open ? "▾ " : "▸ ") + title]),
      open ? h("div", { class: "account-section-body" }, body) : null,
    ]);
  }
  const roleLabel = (a) => a.bodyName + (a.role === "technical_director" ? " technical director" : " scrutineer");
  const fmtDate = (d) => (d ? new Date(d + (String(d).length === 10 ? "T12:00:00" : "")).toLocaleDateString() : "");
  const isoDay = (offsetDays, from) => new Date((from ? Date.parse(from + "T12:00:00") : Date.now()) + offsetDays * 864e5).toISOString().slice(0, 10);
  const carLine = (x) => [x.year, x.make, x.model].filter(Boolean).join(" ");
  const bodyName = (id) => (ui.bodies.find((b) => b.id === id) || {}).name || (id || "").toUpperCase();

  // ---- Server calls ----------------------------------------------------
  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args || {});
    if (error) throw error;
    return data;
  }
  async function loadAll() {
    try {
      ui.roles = await rpc("my_roles");
      ui.garage = await rpc("my_garage");
      await refreshHeads();
      const b = await sb.from("bodies").select("*").order("name");
      if (b.error) throw b.error;
      ui.bodies = b.data;
      if (isStaff()) {
        const a = await sb.from("accreditations").select("*").order("name");
        if (a.error) throw a.error;
        ui.accreditations = a.data;
        ui.events = await rpc("my_events");
        if (ui.event) await openEvent(ui.event.event.id, true);
      }
    } catch (e) { fail(e); }
    render();
  }
  const isStaff = () => ui.roles && (ui.roles.admin || ui.roles.accreditations.length > 0);
  const isOrganizer = (body) => ui.roles && (ui.roles.admin || ui.roles.accreditations.some((a) => a.body === body && a.role === "technical_director"));
  const organizerBodies = () => ui.bodies.filter((b) => isOrganizer(b.id) && !b.disabled_at && !b.deleted_at);

  // ---- Sign-in ---------------------------------------------------------
  async function sendSignIn() {
    const email = ui.signIn.email.trim();
    if (!email.includes("@")) return say("fail", "Enter your email address.");
    ui.signIn.busy = true; render();
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    ui.signIn.busy = false;
    if (error) return fail(error);
    ui.signIn.sent = true; ui.message = null; render();
  }
  async function verifyCode() {
    const { error } = await sb.auth.verifyOtp({ email: ui.signIn.email.trim(), token: ui.signIn.code.trim(), type: "email" });
    if (error) fail(error);
  }
  function renderSignIn() {
    if (ui.signIn.sent) {
      return [
        h("p", {}, ["We sent a sign-in email to ", h("strong", {}, [ui.signIn.email]), ". Open its link on this device, or type the code it contains:"]),
        h("div", { class: "field-row" }, [field("Code", input({ value: ui.signIn.code, inputmode: "numeric", autocomplete: "one-time-code", placeholder: "123456" }, (v) => { ui.signIn.code = v; }))]),
        actions(btn("Sign in", verifyCode), btn("Use another email", () => { ui.signIn.sent = false; ui.signIn.code = ""; render(); }, "secondary")),
      ];
    }
    return [
      desc("Scrutineers and car owners: sign in with your email to issue, update or view logbooks. No password: we email you a sign-in link."),
      h("div", { class: "field-row" }, [
        field("Email", input({ value: ui.signIn.email, inputmode: "email", autocomplete: "email", placeholder: "you@example.com", onkeydown: (e) => { if (e.key === "Enter") sendSignIn(); } }, (v) => { ui.signIn.email = v; })),
      ]),
      actions(h("button", { type: "button", class: "btn", disabled: ui.signIn.busy, onclick: sendSignIn }, [ui.signIn.busy ? "Sending…" : "Email me a sign-in link"])),
    ];
  }

  // ---- Logbooks on this device ------------------------------------------
  function renderDevice() {
    if (!app) return null;
    const shown = app.workspaceShown();
    return h("div", { class: "account-device" }, [
      h("span", { class: "element-desc" }, [shown ? "Logbook open below." : "Logbooks saved on this device:"]),
      btn("Open the logbook library", () => app.openLibrary(), "small secondary"),
      shown ? btn("Hide the logbook", () => app.hideWorkspace(), "small secondary") : null,
    ]);
  }

  // ---- Sync: the library on this device vs the online one ------------------
  // A local logbook linked to its online copy carries vehicle.server:
  // { id, digitalNumber, lastSeq (the last record it has), fingerprint (of
  // its cage answers as last synced), syncedAt, status, issuingBody }.
  // Refreshing replaces the cage with the online one and adds the online
  // event records to its events (photos stay); a scrutineer uploads local
  // cage changes as a signed amendment.
  ui.heads = {};          // logbook id -> { lastSeq, status } (logbook_heads)
  ui.deviceSearch = "";
  ui.busy = null;         // a long sync running: its progress text
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
    return JSON.stringify(v === undefined ? null : v);
  }
  // FNV-1a over the canonical JSON: equal answers, equal fingerprint.
  function fingerprint(answers) {
    let x = 0x811c9dc5;
    const s = stable(answers || {});
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    return x.toString(16).padStart(8, "0");
  }
  const lastSeq = (full) => full.records.reduce((m, r) => Math.max(m, r.seq), 0);
  // The cage as the online logbook has it now: its latest issue or amendment record's.
  const serverCage = (records) => (records.slice().reverse().find((r) => r.body && r.body.cage) || {}).body?.cage || {};
  function toLocal(full, existing) {
    const lb = full.logbook;
    const cage = serverCage(full.records);
    const answers = Object.assign({}, cage.answers || {});
    const bodyNumber = full.bodyNumbers[lb.issuing_body];
    if (bodyNumber && !(answers.vehicle_logbook_number && answers.vehicle_logbook_number.value)) answers.vehicle_logbook_number = { value: bodyNumber, note: "", photos: [], extra: {} };
    const serverEvents = full.records.filter((r) => ["inspection", "post_event", "dnf"].includes(r.kind)).map((r) => ({
      id: "srv_" + r.id, name: r.eventName || "Event", date: String(r.eventStartsOn || r.createdAt).slice(0, 10), driver: (r.body && r.body.driver) || "",
      techResult: r.kind === "dnf" ? "" : r.body && r.body.result === "pass" ? "pass" : r.body && r.body.result === "fail" ? "fail" : "",
      techNotes: (r.body && r.body.notes) || "", scrutineerName: r.authorName || r.authorEmail, scrutineerLicense: r.license || "",
      chiefName: "", chiefLicense: "", damage: null, fromServer: true,
      notes: r.kind === "dnf" ? "DNF" + (r.body && r.body.reason ? ": " + r.body.reason : "") : r.kind === "post_event" ? "Post-event inspection" : "",
    }));
    const keptEvents = existing ? (existing.events || []).filter((e) => !String(e.id).startsWith("srv_")) : [];
    const name = (existing && existing.vehicle && existing.vehicle.name) || lb.car_name || [lb.year, lb.make, lb.model].filter(Boolean).join(" ") || lb.digital_number;
    return {
      sessionId: existing ? existing.sessionId : "srv_" + lb.id,
      vehicle: Object.assign({}, existing && existing.vehicle, {
        name, org: cage.org || lb.issuing_body || "none", logbookDate: String(lb.issued_at).slice(0, 10),
        server: { id: lb.id, digitalNumber: lb.digital_number, lastSeq: lastSeq(full), fingerprint: fingerprint(answers), syncedAt: new Date().toISOString(), status: lb.status, issuingBody: lb.issuing_body },
      }),
      pathId: cage.pathId || "new_construction",
      answers,
      pictures: existing ? existing.pictures || [] : [],
      homologationPhotos: existing ? existing.homologationPhotos || [] : [],
      vehiclePhotos: existing ? existing.vehiclePhotos || { front: null, rear: null } : { front: null, rear: null },
      events: keptEvents.concat(serverEvents),
    };
  }
  const localFor = (id) => app.listLocal().find((s) => s.vehicle && s.vehicle.server && s.vehicle.server.id === id);
  const locallyChanged = (s) => s.vehicle.server && fingerprint(s.answers) !== s.vehicle.server.fingerprint;
  const newerOnline = (s) => { const hd = s.vehicle.server && ui.heads[s.vehicle.server.id]; return !!hd && hd.lastSeq > s.vehicle.server.lastSeq; };
  const openNow = (s) => app.currentSessionId() === s.sessionId;
  async function refreshHeads() {
    if (!app || !ui.session) return;
    const ids = app.listLocal().map((s) => s.vehicle && s.vehicle.server && s.vehicle.server.id).filter(Boolean);
    if (!ids.length) { ui.heads = {}; return; }
    try {
      const heads = await rpc("logbook_heads", { p_ids: ids });
      ui.heads = {};
      heads.forEach((x) => { ui.heads[x.id] = x; });
    } catch (e) { fail(e); }
  }
  // Download (or refresh) a logbook into this device's library. quiet: no message, no re-render.
  async function download(id, quiet) {
    const existing = localFor(id);
    if (existing && openNow(existing) && app.isDirty()) {
      if (!quiet) say("fail", "Save or discard the changes to the logbook open below first.");
      return false;
    }
    if (existing && locallyChanged(existing) && !quiet &&
        !confirm("\"" + existing.vehicle.name + "\" has changes on this device that aren't online. Refreshing replaces them with the online logbook. Refresh anyway?")) return false;
    const full = await rpc("logbook_full", { p_id: id });
    app.saveLocal(toLocal(full, existing));
    ui.heads[id] = { id, lastSeq: lastSeq(full), status: full.logbook.status };
    if (!quiet) say("pass", (existing ? "Refreshed " : "Saved to this device: ") + full.logbook.digital_number + ".");
    return true;
  }
  async function downloadMany(ids, label) {
    let done = 0, skipped = 0;
    for (const id of ids) {
      ui.busy = label + " " + (done + skipped + 1) + " of " + ids.length + "…"; render();
      try {
        const s = localFor(id);
        if (s && (locallyChanged(s) || (openNow(s) && app.isDirty()))) { skipped++; continue; }
        if (await download(id, true)) done++; else skipped++;
      } catch (e) { skipped++; }
    }
    ui.busy = null;
    say(skipped ? "fail" : "pass", done + " logbook" + (done === 1 ? "" : "s") + " on this device up to date" + (skipped ? "; " + skipped + " skipped (changes on this device not online, or couldn't be read)." : "."));
  }
  // A scrutineer's local cage changes, uploaded as a signed amendment.
  async function uploadChanges(s) {
    if (openNow(s) && app.isDirty()) return say("fail", "Save the logbook open below first (Logbook library → Save), then upload.");
    try {
      const full = await rpc("logbook_full", { p_id: s.vehicle.server.id });
      if (lastSeq(full) > s.vehicle.server.lastSeq) {
        return say("fail", "The online logbook has newer records than this copy. Refresh it first -- that replaces the changes made here, so note them before refreshing.");
      }
      const before = serverCage(full.records).answers || {};
      const keys = new Set(Object.keys(before).concat(Object.keys(s.answers || {})));
      const changes = [...keys].filter((k) => stable(before[k]) !== stable((s.answers || {})[k])).sort();
      if (!changes.length) return say("pass", "No cage changes to upload.");
      const note = prompt("Upload " + changes.length + " change" + (changes.length === 1 ? "" : "s") + " to " + s.vehicle.server.digitalNumber + " as a signed amendment.\n\nWhat changed, and why? (recorded with it)", "");
      if (note === null) return;
      const acc = ui.roles.accreditations.find((a) => a.body === s.vehicle.server.issuingBody) || ui.roles.accreditations[0];
      await rpc("add_record", { p_logbook: s.vehicle.server.id, p_kind: "amendment", p_body: { cage: { pathId: s.pathId, org: s.vehicle.org, answers: s.answers }, changes, note }, p_body_id: acc.body });
      const fresh = await rpc("logbook_full", { p_id: s.vehicle.server.id });
      app.saveLocal(toLocal(fresh, s));
      ui.heads[s.vehicle.server.id] = { lastSeq: lastSeq(fresh) };
      say("pass", "Amendment uploaded to " + s.vehicle.server.digitalNumber + ".");
    } catch (e) { fail(e); }
  }
  // A logbook file (from this app, or the owner's Rollcage assessment tool
  // with its pictures): added to this device's library and opened.
  function importFile() {
    app.importFile((sessionId, notice) => { say("pass", notice || "Imported."); });
  }
  function issueOnline(s) {
    app.openLocal(s.sessionId);
    setTimeout(() => goMode("create"), 0);
  }
  // Deleting this device's copy: a stronger warning when that loses
  // something -- a logbook never uploaded, changes not online, or unsaved
  // changes to the one open.
  function deleteLocalLogbook(s) {
    const srv = s.vehicle.server;
    const name = "\"" + (s.vehicle.name || "Unnamed logbook") + "\"";
    const unsaved = openNow(s) && app.isDirty() ? "\n\nIt's open below with unsaved changes: they'd be lost too." : "";
    let warning;
    if (!srv) warning = "WARNING: " + name + " has never been uploaded -- it exists only on this device. Deleting it loses it for good.";
    else if (locallyChanged(s)) warning = "WARNING: " + name + " has changes made on this device that aren't online. Deleting it loses those changes (the online logbook " + srv.digitalNumber + " stays as it is).";
    else if (newerOnline(s)) warning = "Delete this device's copy of " + name + "? It's older than the online logbook " + srv.digitalNumber + ", which stays -- download it again any time.";
    else warning = "Delete this device's copy of " + name + "? The online logbook " + srv.digitalNumber + " stays -- download it again any time.";
    if (!confirm(warning + unsaved + "\n\nPhotos saved with it on this device are deleted too.")) return;
    // Losing something gets a second, explicit confirmation.
    if ((!srv || locallyChanged(s)) && prompt("Type DELETE to confirm deleting " + name + " and what's only on this device.") !== "DELETE") return say("fail", "Not deleted.");
    app.deleteLocal(s.sessionId);
    say("pass", "Deleted " + name + " from this device.");
  }
  function renderSync() {
    if (!app) return [];
    const staff = ui.roles && ui.roles.accreditations.length > 0;
    const all = app.listLocal().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const words = ui.deviceSearch.toLowerCase().split(/\s+/).filter(Boolean);
    const text = (s) => [s.vehicle.name, s.vehicle.server && s.vehicle.server.digitalNumber].concat(
      ["vehicle_manufacturer", "vehicle_model", "vehicle_year", "vehicle_vin", "vehicle_owner_name", "vehicle_logbook_number"].map((k) => (s.answers && s.answers[k] && s.answers[k].value) || "")).join(" ").toLowerCase();
    const list = words.length ? all.filter((s) => words.every((w) => text(s).includes(w))) : all;
    const outOfDate = all.filter((s) => s.vehicle.server && newerOnline(s) && !locallyChanged(s)).map((s) => s.vehicle.server.id);
    const rows = list.map((s) => {
      const srv = s.vehicle.server;
      const changed = locallyChanged(s), newer = newerOnline(s);
      const hd = srv && ui.heads[srv.id];
      const state = !srv ? "Only on this device" : changed && newer ? "Changed here, and newer online" : changed ? "Changed on this device" : newer ? "Newer online" : "Up to date";
      const cls = !srv ? "info" : changed || newer ? "req" : "pass";
      return h("div", { class: "account-entry" }, [
        h("span", { class: "account-entry-main" }, [
          h("strong", {}, [s.vehicle.name || "Unnamed logbook"]), openNow(s) && app.workspaceShown() ? h("span", { class: "element-desc" }, [" (open)"]) : null,
          h("span", { class: "element-desc" }, [" " + [srv && srv.digitalNumber, hd && hd.status && hd.status !== "active" ? hd.status : null, "saved " + new Date(s.updatedAt).toLocaleDateString()].filter(Boolean).join(" · ")]),
        ]),
        h("span", { class: "badge " + cls }, [state]),
        h("span", { class: "account-row-actions" }, [
          btn("View the rollcage", () => app.openLocal(s.sessionId, "rollcage"), "small secondary"),
          srv ? btn("View the event log", () => app.openLocal(s.sessionId, "events"), "small secondary") : null,
          srv && (newer || changed) ? btn("Refresh", () => download(srv.id).catch(fail), "small secondary") : null,
          srv && changed && staff ? btn("Upload changes", () => uploadChanges(s), "small") : null,
          !srv && staff ? btn("Issue online", () => issueOnline(s), "small") : null,
          btn("Delete", () => deleteLocalLogbook(s), "small secondary"),
        ]),
      ]);
    });
    return [
      desc(staff
        ? "Logbooks saved in this browser. Download the logbooks you'll need (from an event, My garage or Find a logbook) before going where there's no signal; upload cage changes made here as an amendment."
        : "Logbooks saved in this browser. Save your car's logbook here to see it offline, and refresh it to get the latest entries. Changes made here aren't uploaded: only a scrutineer can update a logbook."),
      actions(
        btn("Import a file", importFile, "small secondary"),
        btn("Check for updates", () => refreshHeads().then(render), "small secondary"),
        outOfDate.length ? btn("Refresh all (" + outOfDate.length + ")", () => downloadMany(outOfDate, "Refreshing"), "small") : null,
      ),
      ui.busy ? desc(ui.busy) : null,
      all.length > 3 ? h("div", { class: "field-row" }, [field("Search this device", input({ value: ui.deviceSearch, "data-id": "device-search", placeholder: "name, car, VIN, owner, logbook number…" }, (v) => { ui.deviceSearch = v; render(); restoreFocus("device-search"); }))]) : null,
      all.length ? h("div", { class: "account-card" }, rows.length ? rows : [desc("No logbook on this device matches.")]) : desc("No logbooks on this device yet."),
    ];
  }
  // Re-rendering replaces the inputs: keep typing in the one that had focus.
  function restoreFocus(id) {
    const box = holder.querySelector('[data-id="' + id + '"]');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  }

  // ---- My garage ---------------------------------------------------------
  const publicUrl = (token) => location.origin + location.pathname + "?logbook=" + token;
  function vehicleLine(v) { return v ? [v.year, v.make || v.manufacturer, v.model].filter(Boolean).join(" ") || v.name || "" : ""; }
  function renderGarage() {
    if (!ui.garage.length) return [desc("No cars in your garage yet. A logbook appears here once a scrutineer issues it with your email as the owner.")];
    return ui.garage.map((car) => h("div", { class: "account-card" }, [
      h("div", { class: "account-card-title" }, [vehicleLine(car.vehicle) || "Car", " · ", car.digitalNumber]),
      desc([car.vin ? "VIN " + car.vin : "No VIN", bodyName(car.body) + (car.bodyNumbers[car.body] ? " logbook " + car.bodyNumbers[car.body] : ""), car.status].join(" · ")),
      actions(
        app ? btn(localFor(car.id) ? "Refresh on this device" : "Save to this device", () => download(car.id).catch(fail), "small") : null,
        car.publicEnabled ? btn("Copy public link", () => copy(publicUrl(car.publicToken)), "small secondary") : h("span", { class: "element-desc" }, ["Public link off"]),
        h("a", { class: "btn small secondary", href: publicUrl(car.publicToken), target: "_blank", rel: "noopener" }, ["Open public view"]),
      ),
    ]));
  }
  function copy(text) {
    navigator.clipboard.writeText(text).then(() => say("pass", "Link copied."), () => say("fail", "Couldn't copy -- the link is: " + text));
  }

  // ---- Issue a logbook (scrutineers) ------------------------------------
  // Everything comes from the logbook open below (its Part 1 and checklist):
  // the panel only lists what's still missing, and issues it once nothing is.
  const answer = (ans, id) => (ans[id] && typeof ans[id].value === "string" ? ans[id].value.trim() : "");
  // The open logbook's readiness to be issued, with the scrutineer's own
  // check: they must be accredited by its sanctioning body.
  function readiness() {
    const rc = app.currentRollcage();
    const items = app.issueReadiness();
    const accs = ui.roles.accreditations;
    const org = rc.vehicle && rc.vehicle.org;
    if (items[0].done && !accs.some((a) => a.body === org)) {
      items[0] = { label: "Sanctioning body: one you're accredited by (" + accs.map((a) => a.bodyName).join(", ") + ")", done: false, where: "logbook" };
    }
    return items;
  }
  // ARA's logbook number: the scrutineer's 2-digit code, a dash, the last 6 of the VIN.
  function suggestedNumber(rc) {
    const ans = rc.answers || {};
    const acc = ui.roles.accreditations.find((a) => a.body === (rc.vehicle && rc.vehicle.org));
    const vin = answer(ans, "vehicle_vin").toUpperCase();
    return rc.vehicle && rc.vehicle.org === "ara" && acc && acc.code && vin.length >= 6 && !answer(ans, "vehicle_logbook_number") ? acc.code + "-" + vin.slice(-6) : null;
  }
  async function issue(allowDuplicate) {
    const rc = app.currentRollcage();
    const ans = rc.answers || {};
    if (!readiness().every((i) => i.done)) return say("fail", "The logbook isn't complete yet -- see what's missing above.");
    const vehicle = { name: rc.vehicle && rc.vehicle.name, make: answer(ans, "vehicle_manufacturer"), model: answer(ans, "vehicle_model"), year: answer(ans, "vehicle_year") };
    const ownerEmail = answer(ans, "vehicle_owner_email"), ownerName = answer(ans, "vehicle_owner_name");
    const vin = answer(ans, "vehicle_vin").toUpperCase().replace(/\s/g, "");
    if (!allowDuplicate && !confirm("Issue a logbook for " + (carLine(vehicle) || "this car") + (vin ? " (" + vin + ")" : "") + " to " + ownerEmail + "?\n\nThe logbook is recorded as it is now, and the record can't be edited afterwards -- only added to.")) return;
    try {
      ui.issued = await rpc("issue_logbook", { p: {
        vin, body: rc.vehicle.org, ownerEmail, ownerName, bodyNumber: answer(ans, "vehicle_logbook_number"), vehicle, allowDuplicate: !!allowDuplicate,
        record: {
          vehicle,
          owner: { name: ownerName, email: ownerEmail, phone: answer(ans, "vehicle_owner_phone"), address: answer(ans, "vehicle_owner_address") },
          cage: { pathId: rc.pathId, org: rc.vehicle.org, answers: ans },
        },
      } });
      // The logbook on this device becomes the online logbook's local copy.
      app.linkCurrent({ id: ui.issued.id, digitalNumber: ui.issued.digitalNumber, lastSeq: 1, fingerprint: fingerprint(ans), syncedAt: new Date().toISOString(), status: "active", issuingBody: rc.vehicle.org });
      say("pass", "Logbook " + ui.issued.digitalNumber + " issued. The owner can now sign in with " + ownerEmail + " to see it.");
      loadAll();
    } catch (e) {
      const dup = /possible duplicate of (.*)/.exec(e.message || "");
      if (dup && confirm("This looks like a car that already has a logbook: " + dup[1] + ".\n\nIssue anyway, as a different car?")) return issue(true);
      if (!dup) fail(e);
    }
  }
  function renderIssue() {
    const rc = app.currentRollcage();
    if (rc.vehicle && rc.vehicle.server) {
      return [desc("Issued as ", h("strong", {}, [rc.vehicle.server.digitalNumber]), ". Cage changes made to it are uploaded from the Logbook library (Upload changes)."),
        actions(btn("View the event log", () => app.showPart("events"), "small secondary"))];
    }
    const items = readiness();
    const ready = items.every((i) => i.done);
    const suggestion = suggestedNumber(rc);
    return [
      h("ul", { class: "account-checklist" }, items.map((i) => h("li", { class: i.done ? "done" : "todo" }, [
        h("span", { class: "account-check-mark" }, [i.done ? "✓" : "✗"]), " " + i.label + (i.missing ? " -- " + i.missing + " item" + (i.missing === 1 ? "" : "s") + " to answer" : ""),
        !i.done && i.where ? [" ", btn("Go", () => app.jumpTo(i.where), "small secondary")] : null,
        i.label === "Logbook number" && !i.done && suggestion ? [" ", btn("Use " + suggestion, () => app.setAnswer("vehicle_logbook_number", suggestion), "small secondary")] : null,
      ]))),
      actions(
        h("button", { type: "button", class: "btn", disabled: !ready, title: ready ? "" : "Complete everything above first", onclick: () => issue(false) }, ["Issue logbook"]),
        ready ? null : h("span", { class: "element-desc" }, ["Issue logbook is available once everything above is complete."]),
      ),
    ];
  }

  // ---- Find a logbook (scrutineers) ---------------------------------------
  const findForm = { text: "", body: "", make: "", model: "", year: "", owner: "" };
  async function find() {
    try { ui.found = await rpc("search_logbooks", { f: findForm }); render(); } catch (e) { fail(e); }
  }
  async function showRecords(lb) {
    try {
      const r = await sb.from("records").select("seq, kind, created_at, author_email, body").eq("logbook_id", lb.id).order("seq");
      if (r.error) throw r.error;
      lb.records = r.data; render();
    } catch (e) { fail(e); }
  }
  function renderFind() {
    const set = (k) => (v) => { findForm[k] = v; };
    const enter = { onkeydown: (e) => { if (e.key === "Enter") find(); } };
    return [
      h("div", { class: "field-row" }, [
        field("Anything: number, VIN, owner, car…", input(Object.assign({ value: findForm.text }, enter), set("text"))),
        field("Sanctioning body", select([["", "Any"]].concat(ui.bodies.map((b) => [b.id, b.name])), findForm.body, (v) => { findForm.body = v; })),
      ]),
      h("div", { class: "field-row" }, [
        field("Owner", input(Object.assign({ value: findForm.owner }, enter), set("owner"))),
        field("Make", input(Object.assign({ value: findForm.make }, enter), set("make"))),
        field("Model", input(Object.assign({ value: findForm.model }, enter), set("model"))),
        field("Year", input(Object.assign({ value: findForm.year, inputmode: "numeric" }, enter), set("year"))),
      ]),
      actions(btn("Find", find, "secondary")),
      ui.found && !ui.found.length ? desc("No logbook found.") : null,
      ui.found && ui.found.length === 50 ? desc("Showing the 50 most recent -- add filters to narrow it down.") : null,
      (ui.found || []).map((lb) => h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, [carLine(lb) || lb.carName || "Car", " · ", lb.digitalNumber, lb.status !== "active" ? " · " + lb.status : ""]),
        desc([lb.vin ? (lb.hasVin ? "VIN " : "Chassis ") + lb.vin : "No VIN", bodyName(lb.body) + (lb.bodyNumbers[lb.body] ? " logbook " + lb.bodyNumbers[lb.body] : ""),
              "owner " + [lb.ownerName, lb.ownerEmail].filter(Boolean).join(", "), "issued " + fmtDate(lb.issuedAt)].join(" · ")),
        lb.records
          ? h("ol", { class: "account-records" }, lb.records.map((r) => h("li", {}, [r.kind + " -- " + new Date(r.created_at).toLocaleString() + " by " + r.author_email, r.body && (r.body.note || r.body.notes) ? ": " + (r.body.note || r.body.notes) : ""])))
          : null,
        actions(
          lb.records ? null : btn("Show records", () => showRecords(lb), "small secondary"),
          app ? btn(localFor(lb.id) ? "Refresh on this device" : "Save to this device", () => download(lb.id).catch(fail), "small secondary") : null,
          app && localFor(lb.id) ? btn("Open", () => app.openLocal(localFor(lb.id).sessionId), "small secondary") : null,
        ),
      ])),
    ];
  }

  // ---- Events ---------------------------------------------------------------
  const eventForm = { body: "", name: "", location: "", scrutineeringStartsOn: isoDay(0), startsOn: isoDay(1), endsOn: isoDay(2), acceptedBodies: [] };
  const staffForm = { email: "", role: "scrutineer" };
  const entryForm = { carNumber: "", driver: "", codriver: "", class: "", logbook: "", make: "", model: "", year: "" };
  let entryFilter = "";
  async function openEvent(id, quiet) {
    try { ui.event = await rpc("event_bundle", { p_event: id }); } catch (e) { fail(e); }
    if (!quiet) render();
  }
  async function saveEvent() {
    if (!eventForm.name.trim()) return say("fail", "The event needs a name.");
    try {
      const id = await rpc("save_event", { p: eventForm });
      Object.assign(eventForm, { name: "", location: "" });
      say("pass", "Event saved.");
      await loadAll(); await openEvent(id);
    } catch (e) { fail(e); }
  }
  async function addStaff() {
    try { await rpc("set_event_staff", { p_event: ui.event.event.id, p_email: staffForm.email, p_role: staffForm.role }); staffForm.email = ""; await openEvent(ui.event.event.id); }
    catch (e) { fail(e); }
  }
  async function removeStaff(email) {
    try { await rpc("set_event_staff", { p_event: ui.event.event.id, p_email: email, p_role: null }); await openEvent(ui.event.event.id); } catch (e) { fail(e); }
  }
  async function addEntry() {
    if (!entryForm.carNumber.trim()) return say("fail", "The car number is needed.");
    try {
      let logbookId = null;
      if (entryForm.logbook.trim()) {
        const r = await rpc("search_logbooks", { f: { text: entryForm.logbook.trim() } });
        if (r.length !== 1) return say("fail", r.length ? "That matches " + r.length + " logbooks -- use the digital logbook number." : "No logbook matches " + entryForm.logbook + ".");
        logbookId = r[0].id;
      }
      await rpc("save_entry", { p_event: ui.event.event.id, p: {
        carNumber: entryForm.carNumber.trim(), driver: entryForm.driver, codriver: entryForm.codriver, class: entryForm.class, logbookId,
        vehicle: logbookId ? null : { make: entryForm.make, model: entryForm.model, year: entryForm.year },
      } });
      Object.assign(entryForm, { carNumber: "", driver: "", codriver: "", class: "", logbook: "", make: "", model: "", year: "" });
      await openEvent(ui.event.event.id); loadEventsOnly();
    } catch (e) { fail(e); }
  }
  async function loadEventsOnly() { try { ui.events = await rpc("my_events"); render(); } catch (e) { fail(e); } }
  // Interim: pass / fail with notes -- the full tech sheet comes next.
  async function inspect(entry, passed) {
    const notes = prompt((passed ? "Passed" : "Failed") + " -- car " + entry.car_number + ". Notes" + (passed ? " (optional)" : ": what must be fixed") + ":", "");
    if (notes === null) return;
    try {
      await rpc("add_event_record", { p_entry: entry.id, p_kind: "inspection", p_body: { result: passed ? "pass" : "fail", notes }, p_status: passed ? "passed" : "failed" });
      await openEvent(ui.event.event.id); loadEventsOnly();
    } catch (e) { fail(e); }
  }
  function progress(e) {
    const done = e.passed + e.failed;
    return h("div", { class: "account-progress", title: e.passed + " passed, " + e.failed + " failed, " + e.pending + " to inspect" }, [
      h("div", { class: "account-progress-bar" }, [
        h("span", { class: "pass", style: "width:" + (e.cars ? (100 * e.passed) / e.cars : 0) + "%" }),
        h("span", { class: "fail", style: "width:" + (e.cars ? (100 * e.failed) / e.cars : 0) + "%" }),
      ]),
      h("span", { class: "element-desc" }, [e.cars ? done + " of " + e.cars + " cars inspected (" + e.passed + " passed, " + e.failed + " failed) · " + e.pending + " to inspect" : "No competitors yet"]),
    ]);
  }
  // Event cards: in Event mode the events a person works (staff), in Admin
  // mode the ones they organize.
  function renderEventCards(list, emptyText) {
    if (!list.length) return [desc(emptyText)];
    return list.map((e) => h("div", { class: "account-card" + (ui.event && ui.event.event.id === e.id ? " selected" : "") }, [
      h("div", { class: "account-card-title" }, [e.name, " · ", bodyName(e.body), e.open ? " · open" : ""]),
      desc([e.location, "scrutineering " + fmtDate(e.scrutineeringStartsOn), "event " + fmtDate(e.startsOn) + (e.endsOn !== e.startsOn ? " to " + fmtDate(e.endsOn) : ""),
            e.myRole ? (e.myRole === "chief" ? "you: chief scrutineer" : "you: scrutineer") : "organizer"].filter(Boolean).join(" · ")),
      progress(e),
      actions(btn(ui.event && ui.event.event.id === e.id ? "Close" : "Open", () => { if (ui.event && ui.event.event.id === e.id) { ui.event = null; render(); } else openEvent(e.id); }, "small secondary")),
    ]));
  }
  function renderCreateEvent() {
    const bodies = organizerBodies();
    if (!bodies.length) return null;
    if (!bodies.some((b) => b.id === eventForm.body)) eventForm.body = bodies[0].id;
    const set = (k) => (v) => { eventForm[k] = v; };
    return h("div", { class: "account-card" }, [
      h("div", { class: "account-card-title" }, ["Create an event"]),
      h("div", { class: "field-row" }, [
        field("Sanctioning body", select(bodies.map((b) => [b.id, b.name]), eventForm.body, (v) => { eventForm.body = v; render(); })),
        field("Name", input({ value: eventForm.name }, set("name"))),
        field("Location", input({ value: eventForm.location }, set("location"))),
      ]),
      h("div", { class: "field-row" }, [
        field("Scrutineering starts", dateInput(eventForm.scrutineeringStartsOn, set("scrutineeringStartsOn"))),
        field("Event starts", dateInput(eventForm.startsOn, set("startsOn"))),
        field("Event ends", dateInput(eventForm.endsOn, set("endsOn"))),
      ]),
      h("div", { class: "field" }, [
        h("label", {}, ["Also accepts logbooks from"]),
        h("div", { class: "account-checks" }, ui.bodies.filter((b) => b.id !== eventForm.body && !b.deleted_at).map((b) => h("label", {}, [
          h("input", { type: "checkbox", checked: eventForm.acceptedBodies.includes(b.id), onchange: (e) => {
            eventForm.acceptedBodies = e.target.checked ? eventForm.acceptedBodies.concat(b.id) : eventForm.acceptedBodies.filter((x) => x !== b.id);
          } }), " " + b.name,
        ]))),
      ]),
      actions(btn("Create event", saveEvent)),
    ]);
  }
  function renderAddCompetitor() {
    const set = (k) => (v) => { entryForm[k] = v; };
    return h("div", { class: "account-card" }, [
      h("div", { class: "account-card-title" }, ["Add a competitor"]),
      h("div", { class: "field-row" }, [
        field("Car number", input({ value: entryForm.carNumber }, set("carNumber"))),
        field("Driver", input({ value: entryForm.driver }, set("driver"))),
        field("Codriver", input({ value: entryForm.codriver }, set("codriver"))),
        field("Class", input({ value: entryForm.class }, set("class"))),
      ]),
      h("div", { class: "field-row" }, [
        field("Logbook (digital number)", input({ value: entryForm.logbook, placeholder: "leave empty if none" }, set("logbook"))),
        field("or the car: make", input({ value: entryForm.make }, set("make"))),
        field("Model", input({ value: entryForm.model }, set("model"))),
        field("Year", input({ value: entryForm.year }, set("year"))),
      ]),
      actions(btn("Add competitor", addEntry, "small")),
    ]);
  }
  // The open event. kind "scrutineer" (Event mode): download its logbooks,
  // the cars to inspect and the ones inspected. kind "organize" (Admin
  // mode): its staff and competitor list.
  function renderEvent(kind) {
    const b = ui.event;
    if (!b) return null;
    const ev = b.event;
    const organizer = isOrganizer(ev.body_id);
    const myRole = (b.staff.find((s) => s.email === ui.roles.email) || {}).role;
    const open = ui.events.some((e) => e.id === ev.id && e.open);
    const q = entryFilter.trim().toLowerCase();
    const matches = (x) => !q || [x.entry.car_number, x.entry.driver, x.entry.codriver, x.logbook && x.logbook.digital_number, x.logbook && x.logbook.make, x.logbook && x.logbook.model]
      .some((s) => s && String(s).toLowerCase().includes(q));
    const entries = b.entries.filter((x) => x.entry.tech_status !== "withdrawn" && matches(x));
    const carDesc = (x) => (x.logbook ? carLine(x.logbook) + " · " + x.logbook.digital_number : carLine(x.entry.vehicle || {}) + " · no logbook");
    const entryRow = (x, withButtons) => h("div", { class: "account-entry" }, [
      h("span", { class: "account-car-number" }, ["#" + x.entry.car_number]),
      h("span", { class: "account-entry-main" }, [
        h("strong", {}, [[x.entry.driver, x.entry.codriver].filter(Boolean).join(" / ") || "—"]),
        h("span", { class: "element-desc" }, [" " + carDesc(x) + (x.entry.class ? " · " + x.entry.class : "")]),
      ]),
      x.entry.tech_status === "pending"
        ? (withButtons && x.logbook && myRole && open ? h("span", {}, [btn("Passed", () => inspect(x.entry, true), "small"), " ", btn("Failed", () => inspect(x.entry, false), "small secondary")])
          : h("span", { class: "badge info" }, ["to inspect"]))
        : h("span", { class: "badge " + (x.entry.tech_status === "passed" ? "pass" : "req") }, [x.entry.tech_status]),
    ]);
    const filterBox = h("div", { class: "field-row" }, [field("Find a car", input({ value: entryFilter, "data-id": "entry-filter", placeholder: "car number, driver, car…" }, (v) => { entryFilter = v; render(); restoreFocus("entry-filter"); }))]);
    const out = [
      h("h3", { class: "account-event-title" }, [ev.name + " -- " + bodyName(ev.body_id)]),
      desc(["Accepts logbooks from " + ev.accepted_bodies.map(bodyName).join(", "), open ? "open for records" : "not open for records (scrutineering " + fmtDate(ev.scrutineering_starts_on) + " to the day after " + fmtDate(ev.ends_on) + ")"].join(" · ")),
    ];
    if (kind === "organize") {
      out.push(h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, ["Staff"]),
        b.staff.length ? h("ul", { class: "account-records" }, b.staff.map((s) => h("li", {}, [
          s.email + (s.role === "chief" ? " -- chief scrutineer" : ""), organizer ? [" ", btn("Remove", () => removeStaff(s.email), "small secondary")] : null,
        ]))) : desc("No staff yet: add the chief scrutineer and the scrutineers working the event."),
        organizer ? h("div", { class: "field-row" }, [
          field("Email", input({ value: staffForm.email, inputmode: "email" }, (v) => { staffForm.email = v; })),
          field("Role", select([["scrutineer", "Scrutineer"], ["chief", "Chief scrutineer"]], staffForm.role, (v) => { staffForm.role = v; })),
        ]) : null,
        organizer ? actions(btn("Add to staff", addStaff, "small")) : null,
      ]));
      out.push(filterBox);
      out.push(h("div", { class: "account-card" }, [h("div", { class: "account-card-title" }, ["Competitors (" + entries.length + ")"]), entries.length ? entries.map((x) => entryRow(x, false)) : desc("None yet.")]));
      if (organizer || myRole === "chief") out.push(renderAddCompetitor());
      return out;
    }
    const toInspect = entries.filter((x) => x.entry.tech_status === "pending");
    const inspected = entries.filter((x) => x.entry.tech_status !== "pending");
    const withLogbook = b.entries.filter((x) => x.logbook);
    if (withLogbook.length) {
      out.push(actions(btn("Download this event's logbooks to this device (" + withLogbook.length + ")",
        () => downloadMany(withLogbook.map((x) => x.logbook.id), "Downloading"), "small secondary")));
    }
    out.push(filterBox);
    out.push(h("div", { class: "account-card" }, [h("div", { class: "account-card-title" }, ["To inspect (" + toInspect.length + ")"]), toInspect.length ? toInspect.map((x) => entryRow(x, true)) : desc("None.")]));
    out.push(h("div", { class: "account-card" }, [h("div", { class: "account-card-title" }, ["Inspected (" + inspected.length + ")"]), inspected.length ? inspected.map((x) => entryRow(x, true)) : desc("None yet.")]));
    // The chief scrutineer can add a late entry from here too.
    if (myRole === "chief") out.push(renderAddCompetitor());
    return out;
  }

  // ---- Administration (Frog Racing admins, technical directors) -----------
  const bodyForm = { id: "", name: "", note: "" };
  const accForm = { email: "", name: "", body: "", role: "scrutineer", license: "", code: "", expires: "" };
  let adminEmail = "";
  async function saveBody() {
    try { await rpc("save_body", { p_id: bodyForm.id.trim().toLowerCase(), p_name: bodyForm.name.trim(), p_number_note: bodyForm.note.trim() || null }); Object.assign(bodyForm, { id: "", name: "", note: "" }); say("pass", "Sanctioning body saved."); loadAll(); }
    catch (e) { fail(e); }
  }
  async function grant() {
    try {
      await rpc("grant_accreditation", { p_email: accForm.email, p_name: accForm.name, p_body: accForm.body, p_role: accForm.role, p_license: accForm.license || null, p_code: accForm.code || null, p_expires: accForm.expires || null });
      Object.assign(accForm, { email: "", name: "", license: "", code: "", expires: "" });
      say("pass", "Accreditation saved."); loadAll();
    } catch (e) { fail(e); }
  }
  // Renew (a license that expires): a new date, a year after the current
  // one by default. Set expiry (one that doesn't): start expiring. Either
  // way, an empty date means the license doesn't expire.
  async function renew(a) {
    const from = a.license_expires && a.license_expires > isoDay(0) ? a.license_expires : isoDay(0);
    const date = prompt((a.license_expires ? "New license expiry date for " + a.name + " (now " + fmtDate(a.license_expires) + ")" : "License expiry date for " + a.name + " (no expiry now)") +
      " -- YYYY-MM-DD, or leave empty for a license that doesn't expire:", isoDay(365, from));
    if (date === null) return;
    const d = date.trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return say("fail", "Use the YYYY-MM-DD format, e.g. " + isoDay(365) + ".");
    try {
      await rpc("renew_license", { p_id: a.id, p_expires: d || null });
      say("pass", a.name + "'s license " + (d ? "now expires " + fmtDate(d) : "no longer expires") + ".");
      loadAll();
    } catch (e) { fail(e); }
  }
  async function setAccState(a, state) {
    const verb = { disabled: "Disable", deleted: "Delete", active: "Re-enable" }[state];
    if (state !== "active" && !confirm(verb + " " + a.name + " (" + a.email + ") for " + bodyName(a.body_id) + "?\n\nRecords they already signed stay valid.")) return;
    try { await rpc("set_accreditation_state", { p_id: a.id, p_state: state }); loadAll(); } catch (e) { fail(e); }
  }
  async function setBodyState(b, state) {
    if (state !== "active" && !confirm(({ disabled: "Disable", deleted: "Delete" })[state] + " " + b.name + "? Its scrutineers can't sign anything new while it is.")) return;
    try { await rpc("set_body_state", { p_id: b.id, p_state: state }); loadAll(); } catch (e) { fail(e); }
  }
  async function addAdmin() {
    try { await rpc("add_admin", { p_email: adminEmail }); adminEmail = ""; say("pass", "Admin added."); } catch (e) { fail(e); }
  }
  function renderAdmin() {
    const admin = ui.roles.admin;
    const tdBodies = ui.roles.accreditations.filter((a) => a.role === "technical_director").map((a) => a.body);
    const manageable = admin ? ui.bodies : ui.bodies.filter((b) => tdBodies.includes(b.id));
    if (!manageable.some((b) => b.id === accForm.body) && manageable.length) accForm.body = manageable[0].id;
    const today = isoDay(0);
    const status = (x) => (x.deleted_at ? "deleted" : x.disabled_at ? "disabled" : x.license_expires && x.license_expires < today ? "license expired" : "active");
    const out = [];
    manageable.forEach((b) => {
      const people = ui.accreditations.filter((a) => a.body_id === b.id && (admin || !a.deleted_at));
      out.push(h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, [b.name + " (" + b.id + ")" + (status(b) !== "active" ? " -- " + status(b) : "")]),
        b.logbook_number_note ? desc("Logbook numbers: " + b.logbook_number_note) : null,
        admin ? actions(status(b) === "active" ? btn("Disable body", () => setBodyState(b, "disabled"), "small secondary") : btn("Re-enable body", () => setBodyState(b, "active"), "small secondary")) : null,
        people.length ? h("table", { class: "account-table" }, [
          h("tr", {}, ["Name", "Email", "Role", "License", "Expires", "Code", "Status", ""].map((t) => h("th", {}, [t]))),
          people.map((a) => {
            const canManage = admin || a.role === "scrutineer";
            const st = status(a);
            return h("tr", {}, [
              h("td", {}, [a.name]), h("td", {}, [a.email]), h("td", {}, [a.role === "technical_director" ? "Technical director" : "Scrutineer"]),
              h("td", {}, [a.license_number || ""]), h("td", {}, [a.license_expires ? fmtDate(a.license_expires) : "—"]), h("td", {}, [a.scrutineer_code || ""]),
              h("td", { class: st === "active" ? "" : "account-warn" }, [st]),
              h("td", { class: "account-row-actions" }, canManage ? [
                btn(a.license_expires ? "Renew" : "Set expiry", () => renew(a), "small secondary"),
                st === "disabled" || st === "deleted"
                  ? btn("Re-enable", () => setAccState(a, "active"), "small secondary")
                  : [btn("Disable", () => setAccState(a, "disabled"), "small secondary"), btn("Delete", () => setAccState(a, "deleted"), "small secondary")],
              ] : []),
            ]);
          }),
        ]) : desc("No scrutineers yet."),
      ]));
    });
    if (manageable.length) {
      const set = (k) => (v) => { accForm[k] = v; };
      out.push(h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, [admin ? "Add a technical director or scrutineer" : "Add a scrutineer"]),
        h("div", { class: "field-row" }, [field("Name", input({ value: accForm.name }, set("name"))), field("Email", input({ value: accForm.email, inputmode: "email" }, set("email")))]),
        h("div", { class: "field-row" }, [
          field("Sanctioning body", select(manageable.map((b) => [b.id, b.name]), accForm.body, (v) => { accForm.body = v; })),
          admin ? field("Role", select([["scrutineer", "Scrutineer"], ["technical_director", "Technical director"]], accForm.role, (v) => { accForm.role = v; })) : null,
          field("License number", input({ value: accForm.license }, set("license"))),
        ]),
        h("div", { class: "field-row" }, [
          field("License expires (optional)", dateInput(accForm.expires, set("expires"))),
          field("Scrutineer code", input({ value: accForm.code, placeholder: "e.g. ARA 2-digit number" }, set("code"))),
        ]),
        actions(btn("Save", grant)),
      ]));
    }
    if (admin) {
      const set = (k) => (v) => { bodyForm[k] = v; };
      out.push(h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, ["Add or rename a sanctioning body"]),
        h("div", { class: "field-row" }, [field("Short id", input({ value: bodyForm.id, placeholder: "e.g. ara" }, set("id"))), field("Name", input({ value: bodyForm.name, placeholder: "e.g. American Rally Association" }, set("name")))]),
        h("div", { class: "field-row" }, [field("How it numbers logbooks", input({ value: bodyForm.note, placeholder: "e.g. scrutineer code + last 6 of the VIN" }, set("note")))]),
        actions(btn("Save body", saveBody)),
      ]));
      out.push(h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, ["Add a Frog Racing admin"]),
        h("div", { class: "field-row" }, [field("Email", input({ value: adminEmail, inputmode: "email" }, (v) => { adminEmail = v; }))]),
        actions(btn("Add admin", addAdmin)),
      ]));
    }
    return out;
  }

  // ---- Public view (?logbook=<token>) --------------------------------------
  async function loadPublic(token) {
    ui.publicView = { token, data: undefined };
    render();
    try { ui.publicView.data = await rpc("public_logbook", { p_token: token }); } catch (e) { fail(e); }
    render();
  }
  function renderPublic() {
    const d = ui.publicView.data;
    if (d === undefined) return desc("Loading the logbook…");
    if (!d) return h("p", { class: "verdict fail" }, ["This logbook link isn't valid or has been turned off by the owner."]);
    const issueRec = d.records.find((r) => r.kind === "issue");
    const v = issueRec && issueRec.body.vehicle;
    return h("div", {}, [
      h("div", { class: "account-card-title" }, [vehicleLine(v) || "Logbook", " · ", d.digitalNumber]),
      desc([d.bodyName + (d.bodyNumbers[d.body] ? " logbook " + d.bodyNumbers[d.body] : ""), d.vin ? "VIN " + d.vin : null, "status: " + d.status, "issued " + fmtDate(d.issuedAt)].filter(Boolean).join(" · ")),
      issueRec && issueRec.body.owner ? desc("Owner: " + [issueRec.body.owner.name, issueRec.body.owner.email].filter(Boolean).join(", ")) : null,
      h("ol", { class: "account-records" }, d.records.map((r) => h("li", {}, [
        r.kind + " -- " + new Date(r.createdAt).toLocaleDateString() + " by " + r.author + (r.license ? " (" + r.authorBody.toUpperCase() + " " + r.license + ")" : ""),
        r.body && (r.body.note || r.body.notes) ? ": " + (r.body.note || r.body.notes) : "",
      ]))),
    ]);
  }

  // ---- Home: the modes ------------------------------------------------------
  // Like PassTech's landing page: one card per mode the person can use.
  const MODES = {
    create: { title: "Create a new logbook", text: "Record a car's roll cage after its inspection, then issue its logbook online." },
    library: { title: "Logbook library", text: "Logbooks on this device and online: search, open, download, sync, delete." },
    event: { title: "Event mode", text: "Scrutineering at an event: download its logbooks, inspect each car, track what's left." },
    admin: { title: "Admin mode", text: "Sanctioning bodies, scrutineers and their licenses, and events." },
  };
  function availableModes() {
    const r = ui.roles;
    const staff = r && r.accreditations.length > 0;
    const organizer = r && (r.admin || r.accreditations.some((a) => a.role === "technical_director"));
    return ["create", "library"].concat(staff ? ["event"] : [], organizer ? ["admin"] : []);
  }
  // The home screen shows the modes only; Event and Admin modes don't use
  // the logbook editor, and the library starts on its list -- each hides it.
  function goMode(mode) {
    if (mode !== "create" && app) app.hideWorkspace();
    ui.mode = mode; ui.message = null; render();
    holder.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function renderHome() {
    const open = ui.events.filter((e) => e.open && e.myRole).length;
    const badge = { library: ui.garage.length ? ui.garage.length + " in your garage" : null, event: open ? open + " open now" : null };
    return h("div", { class: "account-modes" }, availableModes().map((m, i) => h("button", { type: "button", class: "account-mode", onclick: () => goMode(m) }, [
      h("span", { class: "account-mode-number" }, [String(i + 1)]),
      h("span", { class: "account-mode-title" }, [MODES[m].title]),
      h("span", { class: "account-mode-text" }, [MODES[m].text]),
      badge[m] ? h("span", { class: "badge info" }, [badge[m]]) : null,
    ])));
  }
  function modeHeader(m) {
    return h("div", { class: "account-mode-header" }, [btn("← Home", () => goMode("home"), "small secondary"), h("h2", {}, [MODES[m].title])]);
  }
  // The logbook open below: its name and number, and saving it here.
  function openLogbookBar(extra) {
    const rc = app.currentRollcage();
    const srv = rc.vehicle && rc.vehicle.server;
    return h("div", { class: "account-open-bar" }, [
      h("span", { class: "account-open-name" }, [h("strong", {}, [(rc.vehicle && rc.vehicle.name) || "Unnamed logbook"]), srv ? " · " + srv.digitalNumber : " · not issued yet",
        app.isDirty() ? h("span", { class: "element-desc" }, [" · unsaved changes"]) : null]),
      h("span", { class: "account-row-actions" }, [
        btn("Save on this device", () => { app.save(); setTimeout(render, 0); }, app.isDirty() ? "small" : "small secondary"),
        btn("Export to a file", () => app.exportFile(), "small secondary"),
      ].concat(extra || [])),
    ]);
  }
  function renderCreate() {
    const staff = ui.roles.accreditations.length > 0;
    const startButtons = actions(
      btn("Start a blank logbook", () => app.newLogbook(), "small"),
      btn("Start from a cage template", () => app.openLibrary(), "small secondary"),
      btn("Import a file", importFile, "small secondary"),
    );
    if (!app.workspaceShown()) {
      return [
        desc(staff
          ? "Start the logbook -- blank, from a cage template, or from a file the owner prepared in the Rollcage assessment tool (with its pictures and diagrams) -- then record the cage and the logbook information below, and issue it once complete."
          : "Prepare your car's logbook -- blank, from a cage template, or from a file you made in the Rollcage assessment tool. A scrutineer issues it after inspecting the car: bring this device, or send them the file."),
        startButtons,
      ];
    }
    return [
      openLogbookBar(),
      staff
        ? h("div", { class: "account-card" }, [h("div", { class: "account-card-title" }, ["Ready to issue?"]), renderIssue()])
        : desc("When it's complete, a scrutineer issues it after inspecting the car: bring this device, or send them the file (Export to a file)."),
      h("details", { class: "account-more" }, [h("summary", {}, ["Start another logbook"]), startButtons]),
    ];
  }
  // The library's list, or -- once a logbook is open below -- a bar with
  // what to view (like the Rollcage library button in the rollcage app).
  function renderLibrary() {
    if (app.workspaceShown()) {
      const rc = app.currentRollcage();
      const issued = rc.vehicle && rc.vehicle.server;
      return [openLogbookBar([
        btn("View the rollcage", () => app.showPart("rollcage"), "small secondary"),
        issued ? btn("View the event log", () => app.showPart("events"), "small secondary") : null,
        btn("Logbook library", () => goMode("library"), "small secondary"),
      ])];
    }
    const out = [section("device", "On this device (" + app.listLocal().length + ")", renderSync())];
    if (ui.garage.length || !isStaff()) out.push(section("garage", "My garage (" + ui.garage.length + ")", renderGarage()));
    if (ui.roles.accreditations.length) out.push(section("find", "Find a logbook online", renderFind()));
    return out;
  }
  function renderModeView(m) {
    const out = [modeHeader(m)];
    if (m === "create") out.push(renderCreate());
    if (m === "library") out.push(renderLibrary());
    if (m === "event") {
      out.push(renderEventCards(ui.events.filter((e) => e.myRole), "No events yet: the events you're on the staff of show here."));
      out.push(renderEvent("scrutineer"));
    }
    if (m === "admin") {
      out.push(section("events", "Events", [
        renderEventCards(ui.events.filter((e) => e.organizer), "No events yet."),
        ui.event && ui.events.some((e) => e.id === ui.event.event.id && e.organizer) ? renderEvent("organize") : null,
        renderCreateEvent(),
      ]));
      out.push(section("admin", "Sanctioning bodies and scrutineers", renderAdmin()));
    }
    return out;
  }

  // ---- Panel ---------------------------------------------------------------
  function render() {
    const children = [];
    if (ui.publicView) {
      children.push(h("h2", {}, ["Logbook"]), renderPublic(), actions(h("a", { class: "btn small secondary", href: location.pathname }, ["Close"])));
    } else if (!ui.session) {
      children.push(h("h2", {}, ["Sign in"]), renderSignIn(), renderDevice());
    } else {
      const r = ui.roles;
      children.push(h("div", { class: "account-bar" }, [
        h("span", {}, ["Signed in as ", h("strong", {}, [ui.session.user.email])]),
        r ? h("span", { class: "account-roles" }, [
          r.admin ? h("span", { class: "badge rec" }, ["Frog Racing admin"]) : null,
          r.accreditations.map((a) => h("span", { class: "badge info", title: a.licenseExpires ? "License expires " + fmtDate(a.licenseExpires) : "" }, [roleLabel(a)])),
        ]) : null,
        btn("Sign out", () => sb.auth.signOut(), "small secondary"),
      ]));
      if (r) {
        (r.expired || []).forEach((x) => children.push(h("p", { class: "verdict warn" }, ["Your " + x.bodyName + " license expired on " + fmtDate(x.licenseExpires) + ": ask your technical director to renew it."])));
        if (!availableModes().includes(ui.mode)) ui.mode = "home";
        if (ui.mode === "home" || !app) children.push(renderHome());
        else children.push(renderModeView(ui.mode));
      }
    }
    if (ui.message) children.push(h("p", { class: ui.message.kind === "pass" ? "library-notice" : "verdict fail", title: "Click to dismiss", onclick: () => { ui.message = null; render(); } }, [ui.message.text]));
    holder.replaceChildren(h("div", { class: "panel account-panel" }, children));
  }

  sb.auth.onAuthStateChange((event, session) => {
    const was = ui.session && ui.session.user.id;
    ui.session = session;
    if (!session) { ui.roles = null; ui.garage = []; ui.accreditations = []; ui.events = []; ui.event = null; render(); return; }
    // (Deferred: a server call made inside this callback can deadlock the client.)
    if (was !== session.user.id) setTimeout(loadAll, 0); else render();
  });
  // The shared app re-renders on its own: follow along (what's open, saved,
  // and still missing before issuing) after each click or change -- except
  // in this panel's own fields, where re-rendering would replace the input
  // being typed in.
  let pendingRender = null;
  const followApp = (e) => {
    if (holder.contains(e.target) && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    clearTimeout(pendingRender);
    pendingRender = setTimeout(render, 150);
  };
  document.addEventListener("click", followApp);
  document.addEventListener("change", followApp);
  // The session bar's library button opens this panel's library (signed
  // in), or the library window (signed out).
  if (app && app.setLibraryHandler) app.setLibraryHandler(() => (ui.session ? goMode("library") : app.openLibrary()));
  const token = new URLSearchParams(location.search).get("logbook");
  if (token) loadPublic(token); else render();
})();
