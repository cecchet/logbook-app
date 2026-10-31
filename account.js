// Digital logbooks -- the account panel and start screen: sign-in by email,
// and what each role does with the central logbook repository
// (supabase/README.md):
//  - everyone: open the logbook library on this device;
//  - owners: My garage (their cars, each with its public link);
//  - scrutineers: issue a logbook from the open logbook, find a logbook,
//    and work the events they're on the staff of (to inspect / inspected);
//  - System admins and technical directors: sanctioning bodies, their
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
  // A weak connection (an event's paddock) mustn't hang a call for minutes: past the timeout it
  // fails like no connection, and the Scrutineering site works offline (see Working offline).
  const timedFetch = (url, opts) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), /\/storage\//.test(String(url)) ? 90000 : 20000);
    if (opts && opts.signal) opts.signal.addEventListener("abort", () => ctl.abort());
    return fetch(url, Object.assign({}, opts, { signal: ctl.signal })).finally(() => clearTimeout(timer));
  };
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
    // Implicit flow: the sign-in link works even when the email opens it in
    // another browser than the one that asked for it.
    auth: { flowType: "implicit", persistSession: true, detectSessionInUrl: true },
    global: { fetch: timedFetch },
  });

  const ui = {
    session: null,
    roles: null,          // my_roles(): { email, admin, accreditations, expired }
    garage: [],           // my_garage()
    bodies: [],
    accreditations: [],
    events: [],           // my_events()
    event: null,          // the event open: event_bundle()
    mode: "home",         // the home screen, or a mode: create, library, event, events, bodies (see MODES)
    eventTab: "competitors", // the organizer's open event: "competitors" or "admin"
    body: null,           // Sanctioning bodies: the body open (its id), and its tab
    bodyTab: "scrutineers",
    show: {},             // forms opened by their button: createEvent, addCompetitor, msrImport, addAcc, addBody, addAdmin
    open: { device: true, garage: true, find: false, events: true, admin: true },
    signIn: { email: "", sent: false, code: "", busy: false },
    message: null,        // { kind: "pass" | "fail", text }
    issued: null,         // the last logbook issued here
    found: null,          // search_logbooks() results
    publicView: null,     // ?logbook= : { token, data }
    stickerView: null,    // ?s= (a scanned tech sticker): { code, data, catalog }
  };
  // Working offline (offline.js; see "Working offline" below): this device's store, and
  //   on: no connection now (working from the offline copy); copies: { eventId: what's downloaded };
  //   queue: changes waiting to sync, in order; codes: { eventId: reserved sticker codes }.
  const Store = window.OfflineStore || null;
  const off = { on: false, copies: {}, queue: [], codes: {}, syncing: false };

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
  const bodyCode = (id) => (id || "").toUpperCase();
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
      // Each body's disciplines (none: the body works as one).
      const d = await sb.from("body_disciplines").select("*").order("position");
      ui.disciplines = d.error ? [] : d.data;
      if (isStaff()) {
        const a = await sb.from("accreditations").select("*").order("name");
        if (a.error) throw a.error;
        ui.accreditations = a.data;
        ui.events = await rpc("my_events");
        // Tech sheet templates: the automatic ones (from the rulesets) and every body's own.
        const tt = await sb.from("tech_sheet_templates").select("*").order("title");
        ui.techTemplates = tt.error ? [] : tt.data;
        if (ui.event) await openEvent(ui.event.event.id, true);
      }
      off.on = false;
      saveSnapshot();
      loadOfflineState().then(syncQueue);
    } catch (e) {
      // No connection: what this device kept from the last time online.
      if (isNetworkError(e) && await loadSnapshot(me())) {
        off.on = true;
        await loadOfflineState();
        if (ui.event) await openEvent(ui.event.event.id, true);
      } else fail(e);
    }
    render();
  }
  const isStaff = () => ui.roles && (ui.roles.admin || ui.roles.accreditations.length > 0);
  const isOrganizer = (body) => ui.roles && (ui.roles.admin || ui.roles.accreditations.some((a) => a.body === body && a.role === "technical_director"));
  const organizerBodies = () => ui.bodies.filter((b) => isOrganizer(b.id) && !b.disabled_at && !b.deleted_at);
  // ---- Permissions (supabase/migrations/20261025000100_scrutineer_permissions.sql) ----
  // A technical director holds them all; a scrutineer, the five work ones unless their
  // accreditation lists its own. my_roles() gives each of the caller's accreditations its permissions.
  const PERMISSIONS = [
    ["add_scrutineers", "Add scrutineers"], ["renew_licenses", "Renew licenses / disable"], ["edit_permissions", "Edit permissions"],
    ["delete_scrutineers", "Delete scrutineers"], ["issue_annual_stickers", "Issue annual stickers"], ["void_stickers", "Void stickers"],
    ["sign_off_tech_sheets", "Sign off tech sheets"], ["issue_logbooks", "Issue logbooks"], ["add_logbook_entries", "Add logbook entries"],
  ];
  const ALL_PERMISSIONS = PERMISSIONS.map(([p]) => p);
  const DEFAULT_SCRUTINEER = ["issue_annual_stickers", "void_stickers", "sign_off_tech_sheets", "issue_logbooks", "add_logbook_entries"];
  const MANAGE = ["add_scrutineers", "renew_licenses", "edit_permissions", "delete_scrutineers"];
  // ---- Disciplines (supabase/migrations/20261026000000_disciplines.sql) ----
  // A body's disciplines (SCCNH: Autocross, Gravel Trials...): its events, scrutineers and annual
  // stickers can be one discipline's. An accreditation's discipline null: all of the body's.
  const disciplinesOf = (body) => (ui.disciplines || []).filter((d) => d.body_id === body && !d.archived_at);
  const disciplineName = (body, id) => (id ? ((ui.disciplines || []).find((d) => d.body_id === body && d.id === id) || {}).name || id : "");
  // The caller's permissions with a body: in any of its disciplines (myPermissions), or in one
  // discipline -- its accreditations and the all-disciplines one; for null, the all-disciplines
  // ones only (myPermissionsIn). Every one for a System admin -- like the server.
  const union = (accs) => [...new Set(accs.flatMap((a) => a.permissions || []))];
  const myAccs = (body) => (ui.roles ? ui.roles.accreditations.filter((a) => a.body === body) : []);
  const myPermissions = (body) => (ui.roles && ui.roles.admin ? ALL_PERMISSIONS : union(myAccs(body)));
  const myPermissionsIn = (body, disc) => (ui.roles && ui.roles.admin ? ALL_PERMISSIONS : union(myAccs(body).filter((a) => !a.discipline || (disc && a.discipline === disc))));
  const can = (body, perm) => myPermissions(body).includes(perm);
  const canIn = (body, disc, perm) => myPermissionsIn(body, disc || null).includes(perm);
  const canAnywhere = (perm) => !!ui.roles && (ui.roles.admin || ui.roles.accreditations.some((a) => (a.permissions || []).includes(perm)));
  // The accreditation the caller signs with for a body's discipline: that discipline's, else the
  // all-disciplines one (else any of theirs -- e.g. working another body's event).
  const signerFor = (body, disc) => {
    const mine = myAccs(body);
    return mine.find((a) => disc && a.discipline === disc) || mine.find((a) => !a.discipline) || (disc ? null : mine[0]) || (ui.roles ? ui.roles.accreditations[0] : null);
  };
  // An accreditation row's permissions (the accreditations table: role, permissions).
  const accPermissions = (a) => (a.role === "technical_director" ? ALL_PERMISSIONS : a.permissions || DEFAULT_SCRUTINEER);
  // Whether the caller may change this accreditation: an admin, or someone holding every permission
  // it holds in its discipline -- never a technical director's, nor their own (the server checks the same).
  const canChange = (a) => ui.roles.admin || (a.role !== "technical_director" && a.email !== ui.roles.email && accPermissions(a).every((p) => canIn(a.body_id, a.discipline, p)));

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
  // its cage answers and photos as last synced), syncedAt, status,
  // issuingBody }. Refreshing replaces the cage and its photos with the
  // online ones and adds the online event records to its events; a
  // scrutineer uploads local changes as a signed amendment.
  // Photos: the online ones are named by their SHA-256 (see the photos
  // migration); a local picture that's online keeps it as sha256 (and its
  // parts snapshot's as screenshotSha256).
  ui.heads = {};          // logbook id -> { lastSeq, status } (logbook_heads)
  ui.deviceSearch = "";
  ui.busy = null;         // a long sync running: its progress text
  const PHOTO_BUCKET = "logbook-photos";
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
    return JSON.stringify(v === undefined ? null : v);
  }
  // FNV-1a over the canonical JSON: equal content, equal fingerprint.
  function fingerprint(value) {
    let x = 0x811c9dc5;
    const s = stable(value || {});
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    return x.toString(16).padStart(8, "0");
  }
  // What a sync compares: the cage answers and the photos (a photo not
  // online yet counts by its local id).
  function syncKey(s) {
    return {
      answers: s.answers || {},
      pictures: (s.pictures || []).map((p) => [p.sha256 || "local:" + p.id, p.category || "", p.elements || []]),
      vehicle: ["front", "rear"].map((slot) => { const v = (s.vehiclePhotos || {})[slot]; return v ? v.sha256 || "local:" + v.id : null; }),
      paper: (s.paperLogbookPhotos || []).map((p) => p.sha256 || "local:" + p.id),
    };
  }
  const lastSeq = (full) => full.records.reduce((m, r) => Math.max(m, r.seq), 0);
  // The latest record carrying a field (the cage, the photos...).
  const latestWith = (records, key) => (records.slice().reverse().find((r) => r.body && r.body[key]) || {}).body || null;
  // The cage as the online logbook has it now: its latest issue or amendment record's.
  const serverCage = (records) => (latestWith(records, "cage") || {}).cage || {};

  // ---- Photos up and down ----
  const uploaded = new Set(); // hashes already sent this session
  async function sha256Hex(blob) {
    const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const dataUrlToBlob = (url) => fetch(url).then((r) => r.blob());
  const blobToDataUrl = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
  // known: the hash it had when last uploaded (no upload if it's the same).
  async function uploadDataUrl(dataUrl, known) {
    const blob = await dataUrlToBlob(dataUrl);
    const sha = await sha256Hex(blob);
    if (sha !== known && !uploaded.has(sha)) {
      const { error } = await sb.storage.from(PHOTO_BUCKET).upload(sha, blob, { contentType: blob.type || "image/jpeg", upsert: false });
      // Already there (the same photo, uploaded before): fine.
      if (error && !/exist|duplicate/i.test(error.message || "") && String(error.statusCode) !== "409") throw error;
      uploaded.add(sha);
    }
    return sha;
  }
  async function downloadDataUrl(sha) {
    const { data, error } = await sb.storage.from(PHOTO_BUCKET).download(sha);
    if (error) throw error;
    return blobToDataUrl(data);
  }
  // Uploads a saved logbook's photos (those not online yet). Returns what
  // a record lists -- { pictures, vehiclePhotos } -- and shaById (a photo's
  // id -> its hash; "<id>:shot" for its parts snapshot) to keep locally.
  async function uploadPhotos(s) {
    const shaById = {}, pictures = [], vehiclePhotos = {}, paperPages = [];
    const slots = ["front", "rear"].filter((slot) => (s.vehiclePhotos || {})[slot]);
    const total = (s.pictures || []).length + slots.length + (s.paperLogbookPhotos || []).length;
    let n = 0;
    const step = () => { ui.busy = "Uploading photos: " + (++n) + " of " + total + "…"; render(); };
    for (const p of s.pictures || []) {
      step();
      const rec = await app.getPhoto(p.id);
      if (!rec || !rec.photo) continue;
      const sha = p.sha256 || await uploadDataUrl(rec.photo);
      // (The parts snapshot is redrawn when the tags change: hashed again.)
      const shot = p.hasScreenshot && rec.screenshot ? await uploadDataUrl(rec.screenshot, p.screenshotSha256) : null;
      shaById[p.id] = sha;
      if (shot) shaById[p.id + ":shot"] = shot;
      pictures.push(Object.assign({ sha256: sha, category: p.category || "overview", elements: p.elements || [] }, shot ? { screenshotSha256: shot } : {}));
    }
    for (const slot of slots) {
      step();
      const v = s.vehiclePhotos[slot];
      const rec = await app.getPhoto(v.id);
      if (!rec || !rec.photo) continue;
      const sha = v.sha256 || await uploadDataUrl(rec.photo);
      shaById[v.id] = sha;
      vehiclePhotos[slot] = { sha256: sha };
    }
    // The paper logbook's pages.
    for (const p of s.paperLogbookPhotos || []) {
      step();
      const rec = await app.getPhoto(p.id);
      if (!rec || !rec.photo) continue;
      const sha = p.sha256 || await uploadDataUrl(rec.photo);
      shaById[p.id] = sha;
      paperPages.push({ sha256: sha });
    }
    ui.busy = null;
    return { pictures, vehiclePhotos, paperPages, shaById };
  }
  // A saved logbook with its photos' hashes, once uploaded (so a refresh
  // from the server reuses them instead of downloading them again).
  function withShas(s, shaById) {
    const stamp = (p) => p && shaById[p.id] ? Object.assign({}, p, { sha256: shaById[p.id] }, shaById[p.id + ":shot"] ? { screenshotSha256: shaById[p.id + ":shot"] } : {}) : p;
    const vp = s.vehiclePhotos || {};
    return Object.assign({}, s, { pictures: (s.pictures || []).map(stamp), vehiclePhotos: { front: stamp(vp.front) || null, rear: stamp(vp.rear) || null },
      paperLogbookPhotos: (s.paperLogbookPhotos || []).map(stamp) });
  }
  // The online photos as local ones: a photo already on this device (same
  // hash) is reused, the others are downloaded into it.
  async function photosToLocal(full, existing) {
    const known = new Map();
    (existing && existing.pictures || []).forEach((p) => { if (p.sha256) known.set(p.sha256, p); });
    const vpKnown = new Map();
    ["front", "rear"].forEach((slot) => { const v = existing && existing.vehiclePhotos && existing.vehiclePhotos[slot]; if (v && v.sha256) vpKnown.set(v.sha256, v); });
    const withPictures = latestWith(full.records, "pictures");
    const withVehicle = latestWith(full.records, "vehiclePhotos");
    // A logbook issued without photos keeps the ones on this device.
    let pictures = existing ? existing.pictures || [] : [];
    let vehiclePhotos = existing ? existing.vehiclePhotos || { front: null, rear: null } : { front: null, rear: null };
    const wanted = (withPictures ? withPictures.pictures.length : 0) + (withVehicle ? Object.values(withVehicle.vehiclePhotos).filter(Boolean).length : 0);
    let n = 0;
    const step = () => { ui.busy = "Downloading photos: " + (++n) + " of " + wanted + "…"; render(); };
    if (withPictures) {
      pictures = [];
      for (const sp of withPictures.pictures) {
        step();
        const have = known.get(sp.sha256);
        if (have) { pictures.push(Object.assign({}, have, { category: sp.category, elements: sp.elements || [] })); continue; }
        const photo = await downloadDataUrl(sp.sha256);
        const screenshot = sp.screenshotSha256 ? await downloadDataUrl(sp.screenshotSha256).catch(() => null) : null;
        const id = await app.putPhoto({ photo, screenshot });
        pictures.push(Object.assign({ id, sha256: sp.sha256, category: sp.category, elements: sp.elements || [], aiSuggestions: [], hasScreenshot: !!screenshot },
          sp.screenshotSha256 && screenshot ? { screenshotSha256: sp.screenshotSha256 } : {}));
      }
    }
    if (withVehicle) {
      vehiclePhotos = { front: null, rear: null };
      for (const slot of ["front", "rear"]) {
        const sv = withVehicle.vehiclePhotos[slot];
        if (!sv || !sv.sha256) continue;
        step();
        const have = vpKnown.get(sv.sha256);
        vehiclePhotos[slot] = have || { id: await app.putPhoto({ photo: await downloadDataUrl(sv.sha256) }), sha256: sv.sha256 };
      }
    }
    // The paper logbook's pages.
    const withPaper = latestWith(full.records, "paperPages");
    let paperLogbookPhotos = existing ? existing.paperLogbookPhotos || [] : [];
    if (withPaper) {
      const paperKnown = new Map(paperLogbookPhotos.filter((p) => p.sha256).map((p) => [p.sha256, p]));
      paperLogbookPhotos = [];
      for (const sp of withPaper.paperPages) {
        if (!sp || !sp.sha256) continue;
        ui.busy = "Downloading the paper logbook pages…"; render();
        paperLogbookPhotos.push(paperKnown.get(sp.sha256) || { id: await app.putPhoto({ photo: await downloadDataUrl(sp.sha256) }), sha256: sp.sha256 });
      }
    }
    ui.busy = null;
    return { pictures, vehiclePhotos, paperLogbookPhotos };
  }

  async function toLocal(full, existing) {
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
    // An existing logbook's past events, from its issue record (transcribed
    // from the paper logbook when it was issued).
    const issueRec = full.records.find((r) => r.kind === "issue");
    const issueBody = (issueRec && issueRec.body) || {};
    const pastEvents = (issueBody.pastEvents || []).map((e, i) => Object.assign({}, e, { id: "srv_" + issueRec.id + "_" + i, fromServer: true }));
    const uploadedIds = new Set((issueBody.pastEvents || []).map((e) => e.localId));
    const keptEvents = existing ? (existing.events || []).filter((e) => !String(e.id).startsWith("srv_") && !uploadedIds.has(e.id)) : [];
    const name = (existing && existing.vehicle && existing.vehicle.name) || lb.car_name || [lb.year, lb.make, lb.model].filter(Boolean).join(" ") || lb.digital_number;
    const { pictures, vehiclePhotos, paperLogbookPhotos } = await photosToLocal(full, existing);
    const ex = issueBody.existingLogbook;
    const local = {
      sessionId: existing ? existing.sessionId : "srv_" + lb.id,
      vehicle: Object.assign({}, existing && existing.vehicle, {
        name, org: cage.org || lb.issuing_body || "none",
        // An existing logbook keeps its original issue date.
        logbookDate: (ex && ex.originalIssueDate) || String(lb.issued_at).slice(0, 10),
        logbookPath: ex ? "existing" : "new_construction",
      }),
      pathId: cage.pathId || "new_construction",
      answers,
      pictures,
      homologationPhotos: existing ? existing.homologationPhotos || [] : [],
      paperLogbookPhotos,
      vehiclePhotos,
      events: pastEvents.concat(keptEvents, serverEvents),
    };
    local.vehicle.server = { id: lb.id, digitalNumber: lb.digital_number, lastSeq: lastSeq(full), fingerprint: fingerprint(syncKey(local)), syncedAt: new Date().toISOString(), status: lb.status, issuingBody: lb.issuing_body };
    return local;
  }
  const localFor = (id) => app.listLocal().find((s) => s.vehicle && s.vehicle.server && s.vehicle.server.id === id);
  const locallyChanged = (s) => s.vehicle.server && fingerprint(syncKey(s)) !== s.vehicle.server.fingerprint;
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
  // Download (or refresh) a logbook, with its photos, into this device's
  // library. quiet: no message, no confirmation.
  async function download(id, quiet) {
    const existing = localFor(id);
    if (existing && openNow(existing) && app.isDirty()) {
      if (!quiet) say("fail", "Save or discard the changes to the logbook open below first.");
      return false;
    }
    if (existing && locallyChanged(existing) && !quiet &&
        !confirm("\"" + existing.vehicle.name + "\" has changes on this device that aren't online. Refreshing replaces them with the online logbook. Refresh anyway?")) return false;
    try {
      const full = await rpc("logbook_full", { p_id: id });
      app.saveLocal(await toLocal(full, existing));
      ui.heads[id] = { id, lastSeq: lastSeq(full), status: full.logbook.status };
      if (!quiet) say("pass", (existing ? "Refreshed " : "Saved to this device: ") + full.logbook.digital_number + ".");
      return true;
    } finally { ui.busy = null; }
  }
  async function downloadMany(ids, label) {
    let done = 0, skipped = 0;
    for (const id of ids) {
      try {
        const s = localFor(id);
        if (s && (locallyChanged(s) || (openNow(s) && app.isDirty()))) { skipped++; continue; }
        if (await download(id, true)) done++; else skipped++;
      } catch (e) { skipped++; }
      ui.busy = label + " " + (done + skipped) + " of " + ids.length + "…"; render();
    }
    ui.busy = null;
    say(skipped ? "fail" : "pass", done + " logbook" + (done === 1 ? "" : "s") + " on this device up to date" + (skipped ? "; " + skipped + " skipped (changes on this device not online, or couldn't be read)." : "."));
  }
  // A scrutineer's local changes -- cage answers and photos -- uploaded as
  // a signed amendment.
  async function uploadChanges(s) {
    if (openNow(s) && app.isDirty()) return say("fail", "Save the logbook open below first (Save on this device), then upload.");
    try {
      const full = await rpc("logbook_full", { p_id: s.vehicle.server.id });
      if (lastSeq(full) > s.vehicle.server.lastSeq) {
        return say("fail", "The online logbook has newer records than this copy. Refresh it first -- that replaces the changes made here, so note them before refreshing.");
      }
      const before = serverCage(full.records).answers || {};
      const keys = new Set(Object.keys(before).concat(Object.keys(s.answers || {})));
      const changes = [...keys].filter((k) => stable(before[k]) !== stable((s.answers || {})[k])).sort();
      const onlinePhotos = latestWith(full.records, "pictures");
      const onlineVehicle = latestWith(full.records, "vehiclePhotos");
      const photosNow = stable(syncKey(s).pictures.concat(syncKey(s).vehicle));
      const photosOnline = stable((onlinePhotos ? onlinePhotos.pictures.map((p) => [p.sha256, p.category || "", p.elements || []]) : [])
        .concat(["front", "rear"].map((slot) => { const v = onlineVehicle && onlineVehicle.vehiclePhotos[slot]; return v ? v.sha256 : null; })));
      if (photosNow !== photosOnline) changes.push("photos");
      const onlinePaper = latestWith(full.records, "paperPages");
      if (stable(syncKey(s).paper) !== stable(onlinePaper ? onlinePaper.paperPages.map((p) => p.sha256) : [])) changes.push("paper logbook pages");
      if (!changes.length) return say("pass", "No changes to upload.");
      const note = prompt("Upload " + changes.length + " change" + (changes.length === 1 ? "" : "s") + (changes.includes("photos") || changes.includes("paper logbook pages") ? " (photos included)" : "") + " to " + s.vehicle.server.digitalNumber + " as a signed amendment.\n\nWhat changed, and why? (recorded with it)", "");
      if (note === null) return;
      const acc = ui.roles.accreditations.find((a) => a.body === s.vehicle.server.issuingBody) || ui.roles.accreditations[0];
      if (!(acc.permissions || []).includes("add_logbook_entries")) return say("fail", "You aren't allowed to add logbook entries -- ask your technical director.");
      const photos = await uploadPhotos(s);
      await rpc("add_record", { p_logbook: s.vehicle.server.id, p_kind: "amendment", p_body_id: acc.body, p_body: {
        cage: { pathId: s.pathId, org: s.vehicle.org, answers: s.answers }, pictures: photos.pictures, vehiclePhotos: photos.vehiclePhotos,
        ...(changes.includes("paper logbook pages") ? { paperPages: photos.paperPages } : {}), changes, note,
      } });
      const fresh = await rpc("logbook_full", { p_id: s.vehicle.server.id });
      app.saveLocal(await toLocal(fresh, withShas(s, photos.shaById)));
      ui.heads[s.vehicle.server.id] = { lastSeq: lastSeq(fresh) };
      say("pass", "Amendment uploaded to " + s.vehicle.server.digitalNumber + ".");
    } catch (e) { ui.busy = null; fail(e); }
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
          srv && staff ? btn("QR sticker", () => logbookSticker(srv.id), "small secondary") : null,
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
      items[0] = { label: "Sanctioning body: one you're accredited by (" + accs.map((a) => a.bodyName).join(", ") + ")", done: false, where: "field:vehicle_org" };
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
    const photoCount = (rc.pictures || []).length + ["front", "rear"].filter((slot) => (rc.vehiclePhotos || {})[slot]).length + (rc.paperLogbookPhotos || []).length;
    // An existing logbook: already issued on paper -- its original issue
    // date and past events come along (each past event keeps its local id,
    // so this device's copy doesn't list it twice once refreshed).
    const existingBook = app.isExistingLogbook();
    const pastEvents = existingBook ? (rc.events || []).map((e) => ({
      localId: e.id, kind: e.kind || "event", doneBy: e.doneBy || "", name: e.name || "", date: e.date || "", driver: e.driver || "", techResult: e.techResult || "", techNotes: e.techNotes || "",
      scrutineerName: e.scrutineerName || "", scrutineerLicense: e.scrutineerLicense || "", chiefName: e.chiefName || "", chiefLicense: e.chiefLicense || "",
      notes: e.notes || "", damage: e.damage && e.damage.present ? { present: true, files: e.damage.files || [] } : null,
    })) : [];
    if (!allowDuplicate && !confirm((existingBook ? "Add the existing logbook of " : "Issue a logbook for ") + (carLine(vehicle) || "this car") + (vin ? " (" + vin + ")" : "") + " to " + ownerEmail + "?\n\n" +
      (photoCount ? "Its " + photoCount + " photo" + (photoCount === 1 ? "" : "s") + " will be uploaded with it" + (pastEvents.length ? ", with its " + pastEvents.length + " past event" + (pastEvents.length === 1 ? "" : "s") : "") + ". " : "") +
      "The logbook is recorded as it is now, and the record can't be edited afterwards -- only added to.")) return;
    try {
      // Photos first: the issue record lists them by their hash.
      const photos = await uploadPhotos(rc);
      ui.issued = await rpc("issue_logbook", { p: {
        vin, body: rc.vehicle.org, ownerEmail, ownerName, bodyNumber: answer(ans, "vehicle_logbook_number"), vehicle, allowDuplicate: !!allowDuplicate,
        record: {
          vehicle,
          owner: { name: ownerName, email: ownerEmail, phone: answer(ans, "vehicle_owner_phone"), address: answer(ans, "vehicle_owner_address") },
          cage: { pathId: rc.pathId, org: rc.vehicle.org, answers: ans },
          pictures: photos.pictures, vehiclePhotos: photos.vehiclePhotos,
          ...(photos.paperPages.length ? { paperPages: photos.paperPages } : {}),
          ...(existingBook ? { existingLogbook: { originalIssueDate: (rc.vehicle && rc.vehicle.logbookDate) || "" }, pastEvents } : {}),
        },
      } });
      // The logbook on this device becomes the online logbook's local copy,
      // its photos marked as online (their hashes).
      const linked = withShas(rc, photos.shaById);
      app.linkCurrent({ id: ui.issued.id, digitalNumber: ui.issued.digitalNumber, lastSeq: 1, fingerprint: fingerprint(syncKey(linked)), syncedAt: new Date().toISOString(), status: "active", issuingBody: rc.vehicle.org }, photos.shaById);
      say("pass", (existingBook ? "Existing logbook added as " : "Logbook ") + ui.issued.digitalNumber + (existingBook ? "" : " issued") + (photos.pictures.length || photos.paperPages.length ? " with its photos" : "") + (pastEvents.length ? " and past events" : "") + ". The owner can now sign in with " + ownerEmail + " to see it.");
      loadAll();
    } catch (e) {
      ui.busy = null;
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
    const body = rc.vehicle && rc.vehicle.org;
    if (body && body !== "none" && ui.roles.accreditations.some((a) => a.body === body) && !can(body, "issue_logbooks")) {
      return [desc("You aren't allowed to issue " + bodyName(body) + " logbooks -- a scrutineer who is issues it (Export to a file to hand it over), or ask your technical director.")];
    }
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
  // A logbook's QR sticker, scanned (or its code typed): finds that logbook.
  async function findBySticker(code) {
    try {
      const st = await rpc("sticker_view", { p_code: code });
      if (!st) return say("fail", "No sticker with the code " + Stickers.fmtCode(code) + ".");
      if (st.kind !== "logbook" || !st.logbook) return say("fail", "Sticker " + Stickers.fmtCode(code) + " isn't a logbook sticker.");
      Object.keys(findForm).forEach((k) => { findForm[k] = ""; });
      findForm.text = st.logbook.digitalNumber;
      await find();
      if (st.status !== "valid") say("fail", "Sticker " + Stickers.fmtCode(code) + " is " + st.status + (st.voidReason ? " (" + st.voidReason + ")" : "") + ": its logbook is listed below.");
    } catch (e) { fail(e); }
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
      actions(btn("Find", find, "secondary"), btn("🔳 Scan a QR sticker", () => Stickers.scanDialog(findBySticker), "secondary")),
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
  const eventForm = { id: "", body: "", discipline: "", name: "", location: "", scrutineeringStartsOn: isoDay(0), startsOn: isoDay(1), endsOn: isoDay(2), acceptedBodies: [] };
  const blankEvent = () => ({ id: "", discipline: "", name: "", location: "", scrutineeringStartsOn: isoDay(0), startsOn: isoDay(1), endsOn: isoDay(2), acceptedBodies: [] });
  // The open event, into the form to edit it.
  function editEvent() {
    const ev = ui.event.event;
    Object.assign(eventForm, { id: ev.id, body: ev.body_id, discipline: ev.discipline || "", name: ev.name || "", location: ev.location || "",
      scrutineeringStartsOn: ev.scrutineering_starts_on, startsOn: ev.starts_on, endsOn: ev.ends_on,
      acceptedBodies: (ev.accepted_bodies || []).filter((x) => x !== ev.body_id) });
    toggle("editEvent", true);
  }
  const staffForm = { email: "", role: "scrutineer" };
  const entryForm = { carNumber: "", driver: "", codriver: "", class: "", email: "", logbook: "", make: "", model: "", year: "" };
  let entryFilter = "";
  // Offline (or no answer): from this device's offline copy, if it has one.
  async function openEvent(id, quiet) {
    let bundle = null;
    if (!off.on) {
      try { bundle = await rpc("event_bundle", { p_event: id }); }
      catch (e) { if (!isNetworkError(e)) { fail(e); return; } goOffline(true); }
    }
    if (!bundle) {
      const copy = Store && await Store.get("kv", "event:" + id).catch(() => null);
      if (!copy) return say("fail", "No connection, and this event isn't downloaded on this device: download it for offline (on its page) while online.");
      bundle = copy.bundle;
    } else if (off.copies[id] && Date.now() - Date.parse(off.copies[id].savedAt) > 2 * 60 * 1000) downloadEvent(id, true);
    showEvent(bundle);
    if (!quiet) render();
  }
  async function saveEvent() {
    if (!eventForm.name.trim()) return say("fail", "The event needs a name.");
    if (disciplinesOf(eventForm.body).length && !eventForm.discipline) return say("fail", "Pick the event's discipline.");
    if (!(eventForm.scrutineeringStartsOn <= eventForm.startsOn && eventForm.startsOn <= eventForm.endsOn)) {
      return say("fail", "The dates are out of order: scrutineering starts on or before the event, which starts on or before it ends.");
    }
    const editing = !!eventForm.id;
    try {
      const id = await rpc("save_event", { p: Object.assign({}, eventForm, { id: eventForm.id || undefined }) });
      Object.assign(eventForm, blankEvent());
      ui.show.createEvent = false; ui.show.editEvent = false;
      if (!editing) ui.eventTab = "admin";
      say("pass", editing ? "Event saved." : "Event created: add its staff and pick its tech sheet, then its competitors.");
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
        carNumber: entryForm.carNumber.trim(), driver: entryForm.driver, codriver: entryForm.codriver, class: entryForm.class, email: entryForm.email, logbookId,
        vehicle: logbookId ? null : { make: entryForm.make, model: entryForm.model, year: entryForm.year },
      } });
      Object.assign(entryForm, { carNumber: "", driver: "", codriver: "", class: "", email: "", logbook: "", make: "", model: "", year: "" });
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
  // ---- Tech sheets (techsheet.js, tech-sheets/FORMAT.md) -----------------
  // The car whose sheet is open: its event entry, and the sheet being
  // filled -- the team's (submitted from PassTech, or imported from their
  // file), or a new one from the event's template (paper -> digital).
  const TECH_BUCKET = "tech-sheet-photos";
  const techPhotoUrls = {};
  // (This device's offline copy first: it's there offline, and quicker.)
  function techPhotoUrl(sha) {
    if (!techPhotoUrls[sha]) {
      techPhotoUrls[sha] = (Store ? Store.get("photos", sha).catch(() => null) : Promise.resolve(null))
        .then((blob) => (blob ? URL.createObjectURL(blob) : sb.storage.from(TECH_BUCKET).download(sha).then(({ data, error }) => (error ? null : URL.createObjectURL(data)))))
        .catch(() => null)
        // Not found (e.g. offline): asked again next time.
        .then((url) => { if (!url) delete techPhotoUrls[sha]; return url; });
    }
    return techPhotoUrls[sha];
  }
  // A scrutineer's photo on a line: at most 2000 px, as a JPEG, into the
  // tech sheet photo store under its SHA-256 (like the teams' photos).
  async function addTechPhoto(file) {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("not a photo the browser can read")); i.src = URL.createObjectURL(file); });
    const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.85));
    const sha = await sha256Hex(blob);
    await storeTechPhoto(sha, blob);
    techPhotoUrls[sha] = Promise.resolve(URL.createObjectURL(blob));
    return sha;
  }
  // Into the tech sheet photo store -- or, offline, onto this device until it syncs.
  async function storeTechPhoto(sha, blob) {
    if (!off.on) {
      try {
        const { error } = await sb.storage.from(TECH_BUCKET).upload(sha, blob, { contentType: blob.type || "image/jpeg", upsert: false });
        if (!error || /exist|duplicate/i.test(error.message || "") || String(error.statusCode) === "409") return;
        if (!isNetworkError(error)) throw error;
      } catch (e) { if (!isNetworkError(e)) throw e; }
      if (!Store) throw new Error("No connection: the photo couldn't be uploaded.");
      goOffline(true);
    }
    await Store.put("photos", sha, blob);
    if (!off.queue.some((q) => q.type === "photo" && q.sha === sha)) await putOp({ type: "photo", sha, event: ui.event && ui.event.event.id, email: me(), at: new Date().toISOString() });
  }
  // The event's sheets: [{ id, title, definition, classes }] (one per group of classes).
  const eventSheets = (b) => (b.techTemplates && b.techTemplates.length ? b.techTemplates : b.techTemplate ? [Object.assign({ classes: [] }, b.techTemplate)] : []);
  const sameClass = (a, c) => String(a || "").trim().toLowerCase() === String(c || "").trim().toLowerCase();
  // The sheet for a car's class: the one listing it, else the one for "all other classes", else
  // none (the scrutineer picks).
  function sheetForClass(sheets, cls) {
    if (sheets.length <= 1) return sheets[0] || null;
    const listing = sheets.filter((t) => (t.classes || []).some((c) => sameClass(c, cls)));
    if (listing.length === 1) return listing[0];
    const rest = sheets.filter((t) => !(t.classes || []).length);
    return !listing.length && rest.length === 1 ? rest[0] : null;
  }
  // While a scrutineer has a car's sheet open, the team can't re-submit it (the lock lasts 15
  // minutes, renewed every 5 while it stays open; closing or a verdict releases it).
  function lockSheet(t, lock) {
    if (!t || !t.sheetId || t.status === "passed" || t.status === "failed" || off.on) return;
    rpc("lock_tech_sheet", { p_sheet: t.sheetId, p_lock: lock }).catch(() => {});
  }
  setInterval(() => { if (ui.techSheet) lockSheet(ui.techSheet, true); }, 5 * 60 * 1000);
  function closeTechSheet() {
    lockSheet(ui.techSheet, false);
    ui.techSheet = null;
  }
  // Unsaved changes: what's filled in, compared with the last save (or the sheet as opened --
  // taken after its first render, which fills in what's derived, e.g. the team's gear details).
  const sheetState = (t) => JSON.stringify({ header: t.header, variant: t.variant, inspection: t.inspection, competitor: t.competitorImported ? t.competitor : null });
  const sheetDirty = () => { const t = ui.techSheet; return !!t && t.savedState != null && sheetState(t) !== t.savedState; };
  window.addEventListener("beforeunload", (e) => { if (sheetDirty()) { e.preventDefault(); e.returnValue = ""; } });
  // Leaving the open sheet (Close, another event, another mode): with unsaved changes, save them,
  // drop them, or stay. then() runs once it's closed.
  function leaveTechSheet(then) {
    if (!sheetDirty()) { closeTechSheet(); then(); return; }
    const t = ui.techSheet;
    choose("Car #" + t.entry.car_number + "'s tech sheet has unsaved changes.", [
      ["Save and close", "small", async () => { if (await saveTechSheet(null)) { closeTechSheet(); then(); } }],
      ["Close without saving", "small secondary", () => { closeTechSheet(); then(); }],
      ["Keep editing", "small secondary", () => {}],
    ]);
  }
  // A small dialog: the message and its buttons ([label, class, action]); any button closes it.
  function choose(message, buttons) {
    const overlay = h("div", { class: "sticker-dialog-backdrop" }, [h("div", { class: "sticker-dialog", role: "dialog" }, [
      h("p", {}, [message]),
      actions(...buttons.map(([label, cls, act]) => btn(label, () => { overlay.remove(); act(); }, cls))),
    ])]);
    document.body.append(overlay);
  }
  // templateId: open (or move the car to) that one of the event's sheets.
  function openTechSheet(x, templateId) {
    const b = ui.event;
    // Its offline changes conflict with the server's: those are compared first.
    const pending = sheetOp(b.event.id, x.entry.car_number);
    if (pending && pending.conflict) return off.on ? say("fail", "Car #" + x.entry.car_number + "'s offline changes conflict with the server's sheet: resolving needs a connection.") : openResolve(pending);
    if (ui.techSheet && ui.techSheet.entry.id !== x.entry.id) lockSheet(ui.techSheet, false);
    const sheets = eventSheets(b);
    const existing = (b.techSheets || []).find((s) => s.carNumber === x.entry.car_number);
    ui.techSheetPick = null;
    let tpl, tid;
    if (existing && !templateId) { tpl = existing.template; tid = existing.templateId; }
    else {
      const chosen = templateId ? sheets.find((t) => t.id === templateId) : sheetForClass(sheets, x.entry.class);
      if (!chosen && sheets.length > 1) { ui.techSheet = null; ui.techSheetPick = x; render(); return; }
      tpl = chosen && chosen.definition; tid = chosen && chosen.id;
    }
    if (!tpl) return say("fail", "This event has no tech sheet yet -- its organizer picks one in Admin mode.");
    const lb = x.logbook || {};
    const v = x.entry.vehicle || {};
    // The header, filled from what the event already knows about the car.
    const known = { event: b.event.name, car_number: x.entry.car_number, class: x.entry.class, driver: x.entry.driver, codriver: x.entry.codriver,
      make: lb.make || v.make, model: lb.model || v.model, year: lb.year || v.year, vin: lb.vin, logbook_body: lb.issuing_body ? bodyName(lb.issuing_body) : "",
      logbook_number: lb.digital_number };
    const header = Object.assign({}, existing && existing.header, ui.techSheet && ui.techSheet.entry.id === x.entry.id && templateId ? ui.techSheet.header : null);
    (tpl.header || []).forEach((f) => { if (header[f.id] == null && f.prefill && known[f.prefill]) header[f.id] = known[f.prefill]; });
    // Moving to another sheet keeps what's been filled in (lines with the same key keep their results).
    const keep = ui.techSheet && ui.techSheet.entry.id === x.entry.id && templateId ? ui.techSheet : null;
    ui.techSheet = {
      x, templateId: tid, entry: x.entry, template: tpl, variant: existing && existing.variant ? existing.variant : TechSheet.variantForClass(tpl, x.entry.class), header,
      competitor: existing ? existing.competitor : null,
      inspection: keep ? keep.inspection : JSON.parse(JSON.stringify((existing && existing.inspection) || { items: {} })),
      status: existing ? existing.status : "new", signAsChief: false,
      view: {}, // what's folded (techsheet.js)
      sheetId: existing ? existing.id : null,
      stickers: null, // list_stickers() for this sheet
      // The team's submission this sheet was opened on: a save after they re-submit is refused.
      seenSubmittedAt: (existing && existing.competitor && existing.competitor.submittedAt) || "",
      // The server's version it started from ("" none yet): a save after someone else's is a
      // conflict, never an overwrite (save_tech_sheet's baseUpdatedAt). Kept as the exact text.
      baseUpdatedAt: (existing && existing.updatedAt) || "",
      // Saved on this device only (offline), waiting to sync.
      localSaved: !!(existing && existing.local),
      competitorImported: false,
    };
    loadSheetStickers();
    lockSheet(ui.techSheet, true);
    render();
    setTimeout(() => { const el = document.getElementById("techsheet-panel"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 0);
  }
  async function saveTechSheet(finish) {
    const t = ui.techSheet;
    if (finish) {
      const c = TechSheet.counts(t.template, t.variant, t.inspection);
      if (finish === "pass" && c.fail) return say("fail", c.fail + " line" + (c.fail === 1 ? " is" : "s are") + " marked Fail -- fix " + (c.fail === 1 ? "it" : "them") + ", or finish as Failed.");
      if (finish === "fail" && !c.fail && !(t.inspection.corrections || "").trim()) return say("fail", "Mark the lines that fail, or write the corrections required.");
      if (finish === "pass" && c.todo && !confirm(c.todo + " line" + (c.todo === 1 ? " isn't" : "s aren't") + " checked yet. Pass car " + t.entry.car_number + " anyway?")) return;
      if (!confirm((finish === "pass" ? "Pass" : "Fail") + " car " + t.entry.car_number + " and sign the sheet as " + (ui.roles.email) + "?")) return;
    }
    const p = {
      carNumber: t.entry.car_number, template: t.templateId || undefined, header: t.header, variant: t.variant,
      // The team's part only when imported here (a file); otherwise it stays as they submitted it.
      competitor: t.competitorImported ? t.competitor : undefined, seenSubmittedAt: t.seenSubmittedAt, baseUpdatedAt: t.baseUpdatedAt,
      inspection: { items: t.inspection.items, corrections: t.inspection.corrections || "", pictures: t.inspection.pictures || {} },
      finish: finish || undefined, signAs: finish && t.signAsChief ? "chief" : undefined,
    };
    if (off.on) return saveSheetOffline(t, p);
    try {
      let s;
      try { s = await rpc("save_tech_sheet", { p_event: ui.event.event.id, p }); }
      catch (e) {
        if (isNetworkError(e) && Store) { goOffline(true); return saveSheetOffline(t, p); }
        // Changed on the server since it was opened here: compare and pick, rather than overwrite.
        if (isConflict(e)) { await sheetConflict(t, p, e); return false; }
        throw e;
      }
      t.competitorImported = false;
      t.seenSubmittedAt = (s.competitor && s.competitor.submittedAt) || "";
      t.baseUpdatedAt = s.updatedAt || "";
      t.localSaved = false;
      t.savedState = sheetState(t);
      updateCopySheet(ui.event.event.id, s);
      say("pass", finish ? "Car " + t.entry.car_number + " " + (finish === "pass" ? "passed" : "failed") + (s.record ? " -- recorded in its logbook." : ".") +
        (finish === "pass" ? " Its stickers can be issued below." : "") : "Tech sheet saved.");
      // Passed: the sheet stays open for its stickers.
      if (finish === "fail") ui.techSheet = null;
      else { t.status = s.status; t.sheetId = s.id; loadSheetStickers(); }
      await openEvent(ui.event.event.id); loadEventsOnly();
      return true;
    } catch (e) { fail(e); return false; }
  }
  // A team's sheet exported from PassTech (a file): their declarations and
  // photos come into the open sheet.
  function importTeamSheet() {
    const input = h("input", { type: "file", accept: "application/json,.json", onchange: async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.kind !== "passtech-tech-sheet" || !data.competitor) throw new Error("That isn't a PassTech tech sheet file.");
        const t = ui.techSheet;
        if (data.carNumber && String(data.carNumber) !== String(t.entry.car_number) &&
            !confirm("That file is for car " + data.carNumber + ", not car " + t.entry.car_number + ". Import it anyway?")) return;
        if (data.template && data.template.id && data.template.id !== t.template.id &&
            !confirm("That file was filled on \"" + (data.template.title || data.template.id) + "\", not this event's \"" + t.template.title + "\". Lines that match are kept. Import it anyway?")) return;
        // Its photos, into the tech sheet photo store.
        const images = data.images || {};
        let n = 0;
        for (const sha of Object.keys(images)) {
          ui.busy = "Uploading the team's photos: " + (++n) + " of " + Object.keys(images).length + "…"; render();
          const blob = await dataUrlToBlob(images[sha]);
          const real = await sha256Hex(blob);
          await storeTechPhoto(real, blob);
          // A file edited by hand can name a photo by the wrong hash: point its lines at the real one.
          if (real !== sha) Object.values(data.competitor.items || {}).forEach((it) =>
            (it.photos || []).forEach((p) => { if (p.sha256 === sha) p.sha256 = real; }));
        }
        ui.busy = null;
        t.competitor = Object.assign({}, data.competitor, { importedAt: new Date().toISOString(), file: file.name });
        t.competitorImported = true;
        Object.entries(data.header || {}).forEach(([k, v]) => { if (v && !t.header[k]) t.header[k] = v; });
        if (data.variant && !t.variant) t.variant = data.variant;
        say("pass", "The team's sheet is in -- " + Object.keys(data.competitor.items || {}).length + " lines declared. Save to keep it.");
      } catch (e) { ui.busy = null; fail(e); }
    } });
    input.click();
  }
  const sheetClasses = (t) => ((t.classes || []).length ? " -- " + t.classes.join(", ") : " -- all other classes");
  function renderTechSheetPick() {
    const x = ui.techSheetPick;
    return h("div", { class: "account-card", id: "techsheet-panel" }, [
      h("div", { class: "account-card-title" }, ["Car #" + x.entry.car_number + " -- which tech sheet?"]),
      desc((x.entry.class ? "Class " + x.entry.class + " isn't listed by exactly one of this event's sheets" : "This car has no class") + ": pick the sheet to inspect it with."),
      actions(eventSheets(ui.event).map((t) => btn(t.title + sheetClasses(t), () => openTechSheet(x, t.id), "small secondary")),
        btn("Cancel", () => { ui.techSheetPick = null; render(); }, "small secondary")),
    ]);
  }
  function renderTechSheet() {
    const t = ui.techSheet;
    const myRole = (ui.event.staff.find((s) => s.email === ui.roles.email) || {}).role;
    // Filled in any time until scrutineering ends; Passed / Failed only during it.
    const ev = ui.event.event;
    const open = eventOpenNow(ev);
    const over = isoDay(0) > isoDay(1, ev.ends_on);
    const finished = t.status === "passed" || t.status === "failed";
    const editable = !!myRole && !over && !finished;
    const c = TechSheet.counts(t.template, t.variant, t.inspection);
    const declaredBy = t.competitor && (t.competitor.by || t.competitor.file);
    // Passed / Failed: signed under the event's body's accreditation (else the person's first),
    // which needs sign_off_tech_sheets -- like the server.
    const signer = signerFor(ev.body_id, ev.discipline);
    const canSign = !!signer && (signer.permissions || []).includes("sign_off_tech_sheets");
    // Save / Finish / Close: at the top and at the bottom of a long sheet.
    const mainButtons = () => [
      editable ? btn("Save", () => saveTechSheet(null), "small secondary") : null,
      editable && open && canSign ? btn("Finish: Passed", () => saveTechSheet("pass"), "small") : null,
      editable && open && canSign ? btn("Finish: Failed", () => saveTechSheet("fail"), "small secondary") : null,
      editable && open && !canSign ? h("span", { class: "element-desc" }, ["Fill it in and save -- a scrutineer allowed to sign off records Passed / Failed."]) : null,
    ];
    const closeButton = () => btn("Close", () => leaveTechSheet(render), "small secondary");
    return h("div", { class: "account-card", id: "techsheet-panel" }, [
      h("div", { class: "account-card-title" }, ["Car #" + t.entry.car_number + " -- " + t.template.title,
        t.status === "passed" || t.status === "failed" ? h("span", { class: "badge " + (t.status === "passed" ? "pass" : "req") }, [t.status]) : null]),
      actions(...mainButtons(), closeButton()),
      desc([c.pass + " pass", c.fail + " fail", c.na ? c.na + " N/A" : null, c.todo + " to check",
        declaredBy ? "team's sheet from " + declaredBy : "no team sheet (filled here from paper)"].filter(Boolean).join(" · ")),
      // Earlier rounds: failed, then the team re-submitted what failed.
      (t.inspection.history || []).map((x) => h("p", { class: "verdict warn" }, ["Failed " + fmtDate(x.at) +
        (x.signatures && x.signatures.scrutineer ? " (" + x.signatures.scrutineer.name + ")" : "") + (x.corrections ? " -- corrections: " + x.corrections : "") +
        ". The team re-submitted " + fmtDate(x.resubmittedAt) + ": the lines they changed are marked \"updated by the team\" and need checking again."])),
      t.localSaved ? h("p", { class: "verdict warn" }, ["Saved on this device (offline): it syncs once back online."]) : null,
      !myRole ? desc("Only the event's staff fill its sheets.") : over ? desc("This event is over: the sheet is read-only.") : finished ? desc("This sheet is signed: it's read-only.")
        : !open ? h("p", { class: c.todo === 0 && c.total ? "library-notice" : "element-desc" }, [(c.todo === 0 && c.total ? "Every line has a result. " : "") +
          "Scrutineering opens " + fmtDate(ev.scrutineering_starts_on) + ": " + (c.todo === 0 && c.total ? "save the sheet now, and finish it as Passed or Failed from then." : "fill the sheet in and save it now -- Passed / Failed can be recorded from then.")]) : null,
      eventSheets(ui.event).length > 1 ? h("div", { class: "field-row" }, [field("Tech sheet", editable
        ? select(eventSheets(ui.event).map((x) => [x.id, x.title + sheetClasses(x)]), t.templateId || "", (v) => { if (v && v !== t.templateId) openTechSheet(t.x, v); })
        : input({ value: t.template.title, disabled: true }, () => {}))]) : null,
      TechSheet.sheet({ template: t.template, variant: t.variant, header: t.header, competitor: t.competitor, inspection: t.inspection,
        editable, view: t.view, photoUrl: techPhotoUrl, addPhoto: addTechPhoto, lookupSticker, setVariant: (v) => { t.variant = v; }, onChange: render }),
      // (The state as opened, once the first render has filled in what's derived.)
      t.savedState == null ? void (t.savedState = sheetState(t)) : null,
      editable && open && canSign && myRole === "chief" ? h("label", { class: "account-checks" }, [h("input", { type: "checkbox", checked: t.signAsChief, onchange: (e) => { t.signAsChief = e.target.checked; } }), " Also sign as chief scrutineer"]) : null,
      actions(
        ...mainButtons(),
        editable ? btn("Import the team's sheet (file)", importTeamSheet, "small secondary") : null,
        closeButton(),
      ),
      renderSheetStickers(t, !!myRole),
    ]);
  }

  // ---- Tech stickers for the open sheet (stickers.js) ----------------------
  // A helmet / HANS / seat line that passed, with a photo of the item and of
  // its tag, gets a gear sticker; a car that passed, its tech-pass sticker.
  const STICKER_GEAR = Stickers.GEAR;
  // A sticker read on a tech sheet line (techsheet.js useSticker), or checked at the event:
  // offline, from this device's offline copies.
  async function lookupSticker(code) {
    if (!off.on) {
      try { return await rpc("sticker_view", { p_code: code }); } catch (e) { if (!isNetworkError(e)) throw e; goOffline(true); }
    }
    const d = await offlineSticker(code);
    if (d) return d;
    throw new Error("No connection, and sticker " + Stickers.fmtCode(code) + " isn't in this device's offline copy: offline, only the stickers of the events downloaded here can be checked.");
  }
  async function loadSheetStickers() {
    const t = ui.techSheet;
    if (!t || (!t.sheetId && !t.localSaved)) return;
    let list = null;
    if (!off.on && t.sheetId) {
      try { list = await rpc("list_stickers", { p: { techSheet: t.sheetId } }); } catch (e) { if (isNetworkError(e)) goOffline(true); else list = []; }
    }
    // Offline: the copy's, with those printed offline.
    if (!list) list = await copyStickers(t.entry.event_id, (s) => (t.sheetId && s.techSheet === t.sheetId) || (s.offline && (s.snapshot || {}).carNumber === t.entry.car_number));
    t.stickers = list;
    if (ui.techSheet === t) render();
  }
  async function issueSticker(p, then, replacing) {
    if (replacing && !confirm("Issue a new sticker? Sticker " + Stickers.fmtCode(replacing.code) + " becomes void -- peel it off.")) return;
    if (off.on) return issueStickerOffline(p);
    try {
      let st;
      try { st = await rpc("issue_sticker", { p }); }
      catch (e) { if (isNetworkError(e) && Store) { goOffline(true); return issueStickerOffline(p); } throw e; }
      addCopySticker(st.event, st);
      if (then) await then();
      Stickers.printDialog([st]);
    } catch (e) { fail(e); }
  }
  // Every valid sticker issued at the event, to print in one go.
  async function printEventStickers() {
    try {
      const list = (await rpc("list_stickers", { p: { event: ui.event.event.id } })).filter((s) => !s.voidedAt);
      if (!list.length) return say("fail", "No stickers issued at this event yet: they're issued from each car's tech sheet.");
      Stickers.printDialog(list);
    } catch (e) { fail(e); }
  }
  // A logbook's sticker (cage, logbook cover): the one already issued, else a new one.
  async function logbookSticker(id) {
    try {
      const list = (await rpc("list_stickers", { p: { logbook: id } })).filter((s) => !s.voidedAt && s.kind === "logbook");
      if (list.length) return Stickers.printDialog(list.slice(-1));
      Stickers.printDialog([await rpc("issue_sticker", { p: { kind: "logbook", logbook: id } })]);
    } catch (e) { fail(e); }
  }
  function renderSheetStickers(t, staff) {
    const gearRows = TechSheet.lines(t.template, t.variant).flatMap((g) => g.rows).filter((r) => STICKER_GEAR.includes(r.item.gear));
    if (!staff || (!gearRows.length && t.status !== "passed")) return null;
    const title = h("div", { class: "account-card-title" }, ["Stickers"]);
    if (!t.sheetId && !t.localSaved) return h("div", { class: "account-card" }, [title, desc("Save the sheet to issue its stickers.")]);
    const valid = (t.stickers || []).filter((s) => !s.voidedAt);
    const declared = (t.competitor && t.competitor.items) || {};
    // A valid sticker: print it, or void it. Re-issuing comes once it's void (lost, damaged,
    // the item failed) -- the last voided one is shown until then.
    const lastVoided = (match) => (t.stickers || []).filter((s) => s.voidedAt && match(s)).pop();
    const row = (label, st, voided, why, issue) => h("div", { class: "account-entry" }, [
      h("span", { class: "account-entry-main" }, [h("strong", {}, [label]),
        h("span", { class: "element-desc" }, [st ? " · sticker " + Stickers.fmtCode(st.code) + ", " + fmtDate(st.issuedAt)
          : voided ? " · sticker " + Stickers.fmtCode(voided.code) + " voided " + fmtDate(voided.voidedAt) + (voided.voidReason ? " (" + voided.voidReason + ")" : "")
          : why ? " · to issue its sticker: " + why : " · no sticker yet"])]),
      st ? btn("Print", () => Stickers.printDialog([st]), "small secondary") : null,
      st && !off.on && !st.offline && canIn(st.body, st.discipline, "void_stickers") ? btn("Void", () => voidSticker(st.code), "small secondary") : null,
      st && st.offline ? h("span", { class: "badge cond", title: "Printed offline: recorded on the server when this device syncs" }, ["not synced"]) : null,
      !st && !why ? btn(voided ? "Re-issue" : "Issue sticker", issue, "small") : null,
    ]);
    const rows = gearRows.map((r) => {
      const res = t.inspection.items[r.key] || {};
      const photos = [].concat((declared[r.key] || {}).photos || [], res.photos || []).filter((p) => !(res.removedPhotos || []).includes(p.sha256));
      const mine = (s) => s.kind === "gear" && s.item === r.key;
      const st = valid.find(mine);
      const why = res.result !== "pass" ? "mark it Pass" : !photos.some((p) => p.kind !== "tag") ? "add a photo of it" : !photos.some((p) => p.kind === "tag") ? "add a photo of its tag (🏷️)" : null;
      return row(r.label, st, st ? null : lastVoided(mine), why, () => issueSticker({ kind: "gear", techSheet: t.sheetId, item: r.key, label: r.label }, loadSheetStickers));
    });
    const isCar = (s) => s.kind === "car";
    const carSt = valid.find(isCar);
    rows.push(row("Car #" + t.entry.car_number + " tech pass", carSt, carSt ? null : lastVoided(isCar), t.status === "passed" ? null : "finish the sheet as Passed",
      () => issueSticker({ kind: "car", techSheet: t.sheetId }, loadSheetStickers)));
    return h("div", { class: "account-card" }, [
      title,
      desc("Printed QR codes: a gear sticker goes on the helmet, HANS or seat (scanning it shows its photos and certification); the tech pass goes on the car. Save the sheet before issuing."),
      off.on ? desc("Offline: " + (off.codes[t.entry.event_id] || []).length + " sticker codes left on this device. A sticker printed now is recorded on the server when this device syncs.") : null,
      rows,
      valid.length > 1 ? actions(btn("Print all " + valid.length, () => Stickers.printDialog(valid), "small secondary")) : null,
    ]);
  }

  // ---- Working offline (offline.js, supabase/migrations/20261027000000_offline_scrutineering.sql) ----
  // An event with a weak connection: "Download for offline" keeps the event (its cars and tech
  // sheets), the stickers valid there (issued at the event, and the accepted bodies' annual ones
  // for its season) and copies of their photos on this device -- refreshed every few minutes
  // while online -- and reserves sticker codes. Offline, the event opens from that copy; saving a
  // sheet, adding a photo or printing a sticker (under a reserved code) waits in a queue that
  // syncs, in order, once back online. A sheet changed on the server since this device's version
  // (another scrutineer, the team re-submitting) is never overwritten: the server refuses the
  // save as a conflict (baseUpdatedAt), and the scrutineer compares the two, line by line.
  const me = () => (ui.roles && ui.roles.email) || (ui.session && ui.session.user && ui.session.user.email) || "";
  const isNetworkError = (e) => !navigator.onLine || (e && e.name === "AuthRetryableFetchError") ||
    /failed to fetch|networkerror|network request failed|load failed|aborted|timed? ?out/i.test(String((e && (e.message || e.name)) || e || ""));
  // Whether the event's scrutineering window is open (event_open()): from the server's list,
  // or offline, from the dates.
  const eventOpenNow = (ev) => (off.on ? !ev.cancelled_at && isoDay(0) >= ev.scrutineering_starts_on && isoDay(0) <= isoDay(1, ev.ends_on)
    : ui.events.some((e) => e.id === ev.id && e.open));
  const isConflict = (e) => !!e && (e.code === "TS409" || /^conflict:/i.test(e.message || "") || /re-submitted car .* since you opened it/i.test(e.message || ""));
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  function goOffline(on) {
    if (off.on === on) return;
    off.on = on;
    render();
    if (!on) syncQueue();
  }

  // ---- The session, for starting offline: who, their roles, bodies and events ----
  async function saveSnapshot() {
    if (!Store || SITE !== "scrutineering" || !isStaff()) return;
    try {
      await Store.put("kv", "snapshot", { email: me(), userId: ui.session.user.id, roles: ui.roles, garage: ui.garage, bodies: ui.bodies, disciplines: ui.disciplines,
        accreditations: ui.accreditations, events: ui.events, techTemplates: ui.techTemplates, savedAt: new Date().toISOString() });
    } catch (e) { /* no offline copy here */ }
  }
  async function loadSnapshot(email) {
    const s = Store && await Store.get("kv", "snapshot").catch(() => null);
    if (!s || (email && s.email !== email)) return null;
    Object.assign(ui, { roles: s.roles, garage: s.garage || [], bodies: s.bodies || [], disciplines: s.disciplines || [],
      accreditations: s.accreditations || [], events: s.events || [], techTemplates: s.techTemplates || [] });
    return s;
  }
  // Starting with no connection (the sign-in can't be renewed): signed in as the device's last
  // scrutineer, from the snapshot -- until back online.
  async function startOffline() {
    if (ui.session || !Store) return;
    if (navigator.onLine && await reachable()) return;
    const snap = await loadSnapshot();
    if (!snap || ui.session) return;
    ui.session = { user: { id: snap.userId, email: snap.email }, offline: true };
    off.on = true;
    await loadOfflineState();
    render();
  }
  // Whether the server answers at all (within a few seconds).
  async function reachable() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try { await fetch(cfg.url + "/auth/v1/health", { headers: { apikey: cfg.anonKey }, signal: ctl.signal }); return true; }
    catch (e) { return false; }
    finally { clearTimeout(timer); }
  }
  // Back online: a sign-in that started offline is checked for real (else sign in again -- what
  // waits to sync stays on this device for when they do); then sync and refresh.
  async function backOnline() {
    if (!(await reachable())) return;
    if (ui.session && ui.session.offline) {
      const { data } = await sb.auth.getSession().catch(() => ({ data: {} }));
      ui.session = (data && data.session) || null;
      if (ui.session) await loadAll(); else render();
      return;
    }
    goOffline(false);
    if (ui.event && !ui.techSheet) openEvent(ui.event.event.id, true);
  }
  window.addEventListener("online", () => { backOnline(); });
  window.addEventListener("offline", () => goOffline(true));

  // ---- What this device keeps ----
  // "event:<id>": { id, email, bundle (event_bundle), stickers, photos (their SHA-256s), savedAt };
  // "codes:<id>": { event, email, codes }; the queue: { type: photo | sheet | sticker, event, car, email, ... }.
  const copyInfo = (c) => ({ savedAt: c.savedAt, cars: c.bundle.entries.length, sheets: (c.bundle.techSheets || []).length, stickers: c.stickers.length,
    photos: (c.photos || []).length, endsOn: c.bundle.event.ends_on });
  async function loadOfflineState() {
    if (!Store) return;
    try {
      const kv = await Store.all("kv");
      off.queue = (await Store.all("queue")).filter((x) => x.value.email === me()).map((x) => Object.assign({}, x.value, { key: x.key }));
      off.copies = {};
      off.codes = {};
      let dropped = false;
      for (const { key, value } of kv) {
        if (!value || value.email !== me()) continue;
        if (key.startsWith("event:")) {
          // A copy of an event over for two days goes (nothing of it waiting to sync): it holds people's names and photos.
          if (isoDay(0) > isoDay(2, value.bundle.event.ends_on) && !off.queue.some((q) => q.event === value.id)) {
            await Store.del("kv", key); await Store.del("kv", "codes:" + value.id); dropped = true;
          } else off.copies[value.id] = copyInfo(value);
        }
        if (key.startsWith("codes:") && off.copies[value.event] !== undefined) off.codes[value.event] = value.codes;
      }
      if (dropped) await prunePhotos();
    } catch (e) { /* no offline store here */ }
    if (ui.eventServer) showEvent(ui.eventServer);
  }
  // Photos no copy and nothing waiting to sync uses any more.
  async function prunePhotos() {
    const keep = new Set(off.queue.filter((q) => q.type === "photo").map((q) => q.sha));
    for (const { key, value } of await Store.all("kv")) if (key.startsWith("event:")) (value.photos || []).forEach((s) => keep.add(s));
    for (const sha of await Store.keys("photos")) if (!keep.has(sha)) await Store.del("photos", sha);
  }
  async function removeCopy(id) {
    if (off.queue.some((q) => q.event === id)) return say("fail", "Changes made offline at this event haven't synced yet: sync them first.");
    await Store.del("kv", "event:" + id);
    await Store.del("kv", "codes:" + id);
    delete off.copies[id];
    delete off.codes[id];
    await prunePhotos();
    say("pass", "This event's offline copy is removed from this device.");
  }

  // Every photo a copy shows: the teams' and the scrutineers' on each sheet, and the stickers'.
  function photoShas(bundle, stickers) {
    const out = new Set();
    const add = (list) => (Array.isArray(list) ? list : []).forEach((p) => { if (p && /^[0-9a-f]{64}$/.test(p.sha256 || "")) out.add(p.sha256); });
    (bundle.techSheets || []).forEach((s) => [s.competitor, s.inspection].forEach((part) => {
      if (!part) return;
      Object.values(part.items || {}).forEach((it) => add(it && it.photos));
      Object.values(part.pictures || {}).forEach(add);
    }));
    stickers.forEach((s) => add((s.snapshot || {}).photos));
    return [...out];
  }
  // A photo for the copy: at most 1600 px (tags stay readable), unless it's here already.
  async function cachePhoto(sha) {
    if (await Store.get("photos", sha)) return;
    const { data, error } = await sb.storage.from(TECH_BUCKET).download(sha);
    if (error) throw error;
    let blob = data;
    try {
      const img = await createImageBitmap(data);
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      if (scale < 1) {
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.82)) || data;
      }
    } catch (e) { /* kept as it is */ }
    await Store.put("photos", sha, blob);
  }
  // The stickers to check at the event: those issued there, and the accepted bodies' annual ones for its season.
  async function fetchStickers(ev) {
    const season = Number(String(ev.starts_on).slice(0, 4));
    const lists = [await rpc("list_stickers", { p: { event: ev.id } })];
    for (const body of new Set([ev.body_id].concat(ev.accepted_bodies || []))) lists.push(await rpc("list_stickers", { p: { body, season } }));
    const seen = new Set();
    return lists.flat().filter((s) => !seen.has(s.code) && seen.add(s.code));
  }
  // Downloads (or refreshes, quiet: in the background) an event's offline copy.
  const downloading = new Set();
  async function downloadEvent(id, quiet) {
    if (!Store) return say("fail", "This browser can't keep an offline copy.");
    if (downloading.has(id)) return;
    downloading.add(id);
    const progress = (text) => { if (!quiet) { ui.busy = text; render(); } };
    try {
      progress("Downloading the event…");
      const bundle = await rpc("event_bundle", { p_event: id });
      progress("Downloading its stickers…");
      const stickers = await fetchStickers(bundle.event);
      // Stickers printed offline here, not synced yet, stay in it.
      const prev = await Store.get("kv", "event:" + id);
      ((prev && prev.stickers) || []).forEach((s) => { if (s.offline && !stickers.some((x) => x.code === s.code)) stickers.push(s); });
      const photos = photoShas(bundle, stickers);
      const todo = photos.slice();
      let n = 0, missing = 0;
      const worker = async () => {
        while (todo.length) {
          const sha = todo.shift();
          try { await cachePhoto(sha); } catch (e) { if (isNetworkError(e)) throw e; missing++; }
          progress("Downloading photos: " + (++n) + " of " + photos.length + "…");
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      const copy = { id, email: me(), bundle, stickers, photos, savedAt: new Date().toISOString() };
      await Store.put("kv", "event:" + id, copy);
      off.copies[id] = copyInfo(copy);
      await topUpCodes(bundle);
      // What the pages need offline: the QR code libraries and the certification catalog (cached as they load).
      if (Stickers.loadLibs) Stickers.loadLibs().catch(() => {});
      TechSheet.loadCatalog().then((c) => { ui.stickerCatalog = c; }, () => {});
      ui.busy = null;
      if (!quiet) say("pass", "Downloaded for offline: " + bundle.entries.length + " cars, " + stickers.length + " stickers, " + (photos.length - missing) + " photos" +
        (missing ? " (" + missing + " couldn't be downloaded)" : "") + ". It's refreshed every few minutes while online.");
    } catch (e) {
      ui.busy = null;
      if (!quiet) fail(e);
    } finally { downloading.delete(id); }
    render();
  }
  // Sticker codes to print offline (the event's staff): topped up to 30 while online.
  async function topUpCodes(bundle) {
    const ev = bundle.event;
    if (!bundle.staff.some((s) => s.email === me()) || (off.codes[ev.id] || []).length >= 20) return;
    try {
      const reserved = await rpc("reserve_sticker_codes", { p_event: ev.id, p_count: 30 - (off.codes[ev.id] || []).length });
      // (Less those printed offline that haven't synced yet.)
      const codes = (reserved || []).filter((c) => !off.queue.some((q) => q.type === "sticker" && q.p.code === c));
      off.codes[ev.id] = codes;
      await Store.put("kv", "codes:" + ev.id, { event: ev.id, email: me(), codes });
    } catch (e) { if (isNetworkError(e)) throw e; /* (a server without reserved codes: printing offline isn't available) */ }
  }
  async function takeCode(eventId) {
    const codes = off.codes[eventId] || [];
    const code = codes.shift();
    if (code) await Store.put("kv", "codes:" + eventId, { event: eventId, email: me(), codes });
    return code || null;
  }
  // The copy's stickers (match: which), for the tech sheet offline.
  async function copyStickers(eventId, match) {
    const copy = Store && await Store.get("kv", "event:" + eventId).catch(() => null);
    return copy ? copy.stickers.filter(match) : [];
  }
  // A sticker issued (or printed offline) into the copy, so it checks offline too.
  async function addCopySticker(eventId, st) {
    if (!Store || !eventId || !off.copies[eventId]) return;
    const copy = await Store.get("kv", "event:" + eventId).catch(() => null);
    if (!copy) return;
    copy.stickers = copy.stickers.filter((s) => s.code !== st.code).map((s) => (st.replaces && st.replaces(s) ? Object.assign({}, s, { voidedAt: st.issuedAt, voidReason: "replaced", replacedBy: st.code }) : s));
    copy.stickers.push(Object.assign({}, st, { replaces: undefined }));
    await Store.put("kv", "event:" + eventId, copy);
    off.copies[eventId] = copyInfo(copy);
  }
  // A sheet saved (or synced) into the copy.
  async function updateCopySheet(eventId, s) {
    if (!Store || !off.copies[eventId]) return;
    const copy = await Store.get("kv", "event:" + eventId).catch(() => null);
    if (!copy) return;
    const list = copy.bundle.techSheets || (copy.bundle.techSheets = []);
    const i = list.findIndex((x) => x.carNumber === s.carNumber);
    if (i >= 0) list[i] = s; else list.push(s);
    if (s.status === "passed" || s.status === "failed") copy.bundle.entries.forEach((x) => { if (x.entry.car_number === s.carNumber) x.entry.tech_status = s.status; });
    await Store.put("kv", "event:" + eventId, copy);
    off.copies[eventId] = copyInfo(copy);
  }

  // ---- The queue: changes waiting to sync ----
  let opSeq = 0;
  async function putOp(op) {
    if (!op.key) op.key = String(Date.now()).padStart(15, "0") + "-" + String(++opSeq).padStart(4, "0");
    const value = Object.assign({}, op);
    delete value.key;
    await Store.put("queue", op.key, value);
    if (!off.queue.includes(op)) off.queue.push(op);
    if (ui.eventServer) showEvent(ui.eventServer);
  }
  async function dropOp(op) {
    await Store.del("queue", op.key);
    off.queue = off.queue.filter((q) => q !== op);
    if (ui.eventServer) showEvent(ui.eventServer);
  }
  const sheetOp = (eventId, car) => off.queue.find((q) => q.type === "sheet" && q.event === eventId && q.car === car);
  // The event as shown: the server's (or the copy's), with this device's sheets waiting to sync.
  function showEvent(bundle) {
    ui.eventServer = bundle;
    const b = Object.assign({}, bundle, { techSheets: (bundle.techSheets || []).slice(), entries: bundle.entries.map((x) => Object.assign({}, x, { entry: Object.assign({}, x.entry) })) });
    off.queue.filter((q) => q.type === "sheet" && q.event === bundle.event.id).forEach((q) => {
      const i = b.techSheets.findIndex((x) => x.carNumber === q.car);
      // In conflict: the server's stays shown, marked, until the scrutineer picks.
      if (q.conflict) { if (i >= 0) b.techSheets[i] = Object.assign({}, b.techSheets[i], { conflict: true }); return; }
      const local = Object.assign({}, q.local, { local: true, syncError: q.error || null });
      if (i >= 0) b.techSheets[i] = local; else b.techSheets.push(local);
      if (local.status === "passed" || local.status === "failed") b.entries.forEach((x) => { if (x.entry.car_number === q.car) x.entry.tech_status = local.status; });
    });
    ui.event = b;
  }
  // Saving a sheet with no connection: onto this device, to sync later (one change per car:
  // the latest, from the server's version the first one started from).
  async function saveSheetOffline(t, p) {
    if (!Store) return say("fail", "No connection, and this browser can't keep changes offline: the sheet isn't saved."), false;
    const ev = ui.event.event;
    const old = sheetOp(ev.id, t.entry.car_number);
    if (old && old.conflict) return say("fail", "Car #" + t.entry.car_number + "'s offline changes conflict with the server's: resolve that first."), false;
    p = Object.assign({}, p, { offlineAt: new Date().toISOString() });
    if (p.competitor === undefined) delete p.competitor;
    // (A team's sheet imported in an earlier offline save stays in.)
    if (old && old.p.competitor && !p.competitor) p.competitor = old.p.competitor;
    const signer = p.finish ? signerFor(ev.body_id, ev.discipline) : null;
    const local = { id: t.sheetId, event: ev.id, carNumber: t.entry.car_number, entry: t.entry.id, templateId: t.templateId, template: t.template, variant: t.variant,
      header: t.header, competitor: t.competitor, status: p.finish === "pass" ? "passed" : p.finish === "fail" ? "failed" : "inspecting",
      inspection: Object.assign({}, t.inspection, p.finish ? { result: p.finish, signatures: Object.assign({}, t.inspection.signatures,
        { scrutineer: { name: signer ? signer.name : me(), license: signer ? signer.license_number || signer.license : null, email: me(), at: p.offlineAt } }) } : {}),
      updatedAt: old ? old.base : t.baseUpdatedAt, inspectedBy: me(), inspectedAt: p.offlineAt };
    const op = old || { type: "sheet", event: ev.id, car: t.entry.car_number, email: me(), base: t.baseUpdatedAt };
    Object.assign(op, { p, local: JSON.parse(JSON.stringify(local)), at: p.offlineAt, error: null });
    await putOp(op);
    t.competitorImported = false;
    t.localSaved = true;
    if (p.finish) { t.status = local.status; t.inspection.result = p.finish; }
    t.savedState = sheetState(t);
    say("pass", (p.finish ? "Car " + t.entry.car_number + " " + (p.finish === "pass" ? "passed" : "failed") + " -- " : "") +
      "saved on this device (offline): it syncs once back online." + (p.finish === "pass" ? " Its stickers can be printed below." : ""));
    if (p.finish === "fail") ui.techSheet = null;
    render();
    return true;
  }
  // A sticker printed offline: under one of the codes reserved for this event, recorded on the
  // server when this device syncs (until then it's only in this device's offline copy).
  async function issueStickerOffline(p) {
    const t = ui.techSheet, ev = ui.event.event;
    if (!Store) return say("fail", "No connection: the sticker can't be issued.");
    if (sheetDirty()) return say("fail", "Save the sheet first.");
    const code = await takeCode(ev.id);
    if (!code) return say("fail", "No sticker codes left on this device to print offline: they're reserved when the event is downloaded for offline (online).");
    const now = new Date().toISOString();
    const disc = (ui.disciplines || []).find((d) => d.body_id === ev.body_id && d.id === ev.discipline);
    const sameItem = (s) => !s.voidedAt && s.kind === p.kind && (p.kind === "car" || s.item === p.item);
    const st = { code, kind: p.kind, item: p.item || null, techSheet: t.sheetId, event: ev.id, eventName: ev.name, body: ev.body_id, bodyName: bodyName(ev.body_id),
      discipline: ev.discipline, disciplineName: disciplineName(ev.body_id, ev.discipline), disciplineShort: ev.discipline ? (disc && disc.short) || String(ev.discipline).toUpperCase() : "",
      season: p.kind === "gear" ? Number(String(ev.starts_on).slice(0, 4)) : null, snapshot: localSnapshot(t, p), issuedBy: me(), issuedAt: now, voidedAt: null, offline: true };
    await putOp({ type: "sticker", event: ev.id, car: t.entry.car_number, email: me(), at: now,
      p: Object.assign({ kind: p.kind, item: p.item, label: p.label, code, offlineAt: now }, t.sheetId ? { techSheet: t.sheetId } : { event: ev.id, carNumber: t.entry.car_number }) });
    // The one it replaces is void, as the server will have it.
    (t.stickers || []).forEach((s) => { if (sameItem(s)) Object.assign(s, { voidedAt: now, voidReason: "replaced", replacedBy: code }); });
    t.stickers = (t.stickers || []).concat(st);
    await addCopySticker(ev.id, Object.assign({}, st, { replaces: sameItem }));
    Stickers.printDialog([st]);
    render();
  }
  // What a sticker printed offline vouches for -- as the server's issue_sticker snapshots it.
  function localSnapshot(t, p) {
    const h = t.header || {};
    if (p.kind === "car") {
      const pics = [].concat(((t.competitor || {}).pictures || {}).car || [], (t.inspection.pictures || {}).car || []);
      return { carNumber: t.entry.car_number, class: h.class, make: h.make, model: h.model, year: h.year, driver: h.driver, codriver: h.codriver,
        photos: pics.filter((x) => x && x.sha256).map((x) => ({ sha256: x.sha256, kind: "car" })) };
    }
    const res = t.inspection.items[p.item] || {}, dec = ((t.competitor || {}).items || {})[p.item] || {};
    const row = TechSheet.lines(t.template, t.variant).flatMap((g) => g.rows).find((r) => r.key === p.item);
    const gear = Object.assign({}, dec.gear, res.gear);
    const photos = [].concat(dec.photos || [], res.photos || []).filter((x) => !(res.removedPhotos || []).includes(x.sha256)).map((x) => ({ sha256: x.sha256, kind: x.kind === "tag" ? "tag" : "item" }));
    const codriver = /\.codriver$/.test(p.item);
    return { category: gear.category || (row && row.item.gear), label: p.label || p.item, occupant: codriver ? "codriver" : /\.driver$/.test(p.item) ? "driver" : null,
      gear, photos, carNumber: t.entry.car_number, driver: codriver ? h.codriver : h.driver };
  }

  // ---- Syncing, in order (photos first: the sheets and stickers use them) ----
  async function syncQueue() {
    if (off.syncing || off.on || !Store || !ui.session || ui.session.offline) return;
    const waiting = off.queue.filter((q) => !q.conflict && !q.error);
    if (!waiting.length) return;
    off.syncing = true;
    render();
    // A car with a change that couldn't sync: its later ones wait too (its stickers need its sheet).
    const blocked = new Set(off.queue.filter((q) => q.conflict || q.error).map((q) => q.event + "#" + q.car));
    let done = 0;
    try {
      for (const q of waiting.filter((x) => x.type === "photo").concat(waiting.filter((x) => x.type !== "photo"))) {
        const car = q.event + "#" + q.car;
        if (q.type !== "photo" && blocked.has(car)) continue;
        try {
          if (q.type === "photo") await syncPhoto(q);
          else if (q.type === "sheet") await syncSheet(q);
          else await syncSticker(q);
          await dropOp(q);
          done++;
        } catch (e) {
          if (isNetworkError(e)) { off.on = true; break; }
          if (q.type === "sheet" && isConflict(e)) {
            // (Its earlier sync went through, only the answer was lost: nothing to resolve.)
            if (await sameAsServer(q)) { await dropOp(q); done++; continue; }
            q.conflict = e.message;
          } else q.error = (e && e.message) || String(e);
          await putOp(q);
          blocked.add(car);
        }
      }
    } finally { off.syncing = false; }
    if (done) {
      say("pass", done + " change" + (done === 1 ? "" : "s") + " made offline synced.");
      if (ui.event && !ui.techSheet && !ui.resolve) await openEvent(ui.event.event.id, true);
      loadEventsOnly();
    }
    render();
  }
  async function syncPhoto(q) {
    const blob = await Store.get("photos", q.sha);
    if (!blob) return;
    const { error } = await sb.storage.from(TECH_BUCKET).upload(q.sha, blob, { contentType: blob.type || "image/jpeg", upsert: false });
    if (error && !/exist|duplicate/i.test(error.message || "") && String(error.statusCode) !== "409") throw error;
  }
  async function syncSheet(q) {
    const s = await rpc("save_tech_sheet", { p_event: q.event, p: Object.assign({}, q.p, { baseUpdatedAt: q.base }) });
    await updateCopySheet(q.event, s);
    const t = ui.techSheet;
    if (t && t.entry.event_id === q.event && t.entry.car_number === q.car) Object.assign(t, { baseUpdatedAt: s.updatedAt || "", sheetId: s.id, status: s.status, localSaved: false });
  }
  async function syncSticker(q) {
    const st = await rpc("issue_sticker", { p: q.p });
    await addCopySticker(q.event, st);
    const t = ui.techSheet;
    if (t && t.stickers) t.stickers = t.stickers.map((s) => (s.code === st.code ? st : s));
  }
  // The server's sheet for a car, now.
  async function serverSheet(eventId, car) {
    const bundle = await rpc("event_bundle", { p_event: eventId });
    if (ui.event && ui.event.event.id === eventId) showEvent(bundle);
    return (bundle.techSheets || []).find((s) => s.carNumber === car) || null;
  }
  const sheetContent = (s) => stable({ header: s.header || {}, variant: s.variant || null, items: (s.inspection || {}).items || {}, corrections: (s.inspection || {}).corrections || "",
    pictures: (s.inspection || {}).pictures || {} });
  async function sameAsServer(q) {
    const s = await serverSheet(q.event, q.car).catch(() => null);
    if (!s || sheetContent(s) !== sheetContent({ header: q.p.header, variant: q.p.variant, inspection: q.p.inspection })) return false;
    if (q.p.finish && s.status !== (q.p.finish === "pass" ? "passed" : "failed")) return false;
    await updateCopySheet(q.event, s);
    return true;
  }
  // A save refused online because the sheet changed meanwhile: kept as a conflict to resolve.
  async function sheetConflict(t, p, e) {
    const ev = ui.event.event;
    const old = sheetOp(ev.id, t.entry.car_number);
    const op = old || { type: "sheet", event: ev.id, car: t.entry.car_number, email: me(), base: t.baseUpdatedAt };
    Object.assign(op, { p, conflict: e.message, error: null, at: new Date().toISOString(),
      local: { carNumber: t.entry.car_number, templateId: t.templateId, template: t.template, variant: t.variant, header: t.header, competitor: t.competitor,
        inspection: JSON.parse(JSON.stringify(t.inspection)), status: t.status, updatedAt: t.baseUpdatedAt } });
    if (Store) await putOp(op);
    closeTechSheet();
    await openResolve(op);
  }

  // ---- Resolving a conflict: the server's version and this device's, line by line ----
  // ui.resolve: { op, server (its sheet now), rows: [{ id, kind, key, label, theirs, mine }], choice: { id: "theirs" | "mine" }, finish }
  async function openResolve(op) {
    let server;
    try { server = await serverSheet(op.event, op.car); }
    catch (e) { return isNetworkError(e) ? say("fail", "Resolving needs a connection: it compares with the server's sheet.") : fail(e); }
    ui.resolve = { op, server, rows: server ? sheetDiffs(server, op.local) : [], choice: {}, finish: false };
    render();
    setTimeout(() => { const el = document.getElementById("resolve-panel"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 0);
  }
  const RESULT_LABEL = { pass: "Pass", fail: "Fail", na: "N/A" };
  function lineSummary(it) {
    if (!it) return "not checked";
    return [RESULT_LABEL[it.result] || "not checked", it.note ? "“" + it.note + "”" : null, (it.photos || []).length ? it.photos.length + " photo" + (it.photos.length === 1 ? "" : "s") : null,
      it.gear ? "gear details entered" : null, it.sticker ? "sticker " + Stickers.fmtCode(it.sticker.code) : null].filter(Boolean).join(" · ");
  }
  function sheetDiffs(server, mine) {
    const rows = [];
    const tpl = server.template || mine.template || {};
    const differ = (a, b) => stable(a === undefined ? null : a) !== stable(b === undefined ? null : b);
    const hs = server.header || {}, hm = mine.header || {};
    (tpl.header || []).map((f) => f.id).concat(Object.keys(hs), Object.keys(hm)).filter((k, i, all) => all.indexOf(k) === i).forEach((k) => {
      if (differ(hs[k] || "", hm[k] || "")) rows.push({ id: "h:" + k, kind: "header", key: k, label: ((tpl.header || []).find((f) => f.id === k) || {}).label || k, theirs: hs[k] || "—", mine: hm[k] || "—" });
    });
    if (differ(server.variant, mine.variant)) rows.push({ id: "variant", kind: "variant", label: "Sheet variant", theirs: server.variant || "—", mine: mine.variant || "—" });
    const is = (server.inspection || {}).items || {}, im = (mine.inspection || {}).items || {};
    const labels = {};
    TechSheet.lines(tpl, server.variant || mine.variant).forEach((g) => g.rows.forEach((r) => { labels[r.key] = (g.section && g.section.title ? g.section.title + " -- " : "") + r.label; }));
    Object.keys(labels).concat(Object.keys(is), Object.keys(im)).filter((k, i, all) => all.indexOf(k) === i).forEach((k) => {
      if (differ(is[k], im[k])) rows.push({ id: "i:" + k, kind: "item", key: k, label: labels[k] || k, theirs: lineSummary(is[k]), mine: lineSummary(im[k]) });
    });
    const cs = (server.inspection || {}).corrections || "", cm = (mine.inspection || {}).corrections || "";
    if (cs !== cm) rows.push({ id: "corrections", kind: "corrections", label: "Corrections required", theirs: cs || "—", mine: cm || "—" });
    const ps = (server.inspection || {}).pictures || {}, pm = (mine.inspection || {}).pictures || {};
    if (differ(ps, pm)) {
      const n = (x) => Object.values(x).reduce((a, l) => a + (Array.isArray(l) ? l.length : 0), 0);
      rows.push({ id: "pictures", kind: "pictures", label: "Car photos", theirs: n(ps) + " photos", mine: n(pm) + " photos" });
    }
    return rows;
  }
  async function saveResolved() {
    const r = ui.resolve, server = r.server, mine = r.op.local, op = r.op;
    if (r.rows.some((row) => !r.choice[row.id])) return say("fail", "Pick, for each difference, which version to keep.");
    const header = Object.assign({}, server.header);
    const insp = server.inspection || {};
    const items = JSON.parse(JSON.stringify(insp.items || {}));
    let corrections = insp.corrections || "", pictures = insp.pictures || {}, variant = server.variant;
    r.rows.filter((row) => r.choice[row.id] === "mine").forEach((row) => {
      if (row.kind === "header") { if (mine.header[row.key] == null) delete header[row.key]; else header[row.key] = mine.header[row.key]; }
      if (row.kind === "variant") variant = mine.variant;
      if (row.kind === "item") { const it = (mine.inspection.items || {})[row.key]; if (it) items[row.key] = it; else delete items[row.key]; }
      if (row.kind === "corrections") corrections = mine.inspection.corrections || "";
      if (row.kind === "pictures") pictures = mine.inspection.pictures || {};
    });
    const finish = r.finish && op.p.finish ? op.p.finish : undefined;
    if (finish === "pass" && TechSheet.counts(server.template, variant, { items }).fail) return say("fail", "Lines are marked Fail in the version picked: it can't be signed off as Passed.");
    const p = { carNumber: op.car, template: server.templateId || undefined, header, variant, seenSubmittedAt: (server.competitor && server.competitor.submittedAt) || "",
      inspection: { items, corrections, pictures }, baseUpdatedAt: server.updatedAt || "", finish, signAs: finish ? op.p.signAs : undefined,
      // (Signed when it was, offline.)
      offlineAt: finish ? op.p.offlineAt : undefined };
    try {
      const s = await rpc("save_tech_sheet", { p_event: op.event, p });
      if (Store && op.key) await dropOp(op);
      await updateCopySheet(op.event, s);
      ui.resolve = null;
      say("pass", "Car #" + op.car + "'s sheet saved with the versions you picked" + (finish ? ", and signed off as " + (finish === "pass" ? "Passed" : "Failed") : "") + ".");
      await openEvent(op.event, true);
      syncQueue();
    } catch (e) {
      if (isConflict(e)) { say("fail", "It changed on the server again meanwhile: compare again."); return openResolve(op); }
      fail(e);
    }
  }
  async function discardOp(op, question) {
    if (question && !confirm(question)) return;
    await dropOp(op);
    if (ui.resolve && ui.resolve.op === op) ui.resolve = null;
    say("pass", "Discarded.");
    if (ui.event) openEvent(ui.event.event.id, true);
    syncQueue();
  }
  function renderResolve() {
    const r = ui.resolve, op = r.op, s = r.server;
    const title = h("div", { class: "account-card-title" }, ["Car #" + op.car + " -- this device's changes and the server's"]);
    const close = btn("Back to the event", () => { ui.resolve = null; render(); }, "small secondary");
    const discard = btn("Discard this device's changes", () => discardOp(op, "Discard car #" + op.car + "'s changes made on this device? The server's sheet stays as it is."), "small secondary");
    if (!s) return h("div", { class: "account-card", id: "resolve-panel" }, [title, desc("The server has no sheet for this car any more."), actions(discard, close)]);
    const by = s.inspectedBy || s.submittedBy;
    const intro = desc("The sheet changed on the server since this device's version (" + [by ? "by " + by : null, s.updatedAt ? when(s.updatedAt) : null].filter(Boolean).join(", ") +
      "). Nothing was overwritten: pick, for each difference, which version to keep, then save.");
    if (s.status === "passed" || s.status === "failed") {
      const sig = ((s.inspection || {}).signatures || {}).scrutineer;
      return h("div", { class: "account-card", id: "resolve-panel" }, [title,
        h("p", { class: "verdict warn" }, ["The server's sheet is signed off as " + (s.status === "passed" ? "Passed" : "Failed") + (sig ? " by " + sig.name + (sig.at ? ", " + when(sig.at) : "") : "") +
          ": this device's changes can't go on a signed sheet. What differs:"]),
        r.rows.length ? h("ul", { class: "account-records" }, r.rows.map((row) => h("li", {}, [h("strong", {}, [row.label]), ": server -- " + row.theirs + "; this device -- " + row.mine]))) : desc("Only the sign-off."),
        actions(discard, close)]);
    }
    const pickAll = (v) => { r.rows.forEach((row) => { r.choice[row.id] = v; }); render(); };
    const choice = (row, v, text) => btn(text, () => { r.choice[row.id] = v; render(); }, r.choice[row.id] === v ? "small" : "small secondary");
    const verdict = op.p.finish ? (op.p.finish === "pass" ? "Passed" : "Failed") : null;
    return h("div", { class: "account-card", id: "resolve-panel" }, [title, intro,
      r.rows.length ? actions(btn("Keep all the server's", () => pickAll("theirs"), "small secondary"), btn("Keep all this device's", () => pickAll("mine"), "small secondary")) : desc("The lines are the same: only the sign-off differs."),
      r.rows.map((row) => h("div", { class: "account-entry resolve-row" }, [
        h("span", { class: "account-entry-main" }, [h("strong", {}, [row.label]),
          h("span", { class: "element-desc" }, [" · server: " + row.theirs]), h("span", { class: "element-desc" }, [" · this device: " + row.mine])]),
        choice(row, "theirs", "Server's"), choice(row, "mine", "This device's"),
      ])),
      // A verdict is never merged on its own: the scrutineer ticks it.
      verdict ? h("label", { class: "account-checks" }, [h("input", { type: "checkbox", checked: r.finish, onchange: (e) => { r.finish = e.target.checked; } }),
        " Also sign it off as " + verdict + ", as done on this device" + (op.p.offlineAt ? " (" + when(op.p.offlineAt) + ")" : "")]) : null,
      actions(btn("Save", saveResolved, "small"), discard, close),
    ]);
  }

  // ---- On the event's page ----
  // Checking a sticker at the event (online, or from the offline copy).
  function checkSticker() {
    Stickers.scanDialog(async (code) => {
      let d;
      try { d = await lookupSticker(code); } catch (e) { return fail(e); }
      if (!d) return say("fail", "There's no sticker " + Stickers.fmtCode(code) + " -- check the code printed under the QR code.");
      if (d.kind === "gear" && !ui.stickerCatalog) ui.stickerCatalog = await TechSheet.loadCatalog().catch(() => null);
      const overlay = h("div", { class: "sticker-dialog-backdrop", onclick: (e) => { if (e.target === overlay) overlay.remove(); } }, [h("div", { class: "sticker-dialog", role: "dialog", "aria-label": "Sticker" }, [
        Stickers.view(d, { photoUrl: techPhotoUrl, standardLabel: stickerStandard, lines: TechSheet.lines,
          onVoid: !off.on && !d.offlineAsOf && d.staff && canIn(d.body, d.discipline, "void_stickers") ? () => { overlay.remove(); voidSticker(d.code); } : null }),
        actions(btn("Close", () => overlay.remove(), "small secondary")),
      ])]);
      document.body.append(overlay);
    });
  }
  // A sticker from the offline copies on this device, shaped like sticker_view()'s answer.
  async function offlineSticker(code) {
    if (!Store) return null;
    const copies = (await Store.all("kv").catch(() => [])).filter((x) => x.key.startsWith("event:")).map((x) => x.value);
    for (const c of copies) {
      const s = c.stickers.find((x) => x.code === code);
      if (!s) continue;
      const ev = c.bundle.event;
      const atEvent = s.event === ev.id ? ev : null;
      const status = s.voidedAt ? "void" : s.kind === "gear" && s.season && s.season < new Date().getFullYear() ? "expired"
        : s.kind === "car" && atEvent && isoDay(0) > isoDay(1, atEvent.ends_on) ? "expired" : "valid";
      const sh = s.kind === "car" ? (c.bundle.techSheets || []).find((x) => (s.techSheet && x.id === s.techSheet) || x.carNumber === (s.snapshot || {}).carNumber) : null;
      const acc = (ui.accreditations || []).find((a) => a.email === s.issuedBy && a.body_id === s.body);
      return Object.assign({}, s, { status, staff: true, inspector: { name: acc ? acc.name : s.issuedBy, license: acc ? acc.license_number : null },
        event: atEvent ? { name: atEvent.name, location: atEvent.location, startsOn: atEvent.starts_on, endsOn: atEvent.ends_on } : null,
        sheet: sh ? { status: sh.status, variant: sh.variant, template: sh.template, signatures: (sh.inspection || {}).signatures || {},
          results: Object.fromEntries(Object.entries((sh.inspection || {}).items || {}).map(([k, v]) => [k, v && v.result])) } : undefined,
        offlineAsOf: s.offline ? s.issuedAt : c.savedAt });
    }
    return null;
  }
  // The event's offline card: download / refresh, what's kept, what waits to sync.
  function renderOffline(b, myRole) {
    if (!Store || SITE !== "scrutineering") return [];
    const ev = b.event, copy = off.copies[ev.id];
    const mine = off.queue.filter((q) => q.event === ev.id);
    const waiting = mine.filter((q) => !q.conflict && !q.error).length;
    const out = [];
    if (off.on) out.push(h("p", { class: "verdict warn" }, [copy
      ? "Offline: working from this device's copy of the event (from " + when(copy.savedAt) + "). What you save stays on this device and syncs once back online."
      : "Offline: this event isn't downloaded on this device, so its sheets can't be saved here -- download it for offline once back online."]));
    out.push(h("div", { class: "account-card" }, [
      h("div", { class: "account-card-title" }, ["Offline copy"]),
      copy ? desc([copy.cars + " cars", copy.sheets + " tech sheets", copy.stickers + " stickers", copy.photos + " photos",
        myRole ? (off.codes[ev.id] || []).length + " sticker codes to print offline" : null, "as of " + when(copy.savedAt)].filter(Boolean).join(" · "))
        : desc("Download this event to work without a connection: its cars and tech sheets, the stickers valid here and their photos stay on this device, refreshed every few minutes while online."),
      waiting ? desc(waiting + " change" + (waiting === 1 ? "" : "s") + " made offline waiting to sync" + (off.syncing ? " -- syncing…" : off.on ? ", once back online." : ".")) : null,
      actions(
        !off.on ? btn(copy ? "Refresh now" : "Download for offline", () => downloadEvent(ev.id), copy ? "small secondary" : "small") : null,
        waiting && !off.on && !off.syncing ? btn("Sync now", syncQueue, "small") : null,
        copy && !off.on ? btn("Remove from this device", () => removeCopy(ev.id), "small secondary") : null),
    ]));
    // What couldn't sync: a conflict to resolve, or the server's reason.
    const stuck = mine.filter((q) => q.conflict || q.error);
    if (stuck.length) out.push(h("div", { class: "account-card" }, [
      h("div", { class: "account-card-title" }, ["Couldn't sync (" + stuck.length + ")"]),
      stuck.map((q) => h("div", { class: "account-entry" }, [
        h("span", { class: "account-entry-main" }, [h("strong", {}, [q.type === "sticker" ? "Sticker " + Stickers.fmtCode(q.p.code) + ", car #" + q.car : q.type === "photo" ? "A photo" : "Car #" + q.car + "'s sheet"]),
          h("span", { class: "element-desc" }, [" · " + (q.conflict ? "it changed on the server since this device's version" : q.error)])]),
        q.conflict ? btn("Compare and resolve", () => (off.on ? say("fail", "Resolving needs a connection.") : openResolve(q)), "small") : null,
        q.error && !off.on ? btn("Retry", async () => { q.error = null; await putOp(q); syncQueue(); }, "small secondary") : null,
        btn("Discard", () => discardOp(q, q.type === "sticker" ? "Discard sticker " + Stickers.fmtCode(q.p.code) + "? It was printed offline and isn't recorded: peel it off the item." :
          q.type === "sheet" ? "Discard car #" + q.car + "'s changes made on this device?" : "Discard this photo?"), "small secondary"),
      ])),
    ]));
    return out;
  }
  // Every minute, online: sync what waits, check a connection that came back, and refresh the
  // offline copies (every 5 minutes) of the events not over.
  setInterval(async () => {
    if (!ui.session || !Store) return;
    if (off.on || ui.session.offline) { if (navigator.onLine) backOnline(); return; }
    syncQueue();
    for (const [id, c] of Object.entries(off.copies)) {
      if (Date.now() - Date.parse(c.savedAt) > 5 * 60 * 1000 && isoDay(0) <= isoDay(1, c.endsOn)) await downloadEvent(id, true);
    }
  }, 60 * 1000);

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
  // In date order: the next event first (one under way counts as next), then
  // the past ones, latest first.
  function renderEventCards(list, emptyText) {
    if (!list.length) return [desc(emptyText)];
    const today = isoDay(0);
    const upcoming = list.filter((e) => (e.endsOn || e.startsOn) >= today).sort((a, b) => (a.scrutineeringStartsOn || a.startsOn).localeCompare(b.scrutineeringStartsOn || b.startsOn));
    const past = list.filter((e) => !upcoming.includes(e)).sort((a, b) => b.startsOn.localeCompare(a.startsOn));
    const card = (e) => h("div", { class: "account-card account-event-card", role: "button", tabindex: "0", onclick: () => openFromList(e.id),
      onkeydown: (k) => { if (k.key === "Enter") openFromList(e.id); } }, [
      h("div", { class: "account-card-title" }, [e.name, " · ", bodyName(e.body) + (e.discipline ? " " + (e.disciplineName || disciplineName(e.body, e.discipline)) : ""), e.open ? h("span", { class: "badge pass" }, ["open"]) : null]),
      desc([e.location, "scrutineering " + fmtDate(e.scrutineeringStartsOn), "event " + fmtDate(e.startsOn) + (e.endsOn !== e.startsOn ? " to " + fmtDate(e.endsOn) : ""),
            e.myRole ? (e.myRole === "chief" ? "you: chief scrutineer" : "you: scrutineer") : "organizer"].filter(Boolean).join(" · ")),
      progress(e),
    ]);
    return [
      upcoming.length ? upcoming.map(card) : desc("No upcoming events."),
      past.length ? h("h3", { class: "account-event-title" }, ["Past events"]) : null,
      past.map(card),
    ];
  }
  function openFromList(id) { leaveTechSheet(() => { ui.eventTab = "competitors"; ui.show = {}; openEvent(id); }); }
  // Create an event, or (eventForm.id) edit the open one -- its body stays.
  function renderCreateEvent() {
    const editing = !!eventForm.id;
    const bodies = organizerBodies();
    if (!bodies.length) return null;
    if (!editing && !bodies.some((b) => b.id === eventForm.body)) eventForm.body = bodies[0].id;
    const set = (k) => (v) => { eventForm[k] = v; };
    return h("div", { class: "account-card" }, [
      h("div", { class: "account-card-title" }, [editing ? "Edit the event" : "Create an event"]),
      h("div", { class: "field-row" }, [
        editing ? field("Sanctioning body", input({ value: bodyName(eventForm.body), disabled: true }, () => {}))
          : field("Sanctioning body", select(bodies.map((b) => [b.id, b.name]), eventForm.body, (v) => { eventForm.body = v; eventForm.discipline = ""; render(); })),
        // A body with disciplines: the event is one discipline's (its scrutineers sign under theirs).
        disciplinesOf(eventForm.body).length ? field("Discipline", select([["", "— pick —"]].concat(disciplinesOf(eventForm.body).map((d) => [d.id, d.name])), eventForm.discipline || "", (v) => { eventForm.discipline = v; })) : null,
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
      actions(btn(editing ? "Save changes" : "Create event", saveEvent),
        btn("Cancel", () => { Object.assign(eventForm, blankEvent()); ui.show.editEvent = false; toggle("createEvent", false); }, "secondary")),
    ]);
  }
  // A form opened by its button (ui.show), and closed by Cancel or the button again.
  function toggle(key, on) {
    ui.show[key] = on === undefined ? !ui.show[key] : on;
    render();
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
        field("Email", input({ value: entryForm.email, inputmode: "email" }, set("email"))),
      ]),
      h("div", { class: "field-row" }, [
        field("Logbook (digital number)", input({ value: entryForm.logbook, placeholder: "leave empty if none" }, set("logbook"))),
        field("or the car: make", input({ value: entryForm.make }, set("make"))),
        field("Model", input({ value: entryForm.model }, set("model"))),
        field("Year", input({ value: entryForm.year }, set("year"))),
      ]),
      actions(btn("Add competitor", addEntry, "small"), btn("Close", () => toggle("addCompetitor", false), "small secondary")),
    ]);
  }
  // ---- Bulk import from MotorsportReg ---------------------------------------
  // MSR's entry list export (CSV): one row per competitor -- registration
  // status, number, name, email, year / make / model / color, class. Read
  // here, checked (numbers taken twice, cars already entered), then saved
  // one entry at a time. ui.msr: { file, rows, skipNew }.
  function parseCsv(text) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.some((x) => x.trim() !== "")) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some((x) => x.trim() !== "")) rows.push(row);
    return rows;
  }
  // "DORU CARAENI" / "kevin dennis" -> "Doru Caraeni" / "Kevin Dennis"; mixed case is left alone.
  function tidyName(s) {
    const t = (s || "").replace(/\s+/g, " ").trim();
    if (t !== t.toUpperCase() && t !== t.toLowerCase()) return t;
    return t.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }
  function msrRows(text) {
    const table = parseCsv(text.replace(/^﻿/, ""));
    if (table.length < 2) throw new Error("That file has no competitors in it.");
    const head = table[0].map((x) => x.trim().toLowerCase());
    const col = (...tests) => head.findIndex((x) => tests.some((t) => (t instanceof RegExp ? t.test(x) : x === t)));
    const c = {
      status: col(/^registration status$/, /status/), number: col("no.", "no", "number", "car number", /^car ?#$/, "#"),
      name: col(/^full name/, "name", "driver"), first: col("first name"), last: col("last name"), email: col("e-mail", "email", /e-?mail/),
      year: col("year"), make: col("make"), model: col("model"), color: col("color", "colour"),
      cls: col(/^class \(long/, /^class/), codriver: col(/co-?driver/),
    };
    if (c.number < 0 || (c.name < 0 && c.first < 0)) throw new Error("That doesn't look like a MotorsportReg entry list: it needs the number (No.) and name columns.");
    const get = (r, i) => (i >= 0 ? (r[i] || "").replace(/\s+/g, " ").trim() : "");
    return table.slice(1).map((r) => {
      const year = get(r, c.year);
      return {
        status: get(r, c.status), carNumber: get(r, c.number),
        driver: tidyName(c.name >= 0 ? get(r, c.name) : get(r, c.first) + " " + get(r, c.last)),
        codriver: tidyName(get(r, c.codriver)), email: get(r, c.email).toLowerCase(), class: get(r, c.cls),
        vehicle: { year: /^[1-9]\d{3}$/.test(year) ? year : "", make: get(r, c.make), model: get(r, c.model), color: get(r, c.color) },
        include: true,
      };
    }).filter((x) => x.carNumber || x.driver);
  }
  function chooseMsrFile() {
    const fileInput = h("input", { type: "file", accept: ".csv,text/csv", onchange: async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try { ui.msr = { file: file.name, rows: msrRows(await file.text()), skipNew: false }; render(); }
      catch (e) { fail(e); }
    } });
    fileInput.click();
  }
  // Each row's problem, if any: no number, or a number another row also has.
  function msrCheck(m) {
    const used = {};
    m.rows.forEach((x) => { if (msrIncluded(m, x)) used[x.carNumber] = (used[x.carNumber] || 0) + 1; });
    return (x) => (!msrIncluded(m, x) ? null : !x.carNumber ? "no number" : used[x.carNumber] > 1 ? "number taken twice -- change one" : null);
  }
  const msrIncluded = (m, x) => x.include && !(m.skipNew && /^new$/i.test(x.status));
  async function importMsr() {
    const m = ui.msr, b = ui.event, problem = msrCheck(m);
    const rows = m.rows.filter((x) => msrIncluded(m, x));
    if (rows.some(problem)) return say("fail", "Fix the rows marked in red first (or untick them).");
    let n = 0, updated = 0;
    try {
      for (const x of rows) {
        ui.busy = "Importing competitors: " + (++n) + " of " + rows.length + "…"; render();
        // A car already entered keeps its logbook, co-driver (MSR has none) and tech status.
        const was = b.entries.find((e) => e.entry.car_number === x.carNumber);
        if (was) updated++;
        await rpc("save_entry", { p_event: b.event.id, p: {
          carNumber: x.carNumber, driver: x.driver, class: x.class, email: x.email,
          codriver: x.codriver || (was && was.entry.codriver) || null,
          logbookId: (was && was.entry.logbook_id) || null,
          vehicle: was && was.entry.logbook_id ? was.entry.vehicle : x.vehicle,
        } });
      }
      ui.busy = null; ui.msr = null; ui.show.msrImport = false;
      await openEvent(b.event.id); loadEventsOnly();
      say("pass", "Imported " + rows.length + " competitors from MotorsportReg" + (updated ? " (" + updated + " already entered, updated)" : "") + ".");
    } catch (e) { ui.busy = null; await openEvent(b.event.id); fail(e); }
  }
  function renderMsrImport() {
    const m = ui.msr;
    const close = () => { ui.msr = null; toggle("msrImport", false); };
    if (!m) {
      return h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, ["Bulk import from MotorsportReg"]),
        desc("In MotorsportReg, export the event's entry list as CSV (with the number, name, email, year, make, model, color and class columns), then choose the file here. You'll see the list before anything is saved."),
        actions(btn("Choose the CSV file", chooseMsrFile, "small"), btn("Close", close, "small secondary")),
      ]);
    }
    const problem = msrCheck(m);
    const existing = (x) => ui.event.entries.find((e) => e.entry.car_number === x.carNumber);
    const sameDriver = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
    const shown = m.rows.filter((x) => msrIncluded(m, x));
    const newOnes = m.rows.filter((x) => /^new$/i.test(x.status)).length;
    const bad = shown.filter(problem).length;
    return h("div", { class: "account-card" }, [
      h("div", { class: "account-card-title" }, ["Bulk import from MotorsportReg -- " + m.file]),
      desc([shown.length + " to import", shown.filter(existing).length ? shown.filter(existing).length + " already entered (updated, keeping their logbook)" : null,
        bad ? bad + " to fix" : null].filter(Boolean).join(" · ")),
      newOnes ? h("label", { class: "account-checks" }, [h("input", { type: "checkbox", checked: m.skipNew, onchange: (e) => { m.skipNew = e.target.checked; render(); } }),
        " Skip the " + newOnes + " registration" + (newOnes === 1 ? "" : "s") + " still \"New\" in MotorsportReg (not confirmed)"]) : null,
      h("table", { class: "account-table msr-table" }, [
        h("tr", {}, ["", "No.", "Driver", "Class", "Car", "Email", ""].map((t) => h("th", {}, [t]))),
        m.rows.map((x, i) => {
          const skipped = !msrIncluded(m, x);
          const p = problem(x);
          return h("tr", { class: skipped ? "msr-skipped" : p ? "msr-problem" : "" }, [
            h("td", {}, [h("input", { type: "checkbox", checked: x.include, title: "Import this row", onchange: (e) => { x.include = e.target.checked; render(); } })]),
            h("td", {}, [h("input", { type: "text", class: "msr-number", value: x.carNumber, "data-id": "msr-" + i, oninput: (e) => { x.carNumber = e.target.value.trim(); render(); restoreFocus("msr-" + i); } })]),
            h("td", {}, [x.driver]),
            h("td", {}, [x.class]),
            h("td", {}, [[x.vehicle.year, x.vehicle.make, x.vehicle.model].filter(Boolean).join(" ") + (x.vehicle.color ? " (" + x.vehicle.color + ")" : "")]),
            h("td", {}, [x.email]),
            h("td", {}, [p ? h("span", { class: "badge req" }, [p]) : /^new$/i.test(x.status) ? h("span", { class: "badge info", title: "Registration not confirmed yet in MotorsportReg" }, ["new"]) : null,
              !p && existing(x) ? (sameDriver(existing(x).entry.driver, x.driver) || !existing(x).entry.driver
                ? h("span", { class: "badge info", title: "Already entered: updated, keeping its logbook and tech status" }, ["update"])
                : h("span", { class: "badge cond", title: "Car " + x.carNumber + " is entered for " + existing(x).entry.driver + " -- importing replaces them" }, ["replaces " + existing(x).entry.driver])) : null]),
          ]);
        }),
      ]),
      actions(btn("Import " + shown.length + " competitors", importMsr, "small"), btn("Choose another file", chooseMsrFile, "small secondary"), btn("Cancel", close, "small secondary")),
    ]);
  }
  function tabs(list, current, onPick) {
    return h("div", { class: "account-tabs", role: "tablist" }, list.map(([id, label]) =>
      h("button", { type: "button", role: "tab", "aria-selected": String(id === current), class: "account-tab" + (id === current ? " on" : ""), onclick: () => onPick(id) }, [label])));
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
    const open = eventOpenNow(ev);
    const q = entryFilter.trim().toLowerCase();
    const matches = (x) => !q || [x.entry.car_number, x.entry.driver, x.entry.codriver, x.logbook && x.logbook.digital_number, x.logbook && x.logbook.make, x.logbook && x.logbook.model]
      .some((s) => s && String(s).toLowerCase().includes(q));
    const entries = b.entries.filter((x) => x.entry.tech_status !== "withdrawn" && matches(x));
    const carDesc = (x) => (x.logbook ? carLine(x.logbook) + " · " + x.logbook.digital_number : carLine(x.entry.vehicle || {}) + " · no logbook");
    // With a tech sheet (the event has one): open the car's sheet; without,
    // the plain Passed / Failed of before.
    const hasSheet = eventSheets(b).length > 0 || (b.techSheets || []).length > 0;
    const teamSheet = (x) => (b.techSheets || []).find((s) => s.carNumber === x.entry.car_number && s.competitor);
    // A car's sheet and how far it is: { sheet, c: counts } or null.
    const sheetProgress = (x) => {
      const s = (b.techSheets || []).find((y) => y.carNumber === x.entry.car_number);
      return s && s.template ? { sheet: s, c: TechSheet.counts(s.template, s.variant, s.inspection || { items: {} }) } : null;
    };
    const allChecked = (x) => { const p = sheetProgress(x); return !!p && p.c.total > 0 && p.c.todo === 0; };
    const isReTech = (x) => { const p = sheetProgress(x); return !!p && ((p.sheet.inspection || {}).history || []).length > 0; };
    const entryRow = (x, withButtons) => h("div", { class: "account-entry" }, [
      h("span", { class: "account-car-number" }, ["#" + x.entry.car_number]),
      h("span", { class: "account-entry-main" }, [
        h("strong", {}, [[x.entry.driver, x.entry.codriver].filter(Boolean).join(" / ") || "—"]),
        h("span", { class: "element-desc" }, [" " + carDesc(x) + (x.entry.class ? " · " + x.entry.class : "") + (kind === "organize" && x.entry.email ? " · " + x.entry.email : "")]),
        teamSheet(x) ? h("span", { class: "badge info", title: "The team pre-filled its tech sheet" }, ["team sheet"]) : null,
        (() => { const s = (b.techSheets || []).find((y) => y.carNumber === x.entry.car_number);
          return s && s.lockedBy && s.lockedBy !== ui.roles.email ? h("span", { class: "badge cond", title: "Its sheet is open on " + s.lockedBy + "'s device" }, ["open: " + s.lockedBy]) : null; })(),
        // Changed on this device, not synced yet -- or in conflict with the server's.
        (() => { const s = (b.techSheets || []).find((y) => y.carNumber === x.entry.car_number);
          return !s ? null : s.conflict ? h("span", { class: "badge req", title: "Changed on the server since this device's version: compare and resolve (above)" }, ["conflict"])
            : s.syncError ? h("span", { class: "badge req", title: s.syncError }, ["didn't sync"])
            : s.local ? h("span", { class: "badge cond", title: "Saved on this device (offline): it syncs once back online" }, ["not synced"]) : null; })(),
        // Its sheet's progress, until it's signed off.
        x.entry.tech_status === "pending" && sheetProgress(x) ? (() => { const c = sheetProgress(x).c; return h("span", { class: "badge " + (c.fail ? "req" : c.todo ? "info" : "pass") },
          [c.todo ? c.total - c.todo + "/" + c.total + " checked" : "all checked" + (c.fail ? " · " + c.fail + " fail" : "")]); })() : null,
      ]),
      withButtons && hasSheet ? btn("Tech sheet", () => openTechSheet(x), "small secondary") : null,
      x.entry.tech_status === "pending"
        ? (withButtons && !hasSheet && x.logbook && myRole && open && can(ev.body_id, "add_logbook_entries") ? h("span", {}, [btn("Passed", () => inspect(x.entry, true), "small"), " ", btn("Failed", () => inspect(x.entry, false), "small secondary")])
          : h("span", { class: "badge " + (isReTech(x) && !allChecked(x) ? "cond" : "info") }, [allChecked(x) ? "to sign off" : isReTech(x) ? "re-tech" : "to inspect"]))
        : h("span", { class: "badge " + (x.entry.tech_status === "passed" ? "pass" : "req") }, [x.entry.tech_status]),
    ]);
    const filterBox = h("div", { class: "field-row" }, [field("Find a car", input({ value: entryFilter, "data-id": "entry-filter", placeholder: "car number, driver, car…" }, (v) => { entryFilter = v; render(); restoreFocus("entry-filter"); }))]);
    const out = [
      actions(btn("← All events", () => leaveTechSheet(() => { ui.event = null; render(); }), "small secondary"),
        kind === "scrutineer" && !ui.techSheet ? btn("🔳 Check a sticker", checkSticker, "small secondary") : null,
        kind === "scrutineer" && !ui.techSheet && !off.on ? btn("Print the event's stickers", printEventStickers, "small secondary") : null),
      h("h3", { class: "account-event-title" }, [ev.name + " -- " + bodyName(ev.body_id) + (ev.discipline ? " " + disciplineName(ev.body_id, ev.discipline) : "")]),
      desc([fmtDate(ev.starts_on) + (ev.ends_on !== ev.starts_on ? " to " + fmtDate(ev.ends_on) : ""), ev.location,
        "accepts logbooks from " + ev.accepted_bodies.map(bodyName).join(", "),
        open ? "open for records" : "not open for records (scrutineering " + fmtDate(ev.scrutineering_starts_on) + " to the day after " + fmtDate(ev.ends_on) + ")"].filter(Boolean).join(" · ")),
    ];
    // Tech sheets with nobody on the staff who can record Passed / Failed (event_bundle's canSignOff per staff member).
    const signers = b.staff.filter((s) => s.canSignOff);
    const noSigner = hasSheet && (!b.staff.length || (b.staff.some((s) => s.canSignOff !== undefined) && !signers.length));
    if (noSigner) out.push(h("p", { class: "verdict warn" }, [b.staff.length
      ? "Nobody on this event's staff can sign off tech sheets (Passed / Failed): add a scrutineer who can, or give one the \"Sign off tech sheets\" permission" + (ev.discipline ? " for " + disciplineName(ev.body_id, ev.discipline) : "") + "."
      : "This event has no staff yet: add a scrutineer who can sign off tech sheets (Passed / Failed)."]));
    // Adding competitors: one at a time, or (soon) the MotorsportReg list.
    const canAdd = organizer || myRole === "chief";
    const addButtons = canAdd ? actions(
      btn("Add competitor", () => toggle("addCompetitor"), ui.show.addCompetitor ? "small" : "small secondary"),
      kind === "organize" ? btn("Bulk import from MSR", () => toggle("msrImport"), ui.show.msrImport ? "small" : "small secondary") : null,
    ) : null;
    const addForms = canAdd ? [ui.show.addCompetitor ? renderAddCompetitor() : null, kind === "organize" && ui.show.msrImport ? renderMsrImport() : null] : [];
    if (kind === "organize") {
      out.push(tabs([["competitors", "Competitor management"], ["admin", "Admin"]], ui.eventTab, (t) => { ui.eventTab = t; render(); }));
      if (ui.eventTab === "competitors") {
        out.push(addButtons, addForms, filterBox);
        out.push(h("div", { class: "account-card" }, [h("div", { class: "account-card-title" }, ["Competitors (" + entries.length + ")"]), entries.length ? entries.map((x) => entryRow(x, false)) : desc("None yet.")]));
        return out;
      }
      if (ui.show.editEvent && eventForm.id === ev.id) out.push(renderCreateEvent());
      else if (organizer) out.push(h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, ["The event"]),
        desc([ev.name, ev.location, "scrutineering " + fmtDate(ev.scrutineering_starts_on), "event " + fmtDate(ev.starts_on) + (ev.ends_on !== ev.starts_on ? " to " + fmtDate(ev.ends_on) : ""),
          "accepts logbooks from " + ev.accepted_bodies.map(bodyName).join(", ")].filter(Boolean).join(" · ")),
        actions(btn("Edit event", editEvent, "small secondary")),
      ]));
      out.push(h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, ["Staff"]),
        b.staff.length ? h("ul", { class: "account-records" }, b.staff.map((s) => h("li", {}, [
          s.email + (s.role === "chief" ? " -- chief scrutineer" : "") + " ",
          hasSheet && s.canSignOff === false ? h("span", { class: "badge cond", title: "Their accreditation for this event doesn't hold \"Sign off tech sheets\": they fill sheets in and save, someone else records Passed / Failed" }, ["can't sign off"]) : null,
          organizer ? [" ", btn("Remove", () => removeStaff(s.email), "small secondary")] : null,
        ]))) : desc("No staff yet: add the chief scrutineer and the scrutineers working the event."),
        organizer ? h("div", { class: "field-row" }, [
          field("Email", input({ value: staffForm.email, inputmode: "email" }, (v) => { staffForm.email = v; })),
          field("Role", select([["scrutineer", "Scrutineer"], ["chief", "Chief scrutineer"]], staffForm.role, (v) => { staffForm.role = v; })),
        ]) : null,
        organizer ? actions(btn("Add to staff", addStaff, "small")) : null,
      ]));
      // The sheets the event uses -- one per group of classes (X / non-X, formula / GT...): the
      // body's own (or its automatic one, from the ruleset) by default.
      const choices = (ui.techTemplates || []).filter((t) => t.body_id === ev.body_id || (!t.body_id && t.definition && t.definition.bodyId === ev.body_id));
      const sheets = eventSheets(b);
      const ed = ui.sheetsEdit && ui.sheetsEdit.event === ev.id ? ui.sheetsEdit : null;
      out.push(h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, ["Tech sheets"]),
        ed ? [
          desc("A car gets the sheet listing its class (event class codes, comma-separated); a sheet with no classes is for all the others. Teams pick theirs in PassTech."),
          ed.rows.map((r, i) => h("div", { class: "field-row event-sheet-row" }, [
            field("Sheet", select(choices.map((t) => [t.id, t.title + (t.body_id ? "" : " (automatic, from ruleset)")]).concat(sheets.filter((t) => !choices.some((c) => c.id === t.id)).map((t) => [t.id, t.title])), r.template, (v) => { r.template = v; })),
            field("Classes", input({ value: r.classes, placeholder: "e.g. X, XS -- empty: all other classes" }, (v) => { r.classes = v; })),
            ed.rows.length > 1 ? btn("Remove", () => { ed.rows.splice(i, 1); render(); }, "small secondary") : null,
          ])),
          actions(
            choices.length > ed.rows.length ? btn("Add a tech sheet", () => { ed.rows.push({ template: (choices.find((c) => !ed.rows.some((r) => r.template === c.id)) || choices[0]).id, classes: "" }); render(); }, "small secondary") : null,
            btn("Save", () => saveEventSheets(ev.id, ed.rows), "small"),
            btn("Use the body's default", () => saveEventSheets(ev.id, []), "small secondary"),
            btn("Cancel", () => { ui.sheetsEdit = null; render(); }, "small secondary"),
          ),
        ] : [
          sheets.length ? h("ul", { class: "account-records" }, sheets.map((t) => h("li", {}, [h("strong", {}, [t.title]), (t.body ? "" : " (automatic, from ruleset)") + sheetClasses(t)])))
            : desc("No tech sheet for this body yet -- add one under its scrutineers in Admin mode."),
          sheets.length ? desc("Scrutineers fill " + (sheets.length > 1 ? "the sheet for each car's class" : "it for each car") + "; teams can pre-fill theirs in PassTech.") : null,
          organizer && choices.length ? actions(btn("Change tech sheets", () => {
            ui.sheetsEdit = { event: ev.id, rows: sheets.length ? sheets.map((t) => ({ template: t.id, classes: (t.classes || []).join(", ") })) : [{ template: choices[0].id, classes: "" }] };
            render();
          }, "small secondary")) : null,
        ],
      ]));
      return out;
    }
    // To inspect; every line checked but not signed off yet (Passed / Failed waits for the
    // scrutineering window); passed; failed.
    const pending = entries.filter((x) => x.entry.tech_status === "pending");
    // Failed, then the team re-submitted what failed: only those lines to check again.
    const reTech = pending.filter((x) => !allChecked(x) && isReTech(x));
    const toInspect = pending.filter((x) => !allChecked(x) && !isReTech(x));
    const toSign = pending.filter(allChecked);
    const passed = entries.filter((x) => x.entry.tech_status === "passed");
    const failed = entries.filter((x) => x.entry.tech_status === "failed");
    // Offline: the copy, what waits to sync; a conflict being resolved: only that.
    if (ui.resolve && ui.resolve.op.event === ev.id) return out.concat(renderResolve());
    if (!ui.techSheet) out.push(renderOffline(b, myRole));
    // A car's sheet open (or its sheet being picked): only that, until it's closed.
    if (ui.techSheetPick && ui.techSheetPick.entry.event_id === ev.id) return out.concat(renderTechSheetPick());
    if (ui.techSheet && ui.techSheet.entry.event_id === ev.id) return out.concat(renderTechSheet());
    const withLogbook = b.entries.filter((x) => x.logbook);
    if (withLogbook.length && SITE === "logbook") {
      out.push(actions(btn("Download this event's logbooks to this device (" + withLogbook.length + ")",
        () => downloadMany(withLogbook.map((x) => x.logbook.id), "Downloading"), "small secondary")));
    }
    // Teams' sheets for cars not on the competitor list yet.
    const orphans = (b.techSheets || []).filter((s) => !b.entries.some((x) => x.entry.car_number === s.carNumber));
    if (orphans.length) out.push(desc("Tech sheets from teams not on the competitor list yet: " + orphans.map((s) => "#" + s.carNumber + (s.header && s.header.driver ? " " + s.header.driver : "")).join(", ") +
      (myRole === "chief" ? " -- add them (Add competitor) to inspect them." : " -- the chief scrutineer adds them.")));
    // The chief scrutineer can add a late entry from here too.
    out.push(addButtons, addForms, filterBox);
    // Cars waiting for sign-off first (a click from done), then the ones still to inspect.
    if (toSign.length) out.push(h("div", { class: "account-card" }, [h("div", { class: "account-card-title" }, ["Checked -- waiting for sign-off (" + toSign.length + ")"]),
      desc(open ? "Every line has a result: open the sheet and finish it as Passed or Failed." : "Every line has a result. Passed / Failed can be recorded once scrutineering opens (" + fmtDate(ev.scrutineering_starts_on) + ")."),
      toSign.map((x) => entryRow(x, true))]));
    if (reTech.length) out.push(h("div", { class: "account-card" }, [h("div", { class: "account-card-title" }, ["Ready for re-tech (" + reTech.length + ")"]),
      desc("Failed, then the team re-submitted what failed: open the sheet -- the lines they changed are marked \"updated by the team\"."),
      reTech.map((x) => entryRow(x, true))]));
    out.push(h("div", { class: "account-card" }, [h("div", { class: "account-card-title" }, ["To inspect (" + toInspect.length + ")"]), toInspect.length ? toInspect.map((x) => entryRow(x, true)) : desc("None.")]));
    out.push(h("div", { class: "account-card" }, [h("div", { class: "account-card-title" }, ["Passed (" + passed.length + ")"]), passed.length ? passed.map((x) => entryRow(x, true)) : desc("None yet.")]));
    if (failed.length) out.push(h("div", { class: "account-card" }, [h("div", { class: "account-card-title" }, ["Failed (" + failed.length + ")"]), failed.map((x) => entryRow(x, true))]));
    return out;
  }

  // ---- Administration (System admins, technical directors) -----------
  const bodyForm = { id: "", name: "", note: "" };
  // permissions: the new scrutineer's (null: the defaults the caller can grant).
  const accForm = { email: "", name: "", body: "", role: "scrutineer", license: "", code: "", expires: "", permissions: null };
  let adminEmail = "";
  async function saveBody() {
    try { await rpc("save_body", { p_id: bodyForm.id.trim().toLowerCase(), p_name: bodyForm.name.trim(), p_number_note: bodyForm.note.trim() || null }); Object.assign(bodyForm, { id: "", name: "", note: "" }); ui.show.addBody = false; ui.show.editBody = false; say("pass", "Sanctioning body saved."); loadAll(); }
    catch (e) { fail(e); }
  }
  async function grant() {
    try {
      await rpc("grant_accreditation", { p_email: accForm.email, p_name: accForm.name, p_body: accForm.body, p_role: accForm.role, p_license: accForm.license || null, p_code: accForm.code || null, p_expires: accForm.expires || null,
        p_permissions: accForm.role === "scrutineer" ? accForm.permissions : null, p_discipline: accForm.discipline || null });
      Object.assign(accForm, { email: "", name: "", license: "", code: "", expires: "", permissions: null });
      ui.show.addAcc = false;
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
  async function savePermissions(a, perms) {
    try {
      await rpc("set_accreditation_permissions", { p_id: a.id, p_permissions: perms });
      ui.permEdit = null;
      say("pass", a.name + "'s permissions saved.");
      loadAll();
    } catch (e) { fail(e); }
  }
  // The permission checkboxes for an accreditation in a discipline (null: all of the body's): the
  // ones the caller doesn't hold there can't be ticked (a System admin holds them all).
  function permissionBoxes(body, disc, perms, onChange) {
    return h("div", { class: "account-permissions" }, PERMISSIONS.map(([p, label]) => h("label", { class: "account-checks", title: canIn(body, disc, p) ? "" : "You don't hold this permission here, so you can't grant it" }, [
      h("input", { type: "checkbox", checked: perms.includes(p), disabled: !canIn(body, disc, p), onchange: (e) => onChange(e.target.checked ? perms.concat(p) : perms.filter((x) => x !== p)) }),
      " " + label,
    ])));
  }
  // A body's disciplines: add, rename, archive (System admins, all-disciplines technical directors).
  const discForm = { id: "", name: "", short: "" };
  async function saveDiscipline(b, d, archived) {
    const x = d || discForm;
    if (!x.id.trim() || !x.name.trim()) return say("fail", "A discipline needs a short id (e.g. autox) and a name (e.g. Autocross).");
    try {
      await rpc("save_discipline", { p_body: b.id, p_id: x.id.trim().toLowerCase(), p_name: x.name.trim(), p_short: (x.short || "").trim() || null, p_archived: !!archived });
      if (!d) Object.assign(discForm, { id: "", name: "", short: "" });
      ui.show.addDisc = false;
      say("pass", "Discipline saved.");
      loadAll();
    } catch (e) { fail(e); }
  }
  function renderDisciplines(b, list) {
    const set = (k) => (v) => { discForm[k] = v; };
    return h("div", { class: "account-card" }, [
      h("div", { class: "account-card-title" }, ["Disciplines"]),
      desc(list.length ? "Each discipline has its own events, scrutineers and annual stickers. A scrutineer accredited for all disciplines works them all."
        : "None: " + b.name + " works as one. Add disciplines (e.g. Autocross, Gravel Trials) when they have their own events, scrutineers and stickers."),
      list.map((d) => h("div", { class: "account-entry" }, [
        h("span", { class: "account-entry-main" }, [h("strong", {}, [d.name]), h("span", { class: "element-desc" }, [" · " + d.id + " · on stickers: " + (d.short || d.id.toUpperCase()) + (d.archived_at ? " · archived" : "")])]),
        btn(d.archived_at ? "Restore" : "Archive", () => saveDiscipline(b, { id: d.id, name: d.name, short: d.short || "" }, !d.archived_at), "small secondary"),
      ])),
      actions(btn("Add a discipline", () => toggle("addDisc"), ui.show.addDisc ? "small" : "small secondary")),
      ui.show.addDisc ? [h("div", { class: "field-row" }, [
        field("Short id", input({ value: discForm.id, placeholder: "e.g. autox" }, set("id"))),
        field("Name", input({ value: discForm.name, placeholder: "e.g. Autocross" }, set("name"))),
        field("On stickers", input({ value: discForm.short, placeholder: "e.g. AUTOX" }, set("short"))),
      ]), actions(btn("Save discipline", () => saveDiscipline(b, null, false), "small"), btn("Cancel", () => toggle("addDisc", false), "small secondary"))] : null,
    ]);
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
  // ---- Tech sheet templates (a body's own; the automatic ones from the rulesets) ----
  // ui.templateEdit: { body, id (null: a new copy), key, def (edited in place) }
  const bodyTemplates = (body) => (ui.techTemplates || []).filter((t) => t.body_id === body);
  const libraryFor = (body) => (ui.techTemplates || []).filter((t) => !t.body_id && t.definition && t.definition.bodyId === body);
  // A new, empty sheet: the usual header fields and sign-off, no lines yet.
  function blankTemplate(body) {
    const taken = bodyTemplates(body).map((t) => t.key);
    let key = body + "-tech-sheet", n = 2;
    while (taken.includes(key)) key = body + "-tech-sheet-" + n++;
    const f = (id, label, prefill, required) => Object.assign({ id, label, type: "text" }, prefill ? { prefill } : {}, required ? { required: true } : {});
    return { key, blank: true, title: "New tech sheet", definition: {
      format: 1, id: key, bodyId: body, title: bodyName(body) + " Tech Sheet", revision: isoDay(0),
      header: [f("event", "Event", "event"), f("car_number", "Car number", "car_number", true), f("class", "Class", "class"), f("driver", "Driver", "driver", true),
        f("codriver", "Co-driver", "codriver"), f("make", "Make", "make"), f("model", "Model", "model"), f("year", "Year", "year"), f("vin", "VIN", "vin"),
        f("logbook_number", "Logbook number", "logbook_number")],
      sections: [],
      signoff: [{ id: "scrutineer", label: "Scrutineer", license: true }, { id: "chief", label: "Chief Scrutineer", license: false }],
    } };
  }
  function uniqueKey(body, base) {
    const taken = bodyTemplates(body).map((t) => t.key);
    let key = base, n = 2;
    while (taken.includes(key)) key = base + "-" + n++;
    return key;
  }
  function copyTemplate(body, t) {
    editTemplate(body, Object.assign({}, t, { key: t.key + "-copy", definition: Object.assign({}, t.definition, { title: t.title + " (copy)" }) }), true);
    ui.templateEdit.copyOf = t.title;
    render();
  }
  function editTemplate(body, t, asCopy) {
    const key = asCopy ? uniqueKey(body, t.key) : t.key;
    ui.templateEdit = { body, id: asCopy ? null : t.id, key, blank: !!t.blank, public: !asCopy && !!t.public, def: JSON.parse(JSON.stringify(t.definition)) };
    if (asCopy) {
      const from = ui.templateEdit.def.bodyId;
      Object.assign(ui.templateEdit.def, { bodyId: body, id: key });
      // (Copied from another body's sheet: its PassTech rulesets were that body's -- the editor picks this one's.)
      if (from && from !== body) delete ui.templateEdit.def.passtechRulesetIds;
    }
    render();
  }
  async function saveTemplate() {
    const e = ui.templateEdit;
    if (!(e.def.title || "").trim()) return say("fail", "The sheet needs a title.");
    try {
      await rpc("save_tech_sheet_template", { p: { id: e.id || undefined, body: e.body, key: e.key, title: e.def.title.trim(), public: !!e.public, definition: e.def } });
      ui.templateEdit = null;
      say("pass", "Tech sheet saved for " + bodyName(e.body) + ".");
      loadAll();
    } catch (err) { fail(err); }
  }
  function renderBodyTechSheets(b) {
    const own = bodyTemplates(b.id);
    const lib = libraryFor(b.id).filter((t) => !own.some((o) => o.key === t.key));
    const editing = ui.templateEdit && ui.templateEdit.body === b.id ? ui.templateEdit : null;
    // Sheets other bodies have saved (not their automatic ones), to start from a copy.
    const others = (ui.techTemplates || []).filter((t) => t.body_id && t.body_id !== b.id)
      .sort((x, y) => bodyCode(x.body_id).localeCompare(bodyCode(y.body_id)) || x.title.localeCompare(y.title));
    return h("div", { class: "account-section-body" }, [
      h("div", { class: "account-card-title" }, ["Tech sheets"]),
      own.length ? own.map((t) => h("div", { class: "account-entry" }, [
        h("span", { class: "account-entry-main" }, [h("strong", {}, [t.title]), h("span", { class: "element-desc" }, [" version " + t.version + " · " + TechSheet.counts(t.definition, null, null).total + " lines · updated " + fmtDate(String(t.updated_at).slice(0, 10))])]),
        h("span", { class: "badge " + (t.public ? "pass" : "info"), title: t.public ? "Listed in PassTech as " + bodyCode(b.id) + "'s generic tech sheet" : "Only used by the events it's attached to" }, [t.public ? "Public" : "Private"]),
        btn("Edit", () => editTemplate(b.id, t, false), "small secondary"),
        btn("Copy", () => copyTemplate(b.id, t), "small secondary"),
      ])) : desc("No tech sheet of its own yet." + (lib.length ? " Its events use the automatic tech sheet from the ruleset, " + lib[0].title + ", until it has one." : "")),
      // One way to start a sheet: blank, from its ruleset's automatic one, or a copy of a saved sheet (its own or another body's).
      !editing ? h("div", { class: "account-actions" }, [
        h("select", { class: "techsheet-start", "aria-label": "Start a new tech sheet", onchange: (e) => {
          const v = e.target.value;
          if (v === "blank") return editTemplate(b.id, blankTemplate(b.id), true);
          const mine = lib.find((x) => x.id === v);
          if (mine) return editTemplate(b.id, mine, true);
          const t = own.concat(others).find((x) => x.id === v);
          if (t) copyTemplate(b.id, t);
        } }, [
          h("option", { value: "" }, ["Start a new tech sheet…"]),
          h("option", { value: "blank" }, ["Blank sheet"]),
          lib.length ? h("optgroup", { label: "Automatic tech sheet from " + bodyCode(b.id) + "'s ruleset" }, lib.map((t) => h("option", { value: t.id, title: (t.definition.source || {}).form || "" }, [t.title]))) : null,
          own.length || others.length ? h("optgroup", { label: "Copy an existing tech sheet" }, own.concat(others).map((t) =>
            h("option", { value: t.id }, [t.title + (t.body_id === b.id ? "" : " (" + bodyCode(t.body_id) + ")")]))) : null,
        ]),
      ]) : null,
      editing ? h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, [editing.id ? "Editing: " + editing.def.title : editing.blank ? "New blank sheet for " + bodyName(b.id) : editing.copyOf ? "New sheet for " + bodyName(b.id) + ", a copy of " + editing.copyOf : "New sheet for " + bodyName(b.id) + ", from " + editing.def.title]),
        // Private: only for the events it's attached to. Public: also PassTech's generic sheet for the body.
        TechSheet.isPreview(editing.def) ? null : h("div", { class: "techsheet-visibility" }, [
          h("span", {}, ["Visibility: "]),
          [[false, "Private", "only used by the events it's attached to"], [true, "Public", "also listed in PassTech as " + bodyCode(b.id) + "'s generic tech sheet, for competitors to pre-fill without an event"]].map(([v, label, text]) =>
            h("label", {}, [h("input", { type: "radio", name: "techsheet-visibility", checked: !!editing.public === v, onchange: () => { editing.public = v; render(); } }), " ", h("strong", {}, [label]), " -- " + text])),
        ]),
        // To compare with: the body's automatic sheet(s), then its own others.
        TechSheet.editor(editing.def, (rerender) => { if (rerender) render(); }, { references: libraryFor(b.id).map((t) => ({ id: t.id, title: t.title, builtIn: true, definition: t.definition }))
          .concat(own.filter((t) => t.id !== editing.id).map((t) => ({ id: t.id, title: t.title, definition: t.definition }))) }),
        // Not while previewing (Back to editing is there): Cancel would throw the sheet away.
        TechSheet.isPreview(editing.def) ? null : actions(btn("Save tech sheet", saveTemplate, "small"),
          btn("Cancel", () => { if (confirm("Discard this tech sheet's changes?")) { ui.templateEdit = null; render(); } }, "small secondary")),
      ]) : null,
    ]);
  }
  async function saveEventSheets(evId, rows) {
    const sheets = rows.map((r) => ({ template: r.template, classes: String(r.classes || "").split(",").map((c) => c.trim()).filter(Boolean) }));
    if (new Set(sheets.map((x) => x.template)).size !== sheets.length) return say("fail", "Each sheet once: put all its classes on one line.");
    try {
      await rpc("set_event_tech_sheets", { p_event: evId, p_sheets: sheets });
      ui.sheetsEdit = null;
      await openEvent(evId);
      say("pass", sheets.length ? "The event's tech sheets are set." : "The event uses its body's default sheet.");
    } catch (e) { fail(e); }
  }

  async function addAdmin() {
    try { await rpc("add_admin", { p_email: adminEmail }); adminEmail = ""; ui.show.addAdmin = false; say("pass", "Admin added."); } catch (e) { fail(e); }
  }
  // Sanctioning bodies: the list (the ones this person manages), then one
  // body at a time -- its scrutineers, and its tech sheets.
  function accStatus(x) {
    return x.deleted_at ? "deleted" : x.disabled_at ? "disabled" : x.license_expires && x.license_expires < isoDay(0) ? "license expired" : "active";
  }
  // The bodies the caller organizes, or whose scrutineers they manage (any of MANAGE).
  function manageableBodies() {
    return ui.roles.admin ? ui.bodies : ui.bodies.filter((b) => isOrganizer(b.id) || MANAGE.some((p) => can(b.id, p)));
  }
  function renderBodies() {
    const admin = ui.roles.admin;
    const manageable = manageableBodies();
    const open = ui.body && manageable.find((b) => b.id === ui.body);
    if (open) return renderBody(open);
    const out = [];
    if (admin) {
      out.push(actions(
        btn("Add a sanctioning body", () => { if (!ui.show.addBody) Object.assign(bodyForm, { id: "", name: "", note: "" }); toggle("addBody"); }, ui.show.addBody ? "small" : "small secondary"),
        btn("Add a System admin", () => toggle("addAdmin"), ui.show.addAdmin ? "small" : "small secondary"),
      ));
      if (ui.show.addBody) {
        const set = (k) => (v) => { bodyForm[k] = v; };
        out.push(h("div", { class: "account-card" }, [
          h("div", { class: "account-card-title" }, ["Add or rename a sanctioning body"]),
          h("div", { class: "field-row" }, [field("Short id", input({ value: bodyCode(bodyForm.id), placeholder: "e.g. ARA" }, set("id"))), field("Name", input({ value: bodyForm.name, placeholder: "e.g. American Rally Association" }, set("name")))]),
          h("div", { class: "field-row" }, [field("How it numbers logbooks", input({ value: bodyForm.note, placeholder: "e.g. scrutineer code + last 6 of the VIN" }, set("note")))]),
          actions(btn("Save body", saveBody), btn("Cancel", () => toggle("addBody", false), "secondary")),
        ]));
      }
      if (ui.show.addAdmin) {
        out.push(h("div", { class: "account-card" }, [
          h("div", { class: "account-card-title" }, ["Add a System admin"]),
          h("div", { class: "field-row" }, [field("Email", input({ value: adminEmail, inputmode: "email" }, (v) => { adminEmail = v; }))]),
          actions(btn("Add admin", addAdmin), btn("Cancel", () => toggle("addAdmin", false), "secondary")),
        ]));
      }
    }
    if (!manageable.length) out.push(desc("No sanctioning bodies yet."));
    manageable.forEach((b) => {
      const people = ui.accreditations.filter((a) => a.body_id === b.id && !a.deleted_at);
      const own = bodyTemplates(b.id);
      const sheet = own[0] || libraryFor(b.id)[0];
      const st = accStatus(b);
      const openIt = () => { ui.body = b.id; ui.bodyTab = "scrutineers"; ui.show.addAcc = false; ui.templateEdit = null; render(); };
      out.push(h("div", { class: "account-card account-event-card", role: "button", tabindex: "0", onclick: openIt, onkeydown: (k) => { if (k.key === "Enter") openIt(); } }, [
        h("div", { class: "account-card-title" }, [b.name + " (" + bodyCode(b.id) + ")", st !== "active" ? h("span", { class: "badge req" }, [st]) : null]),
        desc([people.filter((a) => a.role === "technical_director").length + " technical director(s)", people.filter((a) => a.role === "scrutineer").length + " scrutineer(s)",
          sheet ? "tech sheet: " + sheet.title + (own.length ? "" : " (automatic, from ruleset)") : "no tech sheet"].join(" · ")),
      ]));
    });
    return out;
  }
  function renderBody(b) {
    const admin = ui.roles.admin;
    const people = ui.accreditations.filter((a) => a.body_id === b.id && (admin || !a.deleted_at));
    const out = [
      actions(btn("← All sanctioning bodies", () => { ui.body = null; ui.templateEdit = null; render(); }, "small secondary")),
      h("h3", { class: "account-event-title" }, [b.name + " (" + bodyCode(b.id) + ")" + (accStatus(b) !== "active" ? " -- " + accStatus(b) : "")]),
      b.logbook_number_note ? desc("Logbook numbers: " + b.logbook_number_note) : null,
      admin ? actions(
        btn("Edit body", () => { Object.assign(bodyForm, { id: b.id, name: b.name, note: b.logbook_number_note || "" }); toggle("editBody"); }, ui.show.editBody ? "small" : "small secondary"),
        accStatus(b) === "active" ? btn("Disable body", () => setBodyState(b, "disabled"), "small secondary") : btn("Re-enable body", () => setBodyState(b, "active"), "small secondary"),
      ) : null,
      admin && ui.show.editBody ? h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, ["Edit " + b.name]),
        h("div", { class: "field-row" }, [field("Short id (fixed)", input({ value: bodyCode(b.id), disabled: true }, () => {})), field("Name", input({ value: bodyForm.name }, (v) => { bodyForm.name = v; }))]),
        h("div", { class: "field-row" }, [field("How it numbers logbooks", input({ value: bodyForm.note, placeholder: "e.g. scrutineer code + last 6 of the VIN" }, (v) => { bodyForm.note = v; }))]),
        actions(btn("Save body", saveBody), btn("Cancel", () => toggle("editBody", false), "secondary")),
      ]) : null,
      // Tech sheets: the body's organizers (technical directors, System admins).
      isOrganizer(b.id) ? tabs([["scrutineers", "Scrutineers (" + people.filter((a) => !a.deleted_at).length + ")"], ["techsheets", "Tech sheets (" + bodyTemplates(b.id).length + ")"]], ui.bodyTab, (t) => { ui.bodyTab = t; render(); }) : null,
    ];
    if (ui.bodyTab === "techsheets" && isOrganizer(b.id)) {
      out.push(renderBodyTechSheets(b));
      return out;
    }
    // Disciplines: System admins and the body's all-disciplines technical directors manage them.
    const discs = disciplinesOf(b.id);
    const allDiscs = (ui.disciplines || []).filter((d) => d.body_id === b.id);
    if (admin || myAccs(b.id).some((a) => !a.discipline && a.role === "technical_director")) out.push(renderDisciplines(b, allDiscs));
    // Adding: for the disciplines (or all of them, "") the caller may add scrutineers to.
    const addChoices = (canIn(b.id, null, "add_scrutineers") ? [["", discs.length ? "All disciplines" : b.name]] : [])
      .concat(discs.filter((d) => canIn(b.id, d.id, "add_scrutineers")).map((d) => [d.id, d.name]));
    if (addChoices.length) out.push(actions(btn(admin ? "Add a technical director or scrutineer" : "Add a scrutineer", () => toggle("addAcc"), ui.show.addAcc ? "small" : "small secondary")));
    if (ui.show.addAcc && addChoices.length) {
      if (accForm.body !== b.id || !addChoices.some(([id]) => id === (accForm.discipline || ""))) { accForm.body = b.id; accForm.discipline = addChoices[0][0]; accForm.permissions = null; }
      const set = (k) => (v) => { accForm[k] = v; };
      const disc = accForm.discipline || null;
      const editPermsHere = canIn(b.id, disc, "edit_permissions");
      // A new scrutineer's permissions: the defaults the caller holds in that discipline, unless changed here.
      const perms = accForm.permissions || DEFAULT_SCRUTINEER.filter((p) => canIn(b.id, disc, p));
      out.push(h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, [(admin ? "Add a technical director or scrutineer" : "Add a scrutineer") + " for " + b.name]),
        h("div", { class: "field-row" }, [field("Name", input({ value: accForm.name }, set("name"))), field("Email", input({ value: accForm.email, inputmode: "email" }, set("email")))]),
        discs.length ? h("div", { class: "field-row" }, [field("Discipline", select(addChoices, accForm.discipline || "", (v) => { accForm.discipline = v; accForm.permissions = null; render(); }))]) : null,
        h("div", { class: "field-row" }, [
          admin ? field("Role", select([["scrutineer", "Scrutineer"], ["technical_director", "Technical director"]], accForm.role, (v) => { accForm.role = v; render(); })) : null,
          field("License number", input({ value: accForm.license }, set("license"))),
          field("License expires (optional)", dateInput(accForm.expires, set("expires"))),
          field("Scrutineer code", input({ value: accForm.code, placeholder: "e.g. ARA 2-digit number" }, set("code"))),
        ]),
        accForm.role === "scrutineer" && editPermsHere ? [desc("Permissions (a technical director holds them all):"),
          permissionBoxes(b.id, disc, perms, (next) => { accForm.permissions = next; render(); })] : null,
        accForm.role === "scrutineer" && !editPermsHere ? desc("They get the standard scrutineer permissions you hold: " + perms.map((p) => PERMISSIONS.find(([k]) => k === p)[1].toLowerCase()).join(", ") + ".") : null,
        actions(btn("Save", grant), btn("Cancel", () => toggle("addAcc", false), "secondary")),
      ]));
    }
    const permSummary = (a) => {
      if (a.role === "technical_director") return "all";
      const p = accPermissions(a);
      return !a.permissions ? "standard (" + p.length + ")" : p.length + " of " + ALL_PERMISSIONS.length;
    };
    // (With disciplines: whose accreditation is for which; the actions count permissions in it.)
    const withDisc = allDiscs.length > 0;
    out.push(people.length ? h("table", { class: "account-table" }, [
      h("tr", {}, ["Name", "Email", withDisc ? "Discipline" : null, "Role", "License", "Expires", "Code", "Permissions", "Status", ""].filter(Boolean).map((t) => h("th", {}, [t]))),
      people.map((a) => {
        const changeable = canChange(a);
        const st = accStatus(a);
        const editing = ui.permEdit && ui.permEdit.id === a.id;
        const may = (perm) => canIn(b.id, a.discipline, perm);
        const row = h("tr", {}, [
          h("td", {}, [a.name]), h("td", {}, [a.email]), withDisc ? h("td", {}, [a.discipline ? disciplineName(b.id, a.discipline) : "All"]) : null,
          h("td", {}, [a.role === "technical_director" ? "Technical director" : "Scrutineer"]),
          h("td", {}, [a.license_number || ""]), h("td", {}, [a.license_expires ? fmtDate(a.license_expires) : "—"]), h("td", {}, [a.scrutineer_code || ""]),
          h("td", { title: accPermissions(a).map((p) => PERMISSIONS.find(([k]) => k === p)[1]).join("\n") }, [permSummary(a)]),
          h("td", { class: st === "active" ? "" : "account-warn" }, [st]),
          h("td", { class: "account-row-actions" }, changeable ? [
            may("renew_licenses") ? btn(a.license_expires ? "Renew" : "Set expiry", () => renew(a), "small secondary") : null,
            may("edit_permissions") && a.role !== "technical_director" ? btn("Permissions", () => { ui.permEdit = editing ? null : { id: a.id, perms: accPermissions(a).slice() }; render(); }, editing ? "small" : "small secondary") : null,
            st === "disabled" || st === "deleted"
              ? (may(st === "deleted" ? "delete_scrutineers" : "renew_licenses") ? btn("Re-enable", () => setAccState(a, "active"), "small secondary") : null)
              : [may("renew_licenses") ? btn("Disable", () => setAccState(a, "disabled"), "small secondary") : null,
                may("delete_scrutineers") ? btn("Delete", () => setAccState(a, "deleted"), "small secondary") : null],
          ] : []),
        ]);
        if (!editing) return row;
        return [row, h("tr", {}, [h("td", { colspan: withDisc ? "10" : "9" }, [
          desc(a.name + "'s permissions" + (a.discipline ? " for " + disciplineName(b.id, a.discipline) : "") + ":"),
          permissionBoxes(b.id, a.discipline, ui.permEdit.perms, (next) => { ui.permEdit.perms = next; render(); }),
          actions(btn("Save permissions", () => savePermissions(a, ui.permEdit.perms), "small"),
            btn("Standard scrutineer", () => savePermissions(a, null), "small secondary"),
            btn("Cancel", () => { ui.permEdit = null; render(); }, "small secondary")),
        ])])];
      }),
    ]) : desc("No scrutineers yet."));
    return out;
  }

  // ---- Public view (?logbook=<token>) --------------------------------------
  async function loadPublic(token) {
    ui.publicView = { token, data: undefined };
    render();
    try { ui.publicView.data = await rpc("public_logbook", { p_token: token }); } catch (e) { fail(e); }
    render();
    // Its rollcage and vehicle photos, when the owner shows them (the
    // public copy of the records leaves them out otherwise).
    const d = ui.publicView.data;
    if (!d) return;
    const withPictures = latestWith(d.records, "pictures");
    const withVehicle = latestWith(d.records, "vehiclePhotos");
    const shas = [].concat(
      withVehicle ? ["front", "rear"].map((slot) => withVehicle.vehiclePhotos[slot] && withVehicle.vehiclePhotos[slot].sha256).filter(Boolean) : [],
      withPictures ? withPictures.pictures.map((p) => p.sha256) : []);
    ui.publicView.photos = [];
    for (const sha of shas) {
      try {
        const { data, error } = await sb.storage.from(PHOTO_BUCKET).download(sha);
        if (error) continue;
        ui.publicView.photos.push(URL.createObjectURL(data));
        render();
      } catch (e) { /* not shown */ }
    }
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
      (ui.publicView.photos || []).length
        ? h("div", { class: "account-photos" }, ui.publicView.photos.map((url) => h("a", { href: url, target: "_blank", rel: "noopener", title: "Open full size" }, [h("img", { src: url, alt: "" })])))
        : null,
      h("ol", { class: "account-records" }, d.records.map((r) => h("li", {}, [
        r.kind + " -- " + new Date(r.createdAt).toLocaleDateString() + " by " + r.author + (r.license ? " (" + r.authorBody.toUpperCase() + " " + r.license + ")" : ""),
        r.body && (r.body.note || r.body.notes) ? ": " + (r.body.note || r.body.notes) : "",
      ]))),
    ]);
  }

  // ---- A scanned tech sticker (?s=<code>, stickers.js) ----------------------
  // What it vouches for, to anyone (names only to scrutineers); a scrutineer
  // of its body can void it. A logbook sticker opens the logbook's public view.
  async function loadSticker(code) {
    ui.stickerView = { code, data: undefined };
    render();
    try {
      const d = ui.stickerView.data = await rpc("sticker_view", { p_code: code });
      if (d && d.kind === "logbook" && d.status === "valid" && d.logbook && d.logbook.publicToken) {
        ui.stickerView = null;
        return loadPublic(d.logbook.publicToken);
      }
      if (d && d.kind === "gear") TechSheet.loadCatalog().then((c) => { if (ui.stickerView) { ui.stickerView.catalog = c; render(); } }, () => {});
    } catch (e) {
      // No connection: from this device's offline copies, if it has one with this sticker.
      const d = isNetworkError(e) ? await offlineSticker(code).catch(() => null) : null;
      ui.stickerView.data = d;
      if (d && d.kind === "gear") TechSheet.loadCatalog().then((c) => { if (ui.stickerView) { ui.stickerView.catalog = c; render(); } }, () => {});
      if (!d) fail(isNetworkError(e) ? new Error("No connection, and this sticker isn't in this device's offline copy.") : e);
    }
    render();
  }
  function stickerStandard(cat, id) {
    const c = (ui.stickerView && ui.stickerView.catalog) || ui.stickerCatalog;
    const x = c && c.categories.find((y) => y.id === cat);
    return (((x && x.standards) || []).concat(c ? c.categories.flatMap((y) => y.standards || []) : []).find((s) => s.id === id) || {}).label || id;
  }
  async function voidSticker(code) {
    const reason = prompt("Void sticker " + Stickers.fmtCode(code) + " -- why? (e.g. failed tech, item replaced, sticker copied)", "");
    if (!reason || !reason.trim()) return;
    try {
      await rpc("void_sticker", { p_code: code, p_reason: reason.trim() });
      say("pass", "Sticker " + Stickers.fmtCode(code) + " is void.");
      if (ui.stickerView) loadSticker(code);
      if (ui.techSheet) loadSheetStickers();
    } catch (e) { fail(e); }
  }
  function renderSticker() {
    const v = ui.stickerView;
    if (v.data === undefined) return desc("Loading the sticker…");
    if (!v.data) return h("p", { class: "verdict fail" }, ["There's no sticker " + Stickers.fmtCode(v.code) + " -- check the code printed under the QR code."]);
    const d = v.data;
    return Stickers.view(d, { photoUrl: techPhotoUrl, standardLabel: stickerStandard, lines: TechSheet.lines,
      onVoid: d.staff && !d.offlineAsOf && ui.roles && canIn(d.body, d.discipline, "void_stickers") ? () => voidSticker(d.code) : null,
      onOpenLogbook: d.logbook && d.logbook.publicToken ? () => { ui.stickerView = null; loadPublic(d.logbook.publicToken); } : null });
  }

  // ---- Annual safety stickers (supabase/migrations/20261025000000_annual_stickers.sql) ----
  // A body's season stickers for gear, outside an event: the scrutineer picks the body and season,
  // then fills in one item at a time -- new, from last season's sticker, or from a competitor's
  // application (PassTech) -- marks it Pass and issues its sticker.
  // ui.annual: { body, season, tab, item, applications, stickers, busy }
  //   item: { category, owner, competitor (an application's gear and photos, as a team's line),
  //           inspection, view, replaces (the sticker read), application (its id) }
  function annualBodies() {
    return ui.bodies.filter((b) => !b.disabled_at && !b.deleted_at && can(b.id, "issue_annual_stickers"));
  }
  // The body's disciplines the caller issues annual stickers for (a body without any: "").
  function annualDisciplines(body) {
    const list = disciplinesOf(body);
    return list.length ? list.filter((d) => canIn(body, d.id, "issue_annual_stickers")) : null;
  }
  // A body's stickers from before it had disciplines (discipline null): to see and void, not to issue.
  const NO_DISCIPLINE = "__none";
  // The discipline to ask the server for ("" for none).
  const annualDisc = (a) => (a.discipline === NO_DISCIPLINE ? "" : a.discipline || "");
  const annualDiscName = (a) => (a.discipline === NO_DISCIPLINE ? "(no discipline)" : disciplineName(a.body, a.discipline));
  // a.discipline: the discipline picked ("" for a body without any); ready once it's set.
  const annualReady = (a) => !!a.body && (annualDisciplines(a.body) === null || !!a.discipline);
  function annualPickBody(a, body) {
    a.body = body;
    const ds = annualDisciplines(body);
    a.discipline = ds && ds.length === 1 ? ds[0].id : "";
  }
  function annualState() {
    if (!ui.annual) {
      const bodies = annualBodies();
      ui.annual = { body: "", discipline: "", season: new Date().getFullYear(), tab: "issue", item: null, applications: null, stickers: null };
      if (bodies.length === 1) annualPickBody(ui.annual, bodies[0].id);
      if (annualReady(ui.annual)) loadAnnual();
    }
    return ui.annual;
  }
  async function loadAnnual() {
    const a = ui.annual;
    if (!a || !annualReady(a)) return;
    try {
      // (Applications for the discipline picked.)
      a.applications = (await rpc("list_sticker_applications", { p_body: a.body, p_status: "pending" }))
        .filter((x) => (x.discipline || "") === annualDisc(a));
      a.stickers = await rpc("list_stickers", { p: Object.assign({ body: a.body, discipline: annualDisc(a) }, a.allSeasons ? {} : { season: a.season }) });
      // Who submitted the application for each sticker issued from an application (PassTech), to search by.
      a.submitters = {};
      (await rpc("list_sticker_applications", { p_body: a.body, p_status: "issued" })).forEach((x) => { if (x.stickerCode) a.submitters[x.stickerCode] = x.submittedBy; });
      if (!ui.stickerCatalog) TechSheet.loadCatalog().then((c) => { ui.stickerCatalog = c; render(); }, () => {});
    } catch (e) { fail(e); }
    render();
  }
  // Everything a scrutineer may search an issued sticker by: its code, gear type, owner, who
  // applied and who issued it, and the gear's details (standards, serial numbers, …).
  function stickerSearchText(a, s) {
    const snap = s.snapshot || {};
    const words = [];
    const walk = (v, key) => {
      if (/photo/i.test(key || "")) return;
      if (Array.isArray(v)) v.forEach((x) => walk(x));
      else if (v && typeof v === "object") Object.keys(v).forEach((k) => walk(v[k], k));
      else if (typeof v === "string" || typeof v === "number") words.push(key === "standardId" ? stickerStandard(snap.category, String(v)) + " " + v : String(v));
    };
    walk(snap.gear);
    return [s.code, Stickers.fmtCode(s.code), Stickers.GEAR_LABEL[snap.category], snap.category, snap.driver, a.submitters && a.submitters[s.code],
      s.issuedBy, s.season, s.disciplineName, s.voidedAt ? "void" : ""].concat(words).filter(Boolean).join(" ").toLowerCase();
  }
  async function annualView(code) {
    const a = ui.annual;
    if (a.viewing && a.viewing.code === code) { a.viewing = null; return render(); }
    a.viewing = { code, data: undefined };
    render();
    try { a.viewing.data = await rpc("sticker_view", { p_code: code }); } catch (e) { a.viewing.data = null; fail(e); }
    render();
  }
  // "SCCNH Autocross 2026" / "ARA 2026".
  const annualLabel = (a) => [bodyName(a.body), annualDiscName(a), a.season].filter(Boolean).join(" ");
  // A new item to fill in: a gear type alone, or from a sticker / an application.
  function annualItem(category, from) {
    const a = ui.annual;
    const item = { category, owner: (from && from.owner) || "", inspection: { items: {} }, view: { open: { [category]: true } },
      competitor: null, replaces: from && from.replaces, application: from && from.application };
    if (from && from.gear) {
      // What's read (an application's gear and photos) comes in as a team's line, to check and correct.
      item.competitor = { items: { [category]: { declared: from.declared || "", gear: from.gear, photos: from.photos || [] } } };
    }
    a.item = item;
    a.tab = "issue";
    render();
  }
  function annualReadSticker() {
    Stickers.scanDialog(async (code) => {
      try {
        const d = await lookupSticker(code);
        if (!d) return say("fail", "There's no sticker " + Stickers.fmtCode(code) + ".");
        if (d.kind !== "gear") return say("fail", "Sticker " + Stickers.fmtCode(code) + " isn't a gear sticker.");
        const snap = d.snapshot || {};
        annualItem(snap.category, { gear: Object.assign({}, snap.gear, { category: snap.category }), photos: snap.photos, owner: snap.driver,
          declared: "From sticker " + Stickers.fmtCode(d.code) + " (" + (d.bodyName || d.body) + " " + (d.season || "") + ", " + d.status + ")", replaces: d.code });
      } catch (e) { fail(e); }
    });
  }
  async function annualIssue() {
    const a = ui.annual, it = a.item;
    const res = it.inspection.items[it.category] || {};
    const dec = ((it.competitor || {}).items || {})[it.category] || {};
    const removed = res.removedPhotos || [];
    const photos = (dec.photos || []).filter((p) => !removed.includes(p.sha256)).concat(res.photos || []);
    if (!photos.some((p) => p.kind === "tag") || !photos.some((p) => p.kind !== "tag")) return say("fail", "A sticker needs a photo of the whole item and one of its tag or label.");
    try {
      const st = await rpc("issue_sticker", { p: { kind: "gear", annual: true, body: a.body, discipline: annualDisc(a) || undefined, season: a.season, gear: res.gear || dec.gear,
        photos, label: Stickers.GEAR_LABEL[it.category], owner: it.owner || undefined,
        replaces: (res.sticker && res.sticker.code) || it.replaces || undefined, application: it.application || undefined } });
      a.item = null;
      say("pass", "Sticker " + Stickers.fmtCode(st.code) + " issued for " + annualLabel(a) + ".");
      Stickers.printDialog([st]);
      loadAnnual();
    } catch (e) { fail(e); }
  }
  // Whether it was declined (not when the scrutineer cancels, or it fails).
  async function annualDecline(app) {
    const note = prompt("Decline this application -- why? (the competitor sees it)", "");
    if (!note || !note.trim()) return false;
    try { await rpc("decline_sticker_application", { p_id: app.id, p_note: note.trim() }); say("pass", "Application declined."); loadAnnual(); return true; }
    catch (e) { fail(e); return false; }
  }
  function renderAnnual() {
    const a = annualState();
    const bodies = annualBodies();
    const discs = a.body ? annualDisciplines(a.body) : null;
    const out = [h("div", { class: "field-row" }, [
      field("Sanctioning body", select([["", "— pick —"]].concat(bodies.map((b) => [b.id, b.name])), a.body, (v) => { annualPickBody(a, v); a.item = null; a.applications = a.stickers = null; loadAnnual(); render(); })),
      // (Body-wide staff also see the stickers from before the body had disciplines.)
      discs ? field("Discipline", select([["", "— pick —"]].concat(discs.map((d) => [d.id, d.name]),
        canIn(a.body, null, "issue_annual_stickers") ? [[NO_DISCIPLINE, "No discipline (older stickers)"]] : []), a.discipline, (v) => { a.discipline = v; a.item = null; a.applications = a.stickers = null; loadAnnual(); render(); })) : null,
      field("Season", input({ type: "number", value: String(a.season), min: "2020", max: "2100" }, (v) => { const y = parseInt(v, 10); if (y > 2000) { a.season = y; a.stickers = null; loadAnnual(); } })),
    ])];
    if (!a.body) return out.concat(desc("Pick the body you're issuing stickers for."));
    if (!annualReady(a)) return out.concat(desc(discs && !discs.length ? "You don't issue annual stickers for any of " + bodyName(a.body) + "'s disciplines." : "Pick the discipline: its stickers are good for its events."));
    const apps = a.applications || [];
    // No discipline: only what's already there -- new stickers are a discipline's.
    const older = a.discipline === NO_DISCIPLINE;
    if (older && a.tab === "issue") a.tab = "issued";
    out.push(tabs([].concat(older ? [] : [["issue", "Issue a sticker"]], [["applications", "Applications (" + apps.length + ")"], ["issued", (a.allSeasons ? "Issued" : "Issued for " + a.season) + " (" + (a.stickers || []).length + ")"]]), a.tab, (t) => { a.tab = t; render(); }));
    if (a.tab === "applications") {
      out.push(h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, ["Applications from PassTech"]),
        desc(older ? "Applications sent before " + bodyName(a.body) + " had disciplines: decline them, saying why -- the competitor can apply again for a discipline."
          : "Competitors apply from My gear in PassTech, with their gear's details and photos. Check the item in hand, then issue its sticker -- or decline, saying why."),
        apps.length ? apps.map((x) => h("div", { class: "account-entry" }, [
          h("span", { class: "account-entry-main" }, [h("strong", {}, [Stickers.GEAR_LABEL[x.category] || x.category]),
            h("span", { class: "element-desc" }, [" · " + [x.owner, x.submittedBy, "season " + x.season, (x.photos || []).length + " photos", "sent " + fmtDate(x.submittedAt)].filter(Boolean).join(" · ")])]),
          older ? null : btn("Review and issue", () => annualItem(x.category, { gear: x.gear, photos: x.photos, owner: x.owner, declared: "Application from " + (x.owner || x.submittedBy), application: x.id }), "small"),
          btn("Decline", () => annualDecline(x), "small secondary"),
        ])) : desc("No pending applications."),
      ]));
      return out;
    }
    if (a.tab === "issued") {
      const all = a.stickers || [];
      const words = (a.search || "").toLowerCase().split(/\s+/).filter(Boolean);
      const list = all.filter((s) => (!a.type || (s.snapshot || {}).category === a.type) && (!words.length || ((t) => words.every((w) => t.includes(w)))(stickerSearchText(a, s))))
        .slice().reverse(); // newest first
      const viewing = a.viewing;
      out.push(h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, [(a.allSeasons ? [bodyName(a.body), annualDiscName(a)].filter(Boolean).join(" ") + ", every season," : annualLabel(a)) + " stickers"]),
        h("div", { class: "field-row" }, [
          field("Search", input({ value: a.search || "", "data-id": "annual-search", placeholder: "code, owner, who submitted, standard, serial number…" }, (v) => { a.search = v; render(); restoreFocus("annual-search"); })),
          field("Gear", select([["", "All gear"]].concat(Stickers.GEAR.map((c) => [c, Stickers.GEAR_LABEL[c]])), a.type || "", (v) => { a.type = v; render(); })),
        ]),
        h("div", { class: "account-checks" }, [h("label", {}, [h("input", { type: "checkbox", checked: !!a.allSeasons, onchange: (e) => { a.allSeasons = e.target.checked; a.stickers = null; loadAnnual(); } }), " Every season, not only " + a.season])]),
        all.length && (words.length || a.type) ? desc(list.length + " of " + all.length + " match.") : null,
        list.length ? list.map((s) => {
          const snap = s.snapshot || {};
          const who = a.submitters && a.submitters[s.code];
          const open = viewing && viewing.code === s.code;
          return h("div", {}, [
            h("div", { class: "account-entry" }, [
              h("span", { class: "account-entry-main" }, [h("strong", {}, [Stickers.fmtCode(s.code)]),
                h("span", { class: "element-desc" }, [" · " + [Stickers.GEAR_LABEL[snap.category], snap.driver, who && who !== snap.driver ? "submitted by " + who : "",
                  a.allSeasons ? String(s.season) : "", fmtDate(s.issuedAt), s.voidedAt ? "void" : ""].filter(Boolean).join(" · ")])]),
              btn(open ? "Hide" : "View", () => annualView(s.code), "small secondary"),
              !s.voidedAt ? btn("Print", () => Stickers.printDialog([s]), "small secondary") : null,
              !s.voidedAt && canIn(s.body, s.discipline, "void_stickers") ? btn("Void", () => voidSticker(s.code).then(() => { if (a.viewing) a.viewing = null; loadAnnual(); }), "small secondary") : null,
            ]),
            open ? h("div", { class: "account-card" }, [viewing.data === undefined ? desc("Loading the sticker…") : viewing.data === null ? desc("Couldn't load this sticker.")
              : Stickers.view(viewing.data, { photoUrl: techPhotoUrl, standardLabel: stickerStandard, lines: TechSheet.lines })]) : null,
          ]);
        }) : desc(all.length ? "No sticker matches." : a.allSeasons ? "None issued outside an event yet." : "None issued outside an event for this season yet."),
      ]));
      return out;
    }
    if (!a.item) {
      out.push(h("div", { class: "account-card" }, [
        h("div", { class: "account-card-title" }, ["Which gear?"]),
        actions(...Stickers.GEAR.map((c) => btn(Stickers.GEAR_LABEL[c], () => annualItem(c), "small secondary"))),
        desc("Already has a sticker from a previous season? Read it: its details and photos fill the new one in."),
        actions(btn("🔳 Read last season's sticker", annualReadSticker, "small")),
        apps.length ? desc(apps.length + " application" + (apps.length === 1 ? "" : "s") + " from PassTech waiting -- see Applications.") : null,
      ]));
      return out;
    }
    const it = a.item;
    const tpl = { id: "annual", title: "Annual sticker", header: [], sections: [{ id: "gear", title: "", items: [{ id: it.category, label: Stickers.GEAR_LABEL[it.category], gear: it.category }] }] };
    out.push(h("div", { class: "account-card" }, [
      h("div", { class: "account-card-title" }, [Stickers.GEAR_LABEL[it.category] + " -- " + annualLabel(a) + " sticker"]),
      h("div", { class: "field-row" }, [field("Owner (shown to scrutineers only)", input({ value: it.owner, placeholder: "e.g. the driver's name" }, (v) => { it.owner = v; }))]),
      TechSheet.sheet({ template: tpl, variant: null, header: {}, competitor: it.competitor, inspection: it.inspection, editable: true, view: it.view, bare: true,
        photoUrl: techPhotoUrl, addPhoto: addTechPhoto, lookupSticker, setVariant: () => {}, onChange: render }),
      desc("Check the item in hand against its details and photos -- the sticker needs a photo of the whole item and one of its tag or label -- then issue its sticker" +
        (it.application ? ", or decline the application, saying why." : ".")),
      actions(btn("Issue the sticker", annualIssue, "small"),
        it.application ? btn("Decline", () => annualDecline({ id: it.application }).then((done) => { if (done && a.item === it) { a.item = null; render(); } }), "small secondary") : null,
        btn("Cancel", () => { a.item = null; render(); }, "small secondary")),
    ]));
    return out;
  }

  // ---- Home: the modes ------------------------------------------------------
  // Like PassTech's landing page: one card per mode the person can use.
  // Two sites from this app (config.js, window.APP_SITE): Digital logbooks
  // (create, the library) and Scrutineering (scrutineering at an event, event
  // admin). Both manage the sanctioning bodies and their scrutineers.
  const SITE = window.APP_SITE === "scrutineering" ? "scrutineering" : "logbook";
  const MODES = {
    create: { title: "Create a new logbook", text: "Record a car's roll cage after its inspection, then issue its logbook online." },
    library: { title: "Logbook library", text: "Logbooks on this device and online: search, open, download, sync, delete." },
    event: { title: "Scrutineering", text: "At an event: each car's tech sheet, its inspection and sign-off, and what's left to inspect." },
    events: { title: "Event admin", text: "Organize events: create them, their staff and tech sheets, and their competitors (MotorsportReg import)." },
    annual: { title: "Annual safety stickers", text: "Season stickers for helmets, HANS, seats, fire extinguishers and suppression systems -- outside an event, from a competitor's application or last season's sticker." },
    bodies: { title: "Sanctioning bodies, scrutineers and tech sheets", text: "Technical directors, scrutineers, their licenses and permissions, and each body's tech sheets." },
  };
  // The other site's address (locally: this page with ?site=).
  function otherSite() {
    const other = SITE === "logbook" ? "scrutineering" : "logbook";
    if (/^(logbook|scrutineering)\./.test(location.hostname)) return location.protocol + "//" + location.hostname.replace(/^(logbook|scrutineering)\./, other + ".") + "/";
    return location.pathname + "?site=" + other;
  }

  function availableModes() {
    const r = ui.roles;
    const staff = r && r.accreditations.length > 0;
    const organizer = r && (r.admin || r.accreditations.some((a) => a.role === "technical_director"));
    // Sanctioning bodies: organizers, and whoever manages a body's scrutineers.
    const manager = organizer || MANAGE.some(canAnywhere);
    return SITE === "scrutineering"
      ? (staff ? ["event"] : []).concat(canAnywhere("issue_annual_stickers") ? ["annual"] : [], organizer ? ["events"] : [], manager ? ["bodies"] : [])
      : ["create", "library"].concat(manager ? ["bodies"] : []);
  }
  // The home screen shows the modes only; Event and Admin modes don't use
  // the logbook editor, and the library starts on its list -- each hides it.
  function goMode(mode) {
    if (mode !== ui.mode && sheetDirty()) return leaveTechSheet(() => goMode(mode));
    // Creating starts a new logbook: an issued one left open (from the
    // library) isn't one to create.
    if (app && (mode !== "create" || (app.currentRollcage().vehicle || {}).server)) app.hideWorkspace();
    // Each section starts on its list: no event or body left open from before.
    if (mode !== ui.mode) { ui.event = null; closeTechSheet(); ui.body = null; ui.templateEdit = null; ui.show = {}; }
    ui.mode = mode; ui.message = null; render();
    holder.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function renderHome() {
    const open = ui.events.filter((e) => e.open && e.myRole).length;
    const badge = { library: ui.garage.length ? ui.garage.length + " in your garage" : null, event: open ? open + " open now" : null };
    const modes = availableModes();
    const staff = ui.roles && ui.roles.accreditations.length > 0;
    // The other site, for who uses it: scrutineers from here; anyone for logbooks from there.
    const link = SITE === "logbook"
      ? (staff ? ["Scrutineering and event admin are on the Scrutineering site", "Open Scrutineering"] : null)
      : ["Creating and opening logbooks is on the Digital logbooks site", "Open Digital logbooks"];
    return [
      modes.length ? h("div", { class: "account-modes" }, modes.map((m, i) => h("button", { type: "button", class: "account-mode", onclick: () => goMode(m) }, [
        h("span", { class: "account-mode-number" }, [String(i + 1)]),
        h("span", { class: "account-mode-title" }, [MODES[m].title]),
        h("span", { class: "account-mode-text" }, [MODES[m].text]),
        badge[m] ? h("span", { class: "badge info" }, [badge[m]]) : null,
      ]))) : desc("This site is for scrutineers and event organizers: ask your sanctioning body's technical director for a scrutineer accreditation."),
      link ? h("p", { class: "account-other-site" }, [link[0] + " -- ", h("a", { href: otherSite() }, [link[1] + " →"])]) : null,
    ];
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
      btn("Start from a cage template", () => app.openLibrary({ templatesOnly: true }), "small secondary"),
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
      // (Open or not survives the page redrawing it.)
      h("details", { class: "account-more", open: !!ui.open.startAnother, ontoggle: (e) => { ui.open.startAnother = e.target.open; } }, [h("summary", {}, ["Start another logbook"]), startButtons]),
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
        issued && issued.id && ui.roles.accreditations.length ? btn("QR sticker", () => logbookSticker(issued.id), "small secondary") : null,
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
    // An event open: its page; otherwise the list.
    if (m === "event") {
      out.push(ui.event ? renderEvent("scrutineer") : renderEventCards(ui.events.filter((e) => e.myRole), "No events yet: the events you're on the staff of show here."));
    }
    if (m === "events") {
      if (ui.event) out.push(renderEvent("organize"));
      else {
        out.push(organizerBodies().length ? actions(btn("Create new event", () => { if (!ui.show.createEvent) Object.assign(eventForm, blankEvent()); toggle("createEvent"); }, ui.show.createEvent ? "small" : "small secondary")) : null);
        if (ui.show.createEvent) out.push(renderCreateEvent());
        out.push(renderEventCards(ui.events.filter((e) => e.organizer), "No events yet."));
      }
    }
    if (m === "bodies") out.push(renderBodies());
    if (m === "annual") out.push(renderAnnual());
    return out;
  }

  // ---- Panel ---------------------------------------------------------------
  function render() {
    const children = [];
    if (ui.stickerView) {
      children.push(h("h2", {}, ["Tech sticker"]), renderSticker(), actions(h("a", { class: "btn small secondary", href: location.pathname }, ["Close"])));
    } else if (ui.publicView) {
      children.push(h("h2", {}, ["Logbook"]), renderPublic(), actions(h("a", { class: "btn small secondary", href: location.pathname }, ["Close"])));
    } else if (!ui.session) {
      children.push(h("h2", {}, ["Sign in"]), renderSignIn(), renderDevice());
    } else {
      const r = ui.roles;
      children.push(h("div", { class: "account-bar" }, [
        h("span", {}, ["Signed in as ", h("strong", {}, [ui.session.user.email])]),
        r ? h("span", { class: "account-roles" }, [
          r.admin ? h("span", { class: "badge rec" }, ["System admin"]) : null,
          r.accreditations.map((a) => h("span", { class: "badge info", title: a.licenseExpires ? "License expires " + fmtDate(a.licenseExpires) : "" }, [roleLabel(a)])),
        ]) : null,
        off.on ? h("span", { class: "badge cond", title: "No connection: working from this device's offline copy" }, ["offline"]) : null,
        off.queue.length ? h("span", { class: "badge info", title: "Changes made offline, waiting to sync" }, [off.queue.length + " to sync"]) : null,
        btn("Sign out", signOut, "small secondary"),
      ]));
      if (r) {
        (r.expired || []).forEach((x) => children.push(h("p", { class: "verdict warn" }, ["Your " + x.bodyName + " license expired on " + fmtDate(x.licenseExpires) + ": ask your technical director to renew it."])));
        if (!availableModes().includes(ui.mode)) ui.mode = "home";
        const home = ui.mode === "home" || !app;
        children.push(home ? renderHome() : renderModeView(ui.mode));
      }
    }
    // A long transfer running (photos, a batch of logbooks): its progress.
    if (ui.busy) children.push(h("p", { class: "account-busy" }, [ui.busy]));
    if (ui.message) children.push(h("p", { class: ui.message.kind === "pass" ? "library-notice" : "verdict fail", title: "Click to dismiss", onclick: () => { ui.message = null; render(); } }, [ui.message.text]));
    holder.replaceChildren(h("div", { class: "panel account-panel" }, children));
  }

  // Signing out also removes the offline copies (people's names and photos) -- except what
  // waits to sync, kept for when they sign in again.
  async function signOut() {
    const waiting = off.queue.length;
    if (waiting && !confirm(waiting + " change" + (waiting === 1 ? "" : "s") + " made offline haven't synced yet: they stay on this device and sync when you sign in again as " + me() + ". Sign out?")) return;
    if (Store) {
      try {
        for (const key of await Store.keys("kv")) await Store.del("kv", key);
        off.copies = {}; off.codes = {};
        if (waiting) await prunePhotos(); else await Store.clear("photos");
      } catch (e) { /* nothing kept */ }
    }
    ui.signingOut = true;
    off.on = false;
    const offline = ui.session && ui.session.offline;
    await sb.auth.signOut(offline ? { scope: "local" } : undefined).catch(() => {});
    if (offline) { ui.session = null; ui.roles = null; ui.event = null; ui.signingOut = false; render(); }
  }
  sb.auth.onAuthStateChange((event, session) => {
    const was = ui.session && ui.session.user.id;
    ui.session = session;
    if (!session) {
      ui.roles = null; ui.garage = []; ui.accreditations = []; ui.events = []; ui.event = null;
      // Not signed out by them, just no connection to renew the sign-in: offline, as before.
      if (!ui.signingOut) setTimeout(startOffline, 0);
      ui.signingOut = false;
      render();
      return;
    }
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
  const stickerCode = window.Stickers && Stickers.codeFromUrl();
  const token = new URLSearchParams(location.search).get("logbook");
  if (stickerCode) loadSticker(stickerCode); else if (token) loadPublic(token); else render();
})();
