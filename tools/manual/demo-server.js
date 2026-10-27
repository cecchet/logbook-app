// A stand-in for the Supabase server, for the user manual's screenshots
// (screenshots.mjs): injected into the page before its scripts, it answers
// account.js's calls with a made-up sanctioning body ("Demo Rally Club"), its
// scrutineers, events, competitors, tech sheets and stickers -- no real
// account, no real people. Signed in as the club's technical director.
(function () {
  const DAY = 864e5;
  const iso = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
  const at = (n, h) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10) + "T" + String(h || 10).padStart(2, "0") + ":15:00Z";
  const ME = "alex.morgan@example.com";
  const ALL = ["add_scrutineers", "renew_licenses", "edit_permissions", "delete_scrutineers", "issue_annual_stickers", "void_stickers", "sign_off_tech_sheets", "issue_logbooks", "add_logbook_entries"];
  try { localStorage.setItem("scrutineering-app-tour-seen", "1"); localStorage.setItem("logbook-app-tour-seen", "1"); } catch (e) {}

  // ---- Bodies, disciplines, people ----
  const bodies = [
    { id: "drc", name: "Demo Rally Club", logbook_number_note: "scrutineer code + last 6 of the VIN", disabled_at: null, deleted_at: null },
    { id: "gmr", name: "Green Mountain Rally Series", logbook_number_note: null, disabled_at: null, deleted_at: null },
  ];
  const disciplines = [
    { body_id: "drc", id: "rally", name: "Rally", short: "RALLY", position: 1, archived_at: null },
    { body_id: "drc", id: "autox", name: "Autocross", short: "AUTOX", position: 2, archived_at: null },
  ];
  const acc = (id, name, email, role, discipline, license, expires, code, permissions, extra) => Object.assign({ id, body_id: "drc", name, email, role, discipline,
    license_number: license, license_expires: expires, scrutineer_code: code, permissions, disabled_at: null, deleted_at: null }, extra);
  const accreditations = [
    acc("a1", "Alex Morgan", ME, "technical_director", null, "DRC-001", iso(156), "01", null),
    acc("a2", "Jamie Chen", "jamie.chen@example.com", "scrutineer", "rally", "DRC-014", iso(156), "14", null),
    acc("a3", "Sam Patel", "sam.patel@example.com", "scrutineer", "autox", "DRC-022", iso(156), "22", ["issue_annual_stickers", "sign_off_tech_sheets"]),
    acc("a4", "Riley Brooks", "riley.brooks@example.com", "scrutineer", null, "DRC-009", iso(-118), "09", null),
    acc("a5", "Taylor Kim", "taylor.kim@example.com", "scrutineer", "rally", "DRC-031", iso(156), "31", null, { disabled_at: at(-40) }),
  ];
  const roles = { email: ME, admin: false, expired: [],
    accreditations: [{ id: "a1", body: "drc", bodyName: "Demo Rally Club", role: "technical_director", discipline: null, permissions: ALL, licenseExpires: iso(156) }] };

  // ---- Tech sheet templates (the built-in NASA Rally Sport and SCCNH sheets, renamed for the demo club) ----
  const sync = (url) => { const x = new XMLHttpRequest(); x.open("GET", url, false); x.send(); return JSON.parse(x.responseText); };
  const strip = (t, id, title, form) => {
    t.id = id; t.bodyId = "drc"; t.title = title; t.source = { form, rules: "Demo Rally Club technical rules" };
    t.sections.forEach((s) => s.items.forEach((i) => { delete i.rule; }));
    return t;
  };
  let RALLY, AUTOX;
  const sheets = () => {
    if (!RALLY) {
      RALLY = strip(sync("/tech-sheets/templates/nasa-rallysport.json"), "drc-rally", "Demo Rally Club Rally Tech Sheet", "Demo Rally Club rally scrutineering sheet");
      AUTOX = strip(sync("/tech-sheets/templates/sccnh-gravel-trials.json"), "drc-autox", "Demo Rally Club Autocross Tech Sheet", "Demo Rally Club autocross tech form");
    }
    return { RALLY, AUTOX };
  };
  const templates = () => [
    { id: "tpl-rally", body_id: "drc", key: "drc-rally", title: sheets().RALLY.title, definition: RALLY, version: 4, updated_at: at(-21), public: true },
    { id: "tpl-autox", body_id: "drc", key: "drc-autox", title: AUTOX.title, definition: AUTOX, version: 2, updated_at: at(-60), public: false },
    { id: "tpl-historic", body_id: "drc", key: "drc-rally-historic", title: "Demo Rally Club Historic Rally Tech Sheet",
      definition: Object.assign({}, RALLY, { id: "drc-rally-historic", title: "Demo Rally Club Historic Rally Tech Sheet" }), version: 1, updated_at: at(-30), public: false },
  ];

  // ---- Gear, as PassTech declares it ----
  const cert = (standardId, more) => Object.assign({ standardId }, more);
  const GEAR = {
    helmet1: { category: "helmet", helmetType: "full_face", certifications: [cert("snell-sa2020", { labelDate: "2021-05", serialNumber: "SA20-118832" })] },
    helmet2: { category: "helmet", helmetType: "full_face", certifications: [cert("snell-sa2020", { labelDate: "2022-02", serialNumber: "SA20-204417" })] },
    hans1: { category: "hnr", certifications: [cert("sfi-38.1", { labelDate: "2020-09", serialNumber: "H38-55120" })] },
    hans2: { category: "hnr", certifications: [cert("fia-8858-2010", { labelDate: "2019-04", homologationNumber: "HR.008.10", serialNumber: "88581-7731" })] },
    suit1: { category: "firesuit", certifications: [cert("fia-8856-2018", { labelDate: "2023-03", homologationNumber: "RS.322.18" })] },
    suit2: { category: "firesuit", certifications: [cert("sfi-3.2a-5", { labelDate: "2021-11" })] },
    seat1: { category: "seat", seatMounting: "fixed", certifications: [cert("fia-8855-2021", { labelDate: "2023-01", homologationNumber: "CS.401.21", tagExpirationDate: "2033-01" })] },
    harness1: { category: "belts_harness", certifications: [cert("fia-8853-2016", { labelDate: "2022-06", tagExpirationDate: "2027-12" })] },
  };
  // Tag photos: a drawn label, by the photo's name.
  const TAGS = {
    "tag-helmet1": ["SNELL", "SA2020", "S/N SA20-118832", "05/2021"], "tag-helmet2": ["SNELL", "SA2020", "S/N SA20-204417", "02/2022"],
    "tag-hans1": ["SFI 38.1", "HEAD & NECK", "S/N H38-55120", "09/2020"], "tag-hans2": ["FIA 8858-2010", "HR.008.10", "S/N 88581-7731", "04/2019"],
    "tag-seat1": ["FIA 8855-2021", "CS.401.21", "NOT VALID AFTER", "2033"], "tag-suit1": ["FIA 8856-2018", "RS.322.18", "03/2023"],
  };
  const photos = (item, tag) => [{ sha256: item, kind: "item" }, { sha256: tag, kind: "tag" }];
  const line = (declared, gear, item, tag) => ({ declared, gear: GEAR[gear], photos: item ? photos(item, tag) : [] });
  // The team's declarations, as PassTech submits them.
  const teamItems = (crew) => ({
    "helmet.driver": line("Bell HP7, Snell SA2020, label 2021-05", "helmet1", "helmet", "tag-helmet1"),
    "helmet.codriver": line("Stilo ST5 GT, Snell SA2020, label 2022-02", "helmet2", "helmet", "tag-helmet2"),
    "hnr.driver": line("HANS III, SFI 38.1", "hans1", "hans", "tag-hans1"),
    "hnr.codriver": line("Simpson Hybrid, FIA 8858-2010", "hans2", "hans", "tag-hans2"),
    "suit.driver": line("Sparco, FIA 8856-2018", "suit1", "suit", "tag-suit1"),
    "suit.codriver": line("OMP, SFI 3.2A/5", "suit2"),
    "seat_certified.driver": line("Sparco Pro 2000, FIA 8855-2021, valid to 2033", "seat1", "seat", "tag-seat1"),
    "harness.driver": line("Schroth 6-point, FIA 8853-2016, expires 2027-12", "harness1"),
    "fire_extinguishers": { declared: "2.5 lb dry chemical, metal bracket, service due " + iso(300).slice(0, 7) },
    "first_aid_kit": { declared: "Yes, in the rear seat area" },
    "triangles": { declared: "3 triangles" },
  }[crew] || null);
  const team = (car, by) => {
    const items = {};
    ["helmet.driver", "helmet.codriver", "hnr.driver", "hnr.codriver", "suit.driver", "suit.codriver", "seat_certified.driver", "harness.driver", "fire_extinguishers", "first_aid_kit", "triangles"]
      .forEach((k) => { items[k] = teamItems(k); });
    return { items, pictures: { car: [{ sha256: "car" }] }, submittedAt: at(-2, 19), by };
  };
  // Every line of a sheet with a result: pass, or N/A where the sheet allows it.
  const allPass = (t, variant, except) => {
    const items = {};
    window.TechSheet.lines(t, variant).forEach((s) => s.rows.forEach((r) => { if (!(except || []).includes(r.key)) items[r.key] = { result: r.item.allowNA && /turbo|restrictor/.test(r.key) ? "na" : "pass" }; }));
    return items;
  };
  const firstN = (t, n) => {
    const items = {};
    window.TechSheet.lines(t, null).flatMap((s) => s.rows).slice(0, n).forEach((r) => { items[r.key] = { result: "pass" }; });
    return items;
  };

  // ---- Events ----
  const E1 = "ev-pine", E2 = "ev-autox", E3 = "ev-thaw";
  const events = [
    { id: E1, name: "Pine Hills Rally", body: "drc", discipline: "rally", disciplineName: "Rally", location: "Lancaster, NH", scrutineeringStartsOn: iso(0), startsOn: iso(1), endsOn: iso(2),
      open: true, myRole: "chief", organizer: true, cars: 9, passed: 3, failed: 1, pending: 5 },
    { id: E2, name: "Autumn Autocross #4", body: "drc", discipline: "autox", disciplineName: "Autocross", location: "Loudon, NH", scrutineeringStartsOn: iso(12), startsOn: iso(12), endsOn: iso(12),
      open: false, myRole: null, organizer: true, cars: 22, passed: 0, failed: 0, pending: 22 },
    { id: E3, name: "Spring Thaw Rally", body: "drc", discipline: "rally", disciplineName: "Rally", location: "Berlin, NH", scrutineeringStartsOn: iso(-185), startsOn: iso(-184), endsOn: iso(-183),
      open: false, myRole: "chief", organizer: true, cars: 14, passed: 13, failed: 1, pending: 0 },
  ];
  const car = (n, driver, codriver, cls, year, make, model, status, logbook, email) => ({
    entry: { id: "en-" + n, event_id: E1, car_number: String(n), driver, codriver, class: cls, email, tech_status: status, vehicle: { year, make, model }, logbook_id: logbook ? "lb-" + n : null },
    logbook: logbook ? { id: "lb-" + n, year, make, model, vin: logbook.vin, issuing_body: "drc", digital_number: logbook.number } : null,
  });
  const entries = [
    car(7, "Casey Rivera", "Morgan Hale", "O4WD", "2008", "Subaru", "Impreza WRX", "pending", { number: "DRC-01-412378", vin: "JF1GH61628H412378" }, "casey.rivera@example.com"),
    car(12, "Priya Nair", "Ben Ortiz", "L2WD", "2002", "Ford", "Focus", "pending", { number: "DRC-14-209911", vin: "1FAFP33P92W209911" }, "priya.nair@example.com"),
    car(23, "Jordan Lee", "Avery Stone", "O4WD", "2015", "Subaru", "WRX STI", "pending", { number: "DRC-01-800123", vin: "JF1VA2M67F9800123" }, "jordan.lee@example.com"),
    car(31, "Chris Walker", "Dana Fox", "NA", "1990", "Volvo", "240", "pending", { number: "DRC-09-331206", vin: "YV1AA8847L1331206" }, "chris.walker@example.com"),
    car(41, "Taylor Brooks", "Sam Rivera", "O4WD", "2011", "Mitsubishi", "Lancer Evolution X", "pending", { number: "DRC-14-017734", vin: "JA32W8FV2BU017734" }, "taylor.brooks@example.com"),
    car(55, "Pat Kim", "Lee Novak", "P2WD", "2004", "Honda", "Civic", "passed", { number: "DRC-01-055412", vin: "2HGES16584H055412" }, "pat.kim@example.com"),
    car(64, "Robin Grant", "Jesse Park", "O2WD", "1999", "BMW", "328i", "passed", { number: "DRC-22-640918", vin: "WBAAM3334XFP40918" }, "robin.grant@example.com"),
    car(88, "Drew Silva", "Kai Moreno", "O4WD", "2006", "Mitsubishi", "Lancer Evolution IX", "passed", { number: "DRC-14-880045", vin: "JA3AH86C16U880045" }, "drew.silva@example.com"),
    car(9, "Quinn Hayes", "Rory Ellis", "L2WD", "1985", "Toyota", "Corolla", "failed", { number: "DRC-09-090877", vin: "JT2AE86C0F0090877" }, "quinn.hayes@example.com"),
  ];
  const header = (x) => ({ event: "Pine Hills Rally", car_number: x.entry.car_number, driver: x.entry.driver, codriver: x.entry.codriver,
    year: x.entry.vehicle.year, make: x.entry.vehicle.make, model: x.entry.vehicle.model, vin: x.logbook && x.logbook.vin });
  const techSheets = () => {
    const t = sheets().RALLY;
    const byNum = (n) => entries.find((x) => x.entry.car_number === String(n));
    const sheet = (n, status, competitor, inspection) => ({ id: "ts-" + n, carNumber: String(n), template: t, templateId: "tpl-rally", header: header(byNum(n)), variant: null,
      competitor, inspection, status, lockedBy: null });
    return [
      sheet(7, "pending", team(7, "casey.rivera@example.com"), { items: allPass(t) }),
      sheet(12, "pending", team(12, "priya.nair@example.com"), { items: firstN(t, 18) }),
      sheet(23, "pending", team(23, "jordan.lee@example.com"), { items: {} }),
      sheet(41, "pending", team(41, "taylor.brooks@example.com"), { items: allPass(t, null, ["harness.driver", "harness.codriver"]),
        history: [{ at: at(-1, 15), signatures: { scrutineer: { name: "Jamie Chen" } }, corrections: "Replace the driver's harness: its FIA label expired", resubmittedAt: at(-1, 21) }] }),
      Object.assign(sheet(55, "passed", team(55, "pat.kim@example.com"), { items: allPass(t), result: "pass", signatures: { scrutineer: { name: "Jamie Chen", license: "DRC-014", at: at(0, 9) } } }), {}),
      sheet(64, "passed", null, { items: allPass(t), result: "pass", signatures: { scrutineer: { name: "Alex Morgan", license: "DRC-001", at: at(0, 9) } } }),
      sheet(88, "passed", team(88, "drew.silva@example.com"), { items: allPass(t), result: "pass", signatures: { scrutineer: { name: "Jamie Chen", license: "DRC-014", at: at(0, 10) } } }),
      sheet(9, "failed", null, { items: Object.assign(allPass(t), { "seat_secure.driver": { result: "fail", note: "Seat mount cracked at the rear left bolt" } }), result: "fail",
        corrections: "Repair or replace the driver's seat mount", signatures: { scrutineer: { name: "Jamie Chen", license: "DRC-014", at: at(0, 11) } } }),
    ];
  };
  // Sheets saved here (by car number): the demo server keeps them, with the version each save
  // makes (updatedAt), and refuses a save from an older one like the real server (a conflict).
  const saved = {};
  let version = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 27, 8, 0, 0) + ++version * 1000).toISOString().replace("Z", "") + "123+00:00";
  const BASE = stamp();
  const sheetNow = (car) => saved[car] || techSheets().map((x) => Object.assign({ updatedAt: BASE }, x)).find((x) => x.carNumber === car) || null;
  const allSheets = () => techSheets().map((x) => saved[x.carNumber] || Object.assign({ updatedAt: BASE }, x))
    .concat(Object.values(saved).filter((x) => !techSheets().some((y) => y.carNumber === x.carNumber)));
  const bundle = (id) => {
    const ev = events.find((e) => e.id === id);
    const t = sheets();
    return {
      event: { id, body_id: "drc", discipline: ev.discipline, name: ev.name, location: ev.location, scrutineering_starts_on: ev.scrutineeringStartsOn, starts_on: ev.startsOn, ends_on: ev.endsOn,
        accepted_bodies: ["drc", "gmr"] },
      staff: id === E1 ? [{ email: ME, role: "chief", canSignOff: true }, { email: "jamie.chen@example.com", role: "scrutineer", canSignOff: true }, { email: "sam.patel@example.com", role: "scrutineer", canSignOff: false }]
        : [{ email: "sam.patel@example.com", role: "chief", canSignOff: true }],
      entries: id === E1 ? entries : [],
      techTemplates: [{ id: ev.discipline === "autox" ? "tpl-autox" : "tpl-rally", title: (ev.discipline === "autox" ? t.AUTOX : t.RALLY).title, definition: ev.discipline === "autox" ? t.AUTOX : t.RALLY, classes: [], body: "drc" }],
      techSheets: id === E1 ? allSheets() : [],
    };
  };

  // ---- Stickers ----
  const snapshot = (category, gear, driver, pics, occupant) => ({ category, gear: GEAR[gear], driver, photos: pics, occupant });
  const sticker = (code, category, gear, driver, pics, issuedBy, daysAgo, extra) => Object.assign({ code, kind: "gear", body: "drc", discipline: "autox", disciplineName: "Autocross", disciplineShort: "AUTOX",
    season: 2026, snapshot: snapshot(category, gear, driver, pics), issuedBy, issuedAt: at(-daysAgo, 14), voidedAt: null }, extra);
  const annual = [
    sticker("K7M2Q9TX", "helmet", "helmet1", "Jordan Lee", photos("helmet", "tag-helmet1"), "Alex Morgan", 160),
    sticker("B4RW8N2D", "hnr", "hans1", "Jordan Lee", photos("hans", "tag-hans1"), "Alex Morgan", 160),
    sticker("H2PZ6V5C", "helmet", "helmet2", "Casey Rivera", photos("helmet", "tag-helmet2"), "Sam Patel", 95),
    sticker("T9QK3M7A", "seat", "seat1", "Casey Rivera", photos("seat", "tag-seat1"), "Sam Patel", 95),
    sticker("W5NC8J4E", "helmet", "helmet1", "Priya Nair", photos("helmet", "tag-helmet1"), "Sam Patel", 40, { voidedAt: at(-12, 9) }),
    // From before the club had disciplines.
    sticker("M8DX4P2N", "helmet", "helmet2", "Ben Ortiz", photos("helmet", "tag-helmet2"), "Alex Morgan", 200, { discipline: null, disciplineName: null, disciplineShort: null }),
  ];
  const submitters = { K7M2Q9TX: "jordan.lee@example.com", B4RW8N2D: "jordan.lee@example.com", T9QK3M7A: "casey.rivera@example.com" };
  const applications = [
    { id: "ap1", body: "drc", discipline: "autox", season: 2026, category: "helmet", owner: "Morgan Hale", submittedBy: "morgan.hale@example.com", submittedAt: at(-3, 18),
      gear: GEAR.helmet2, photos: photos("helmet", "tag-helmet2"), status: "pending" },
    { id: "ap2", body: "drc", discipline: "autox", season: 2026, category: "hnr", owner: "Morgan Hale", submittedBy: "morgan.hale@example.com", submittedAt: at(-3, 18),
      gear: GEAR.hans2, photos: photos("hans", "tag-hans2"), status: "pending" },
    { id: "ap3", body: "drc", discipline: "rally", season: 2026, category: "helmet", owner: "Ben Ortiz", submittedBy: "ben.ortiz@example.com", submittedAt: at(-1, 20),
      gear: GEAR.helmet1, photos: photos("helmet", "tag-helmet1"), status: "pending" },
    { id: "ap4", body: "drc", discipline: null, season: 2026, category: "seat", owner: "Ben Ortiz", submittedBy: "ben.ortiz@example.com", submittedAt: at(-190, 20),
      gear: GEAR.seat1, photos: photos("seat", "tag-seat1"), status: "pending" },
  ];
  // Stickers issued from a car's tech sheet at the event (the passed cars).
  const sheetStickers = (sheetId) => {
    const n = String(sheetId).replace("ts-", "");
    if (!["55", "64", "88"].includes(n)) return [];
    const x = entries.find((e) => e.entry.car_number === n);
    const base = { body: "drc", discipline: "rally", disciplineShort: "RALLY", issuedBy: "Jamie Chen", issuedAt: at(0, 10), voidedAt: null, event: E1 };
    return [
      Object.assign({ code: "R" + n + "HD4XQ", kind: "gear", item: "helmet.driver", snapshot: snapshot("helmet", "helmet1", x.entry.driver, photos("helmet", "tag-helmet1"), "driver") }, base),
      Object.assign({ code: "R" + n + "HC7PM", kind: "gear", item: "helmet.codriver", snapshot: snapshot("helmet", "helmet2", x.entry.codriver, photos("helmet", "tag-helmet2"), "codriver") }, base),
      Object.assign({ code: "C" + n + "TP2KW", kind: "car", snapshot: { carNumber: n } }, base),
    ];
  };
  const view = (code) => {
    const s = annual.concat(...["55", "64", "88"].map((n) => sheetStickers("ts-" + n))).find((x) => x.code === code);
    if (!s) return null;
    return Object.assign({}, s, { status: s.voidedAt ? "void" : "valid", voidReason: s.voidedAt ? "item replaced" : null, bodyName: "Demo Rally Club",
      inspector: { name: s.issuedBy, license: s.issuedBy === "Alex Morgan" ? "DRC-001" : s.issuedBy === "Sam Patel" ? "DRC-022" : "DRC-014" }, staff: true,
      event: s.event ? { name: "Pine Hills Rally", location: "Lancaster, NH", startsOn: iso(1), endsOn: iso(2) } : null });
  };

  // ---- The RPCs ----
  const RPC = {
    my_roles: () => roles,
    my_garage: () => [],
    logbook_heads: () => [],
    my_events: () => events,
    event_bundle: (a) => bundle(a.p_event),
    list_stickers: (a) => {
      const p = a.p || {};
      if (p.techSheet) return sheetStickers(p.techSheet);
      if (p.event) return ["55", "64", "88"].flatMap((n) => sheetStickers("ts-" + n));
      return annual.filter((s) => (!("discipline" in p) || (s.discipline || "") === p.discipline) && (!p.season || s.season === p.season));
    },
    list_sticker_applications: (a) => (a.p_status === "issued"
      ? Object.entries(submitters).map(([stickerCode, submittedBy]) => ({ stickerCode, submittedBy, discipline: "autox" }))
      : applications.filter((x) => x.body === a.p_body)),
    sticker_view: (a) => view(a.p_code),
    issue_sticker: (a) => Object.assign({ code: a.p.code || "N3WS7K2R", event: E1, item: a.p.item || null, kind: a.p.kind, body: "drc", discipline: a.p.discipline || "rally", disciplineShort: (a.p.discipline || "rally").toUpperCase(), season: a.p.season,
      issuedAt: new Date().toISOString(), snapshot: { category: "helmet", carNumber: "23" } }),
    save_tech_sheet: (a) => {
      const p = a.p, now = sheetNow(String(p.carNumber));
      if ("baseUpdatedAt" in p && now && p.baseUpdatedAt !== now.updatedAt) {
        throw Object.assign(new Error("conflict: car " + p.carNumber + "'s sheet changed since this device last had it (by " + (now.inspectedBy || ME) + ", at " + now.updatedAt + ")"), { code: "TS409" });
      }
      const t = sheets().RALLY;
      const sigAt = p.offlineAt || new Date().toISOString();
      const s = Object.assign({ id: "ts-" + p.carNumber, carNumber: String(p.carNumber), template: t, templateId: "tpl-rally", competitor: null, lockedBy: null }, now, {
        header: p.header || (now && now.header) || {}, variant: p.variant || null, status: p.finish === "pass" ? "passed" : p.finish === "fail" ? "failed" : "inspecting",
        inspection: Object.assign({}, p.inspection, p.finish ? { result: p.finish, signatures: { scrutineer: { name: "Alex Morgan", license: "DRC-001", at: sigAt } } } : {}),
        inspectedBy: ME, updatedAt: stamp() });
      saved[s.carNumber] = s;
      if (p.finish) entries.forEach((x) => { if (x.entry.car_number === s.carNumber) x.entry.tech_status = s.status; });
      return s;
    },
    reserve_sticker_codes: (a) => Array.from({ length: 30 }, (_, i) => "OFF" + String.fromCharCode(65 + Math.floor(i / 10)) + "2" + "3456789ABC"[i % 10] + "XY"),
    search_logbooks: () => [],
    lock_tech_sheet: () => null,
  };
  const TABLES = { bodies: () => bodies, body_disciplines: () => disciplines, accreditations: () => accreditations, tech_sheet_templates: templates, records: () => [] };
  // window.demoOffline = true: every call fails like a lost connection (testing working offline).
  // window.demoTouch(car): another scrutineer changes that car's sheet (testing conflicts).
  const NO_NETWORK = { message: "TypeError: Failed to fetch", code: "" };
  try { window.demoOffline = localStorage.getItem("demoOffline") === "1"; } catch (e) { /* online */ }
  window.demoTouch = (car) => {
    const now = sheetNow(String(car));
    const items = Object.assign({}, now.inspection.items);
    const key = Object.keys(items)[0] || "helmet.driver";
    items[key] = Object.assign({}, items[key], { result: "fail", note: "Checked by Jamie: chin strap frayed" });
    saved[now.carNumber] = Object.assign({}, now, { inspection: Object.assign({}, now.inspection, { items }), inspectedBy: "jamie.chen@example.com", updatedAt: stamp() });
  };
  const result = (fn) => {
    if (window.demoOffline) return { data: null, error: NO_NETWORK };
    try { return { data: fn(), error: null }; } catch (e) { console.error("demo server:", e); return { data: null, error: { message: String(e && e.message), code: e.code || "" } }; }
  };
  const query = (table) => {
    const q = { select: () => q, order: () => q, eq: () => q, in: () => q, limit: () => q,
      then: (ok, bad) => Promise.resolve(result(TABLES[table] || (() => []))).then(ok, bad) };
    return q;
  };
  // Photos: the demo pictures, and drawn tags.
  const photoBlob = async (sha) => {
    if (TAGS[sha]) {
      const c = document.createElement("canvas");
      c.width = 480; c.height = 320;
      const g = c.getContext("2d");
      g.fillStyle = "#8a8f98"; g.fillRect(0, 0, 480, 320);
      g.fillStyle = "#f7f3e6"; g.fillRect(60, 50, 360, 220);
      g.strokeStyle = "#222"; g.lineWidth = 4; g.strokeRect(60, 50, 360, 220);
      g.fillStyle = "#111"; g.textAlign = "center";
      TAGS[sha].forEach((t, i) => { g.font = (i === 0 ? "bold 40px" : "26px") + " Arial"; g.fillText(t, 240, 105 + i * 48); });
      return new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    }
    const res = await fetch("/tools/manual/demo-photos/" + sha + ".jpg");
    return res.blob();
  };
  const client = {
    auth: {
      // (?demo=signedout: the sign-in screen.)
      // (?demo=nosession: no sign-in to renew -- like starting with no connection.)
      onAuthStateChange: (cb) => {
        const none = /demo=(signedout|nosession)/.test(location.search);
        setTimeout(() => cb(none ? "INITIAL_SESSION" : "SIGNED_IN", none ? null : { user: { id: "demo-user", email: ME } }), 50);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      signOut: async () => ({ error: null }), signInWithOtp: async () => ({ error: null }), verifyOtp: async () => ({ error: null }),
      getSession: async () => ({ data: { session: { user: { id: "demo-user", email: ME } } }, error: null }),
    },
    rpc: async (fn, args) => (RPC[fn] ? result(() => RPC[fn](args || {})) : (console.warn("demo server: no rpc", fn), { data: null, error: null })),
    from: query,
    storage: { from: () => ({ download: async (sha) => (window.demoOffline ? { data: null, error: NO_NETWORK } : { data: await photoBlob(sha), error: null }),
      upload: async () => ({ error: window.demoOffline ? NO_NETWORK : null }) }) },
  };
  let real;
  Object.defineProperty(window, "supabase", { configurable: true,
    get: () => Object.assign({}, real, { createClient: () => client }),
    set: (v) => { real = v; } });
})();
