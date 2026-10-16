// Digital tech inspection sheets (tech-sheets/FORMAT.md) -- the sheet a
// scrutineer fills or reviews in Event mode, and the template editor a
// technical director uses in Admin mode. Plain DOM, no state of its own: the
// caller (account.js) keeps the sheet and re-renders.
//   TechSheet.lines(template, variant)  -> [{ section, rows: [{ key, item, occupant, label }] }]
//   TechSheet.sheet(opts)               -> the sheet, filled in place (see sheet())
//   TechSheet.editor(definition, onChange) -> the template editor
//   TechSheet.counts(template, variant, inspection) -> { pass, fail, na, todo, total }
(function () {
  // This script's own folder: passtech-engine.js sits next to it.
  const HERE = (document.currentScript && document.currentScript.src) || document.baseURI;
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
  const OCCUPANTS = [["driver", "Driver"], ["codriver", "Co-driver"]];
  // "Helmet" -> "helmet" after "Driver ", but "HNR" stays "HNR".
  const lc = (s) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

  // Whether a car class (variant) has a co-driver: always without car
  // classes, else when the class says so (e.g. hillclimb R1/R2, not the rest).
  function hasCodriver(template, variant) {
    const vs = template.variants || [];
    if (!vs.length) return true;
    return !!(vs.find((x) => x.id === variant) || vs[0]).codriver;
  }
  // The sheet's lines for a variant: a perOccupant item twice when the car
  // has a co-driver, else once (the driver's, under the item's own name).
  function lines(template, variant) {
    const v = variant || ((template.variants || [])[0] || {}).id || null;
    const both = hasCodriver(template, v);
    return (template.sections || []).map((section) => ({
      section,
      rows: (section.items || [])
        .filter((item) => !item.variants || !v || item.variants.includes(v))
        .flatMap((item) => (item.perOccupant && both
          ? OCCUPANTS.map(([occ, who]) => ({ key: item.id + "." + occ, item, occupant: occ, label: who + " " + lc(item.label) }))
          : [{ key: item.id, item, occupant: item.perOccupant ? "driver" : null, label: item.label }])),
    })).filter((s) => s.rows.length);
  }
  function counts(template, variant, inspection) {
    const items = (inspection && inspection.items) || {};
    const c = { pass: 0, fail: 0, na: 0, todo: 0, total: 0 };
    lines(template, variant).forEach((s) => s.rows.forEach((r) => {
      c.total++;
      const res = (items[r.key] || {}).result;
      if (res === "pass" || res === "fail" || res === "na") c[res]++; else c.todo++;
    }));
    return c;
  }

  function fieldInput(f, value, onChange, disabled) {
    if (f.type === "choice") {
      return h("select", { disabled, onchange: (e) => onChange(e.target.value) }, [h("option", { value: "" }, ["—"]),
        (f.options || []).map((o) => h("option", { value: o, selected: o === value }, [o]))]);
    }
    // A gear line's certification: one per piece of gear, so one choice (kept as a one-item list).
    if (f.type === "single") {
      const cur = Array.isArray(value) ? value[0] : value;
      return h("span", { class: "techsheet-options" }, (f.options || []).map((o) => h("label", {}, [
        h("input", { type: "radio", name: f.name, disabled, checked: cur === o, onchange: () => onChange([o]) }), " " + o,
      ])));
    }
    if (f.type === "multi") {
      const set = new Set(Array.isArray(value) ? value : []);
      return h("span", { class: "techsheet-options" }, (f.options || []).map((o) => h("label", {}, [
        h("input", { type: "checkbox", disabled, checked: set.has(o), onchange: (e) => { if (e.target.checked) set.add(o); else set.delete(o); onChange([...set]); } }), " " + o,
      ])));
    }
    return h("input", { type: f.type === "number" ? "number" : f.type === "date" ? "date" : "text", value: value == null ? "" : value, disabled,
      oninput: (e) => onChange(e.target.value) });
  }

  // ---- PassTech's gear checking (passtech-engine.js, built by PassTech) ------
  // Loaded when a sheet first needs it (it's large): window.PassTechEngine --
  // the rulesets, standards and matcher PassTech judges gear with.
  let engineLoading = null;
  function loadEngine() {
    if (window.PassTechEngine) return Promise.resolve(window.PassTechEngine);
    if (!engineLoading) {
      engineLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = new URL("passtech-engine.js", HERE).href;
        s.onload = () => resolve(window.PassTechEngine);
        s.onerror = () => { engineLoading = null; reject(new Error("couldn't load PassTech's gear checks")); };
        document.head.appendChild(s);
      });
    }
    return engineLoading;
  }
  // The PassTech ruleset a sheet's gear is judged against: the one named for
  // the car class ("neha-x" for X), else not one named for another car class,
  // else the first. Same rule as PassTech's defaultRulesetFor.
  function rulesetFor(E, template, variant) {
    let ids = (template.passtechRulesetIds || []).filter((id) => E.getRuleset(id));
    if (variant) {
      const byVariant = ids.find((id) => id.endsWith("-" + variant));
      if (byVariant) return E.getRuleset(byVariant);
      const others = (template.variants || []).filter((v) => v.id !== variant).map((v) => "-" + v.id);
      ids = ids.filter((id) => !others.some((o) => id.endsWith(o)));
    }
    return ids.length ? E.getRuleset(ids[0]) : null;
  }
  // PassTech's verdict on one line's gear details, or null (no engine, ruleset or details yet).
  function gearVerdict(E, rs, classId, cat, entry) {
    if (!E || !rs || !cat || !entry || E.isEntryEmpty(cat, entry)) return null;
    // Nothing chosen yet (the form's empty certification row): no verdict to show.
    if (entry.mode !== "material_only" && (entry.certifications || []).length && !entry.certifications.some((c) => c.standardId)) return null;
    const r = E.evaluateRuleset(rs, { [cat]: entry }, new Date(), classId || undefined)[cat];
    return r ? { status: r.status, requirement: r.requirement, reason: r.reason } : null;
  }
  const VERDICT_LABEL = { ok: "OK", rejected: "Rejected", not_required: "Not required", recommended_only: "Recommended only", needs_info: "Needs info", unrecognized: "Not recognized" };
  const verdictClass = (v) => (v.status === "ok" || v.status === "not_required" || v.status === "recommended_only" ? "ok" : v.status === "rejected" ? "bad" : "info");
  // What a gear entry says, in a line: "Snell SA2020, label 2021-03 · ...".
  function gearSummary(E, cat, e) {
    if (!e) return "";
    const certs = (e.certifications || []).map((c) => [c.standardId === E.NOT_LISTED ? c.customStandardLabel || "not listed" : c.standardId ? E.standardLabel(c.standardId) : "",
      c.labelDate ? "label " + c.labelDate : "", c.tagExpirationDate ? "expires " + c.tagExpirationDate : "", c.nextServiceDate ? "service due " + c.nextServiceDate : ""].filter(Boolean).join(", "));
    const units = (e.extinguisherUnits || []).map((u, i) => "#" + (i + 1) + ": " + [u.classARating ? u.classARating + "-A" : "", u.bcRating ? u.bcRating + "-B:C" : "", u.weightLbs ? u.weightLbs + " lb" : "",
      u.manufactureDate ? "made " + u.manufactureDate : "", u.certificationDueDate ? "due " + u.certificationDueDate : "", u.hasMetalBracket ? "metal bracket" : "", u.hasAntiTorpedoTabs ? "anti-torpedo" : ""].filter(Boolean).join(" "));
    const meta = E.CATEGORY_META[cat] || {};
    return [e.mode === "material_only" ? meta.materialOnlyLabel || "Fire-resistant material (no certification)" : "",
      e.helmetType ? (e.helmetType === "full_face" ? "full face" : "open face") : "", e.seatMounting ? (e.seatMounting === "rails" ? "on rails" : "fixed") : "",
      certs.join(" · "), units.join(" · "), e.towHookFront ? "front" : "", e.towHookRear ? "rear" : "",
      (e.windowBreakerUnits || []).length ? e.windowBreakerUnits.length + " tool(s)" : "", (e.triangleUnits || []).length ? e.triangleUnits.length + " triangle(s)" : "",
      meta.presenceOnly && e.skipped === false ? "present" : ""].filter(Boolean).join(" · ");
  }

  // ---- The gear details form (like PassTech's My gear) ---------------------
  // entry: an EquipmentEntry, edited in place. changed(rerender) after each change.
  const newKey = () => Math.random().toString(36).slice(2, 10);
  function gearForm(E, cat, entry, ed, changed) {
    const meta = E.CATEGORY_META[cat] || {};
    entry.category = cat;
    const field = (label, input, cls) => h("label", { class: "techsheet-field" + (cls ? " " + cls : "") }, [h("span", {}, [label]), input]);
    const date = (obj, k) => h("input", { type: "date", disabled: !ed, value: obj[k] || "", onchange: (e) => { obj[k] = e.target.value || undefined; changed(true); } });
    const num = (obj, k, ph) => h("input", { type: "number", min: "0", step: "any", disabled: !ed, placeholder: ph || "", value: obj[k] == null ? "" : obj[k],
      onchange: (e) => { obj[k] = e.target.value === "" ? undefined : Number(e.target.value); changed(true); } });
    const pick = (obj, k, options) => h("select", { disabled: !ed, onchange: (e) => { obj[k] = e.target.value || undefined; changed(true); } },
      [h("option", { value: "" }, ["—"])].concat(options.map(([v, l]) => h("option", { value: v, selected: obj[k] === v }, [l]))));
    const yesNo = (obj, k) => h("select", { disabled: !ed, onchange: (e) => { obj[k] = e.target.value === "" ? undefined : e.target.value === "yes"; changed(true); } },
      [["", "—"], ["yes", "Yes"], ["no", "No"]].map(([v, l]) => h("option", { value: v, selected: v === (obj[k] === true ? "yes" : obj[k] === false ? "no" : "") }, [l])));
    const small = (label, fn) => h("button", { type: "button", class: "btn small secondary", disabled: !ed, onclick: fn }, [label]);
    const out = [];

    if (cat === "fire_extinguisher") {
      entry.extinguisherUnits = entry.extinguisherUnits || [];
      entry.extinguisherUnits.forEach((u, i) => out.push(h("div", { class: "techsheet-gear-unit" }, [
        h("div", { class: "techsheet-gear-unit-title" }, ["Extinguisher " + (i + 1), small("Remove", () => { entry.extinguisherUnits.splice(i, 1); changed(true); })]),
        h("div", { class: "techsheet-values" }, [
          field("Class A rating", num(u, "classARating", "e.g. 1")), field("B:C rating", num(u, "bcRating", "e.g. 10")), field("Weight (lb)", num(u, "weightLbs", "e.g. 5")),
          field("Manufacture date", date(u, "manufactureDate")), field("Certification / service date", date(u, "certificationDate")), field("Service due date", date(u, "certificationDueDate")),
          field("Metal bracket", yesNo(u, "hasMetalBracket")), field("Metal straps", num(u, "metalStrapCount", "e.g. 2")), field("Anti-torpedo tabs", yesNo(u, "hasAntiTorpedoTabs")),
        ]),
      ])));
      out.push(small("+ Add " + (entry.extinguisherUnits.length ? "another " : "an ") + "extinguisher", () => { entry.extinguisherUnits.push({ key: newKey() }); changed(true); }));
      return out;
    }
    if (cat === "tow_hook") {
      return [h("div", { class: "techsheet-values" }, [field("Front tow point", yesNo(entry, "towHookFront")), field("Rear tow point", yesNo(entry, "towHookRear"))])];
    }
    if (cat === "window_breaker" || cat === "emergency_triangle") {
      const k = cat === "window_breaker" ? "windowBreakerUnits" : "triangleUnits";
      const count = h("input", { type: "number", min: "0", max: "6", disabled: !ed, value: (entry[k] || []).length, onchange: (e) => {
        const n = Math.max(0, Math.min(6, Number(e.target.value) || 0));
        entry[k] = Array.from({ length: n }, (_, i) => (entry[k] || [])[i] || { key: newKey() }); changed(true);
      } });
      return [field(cat === "window_breaker" ? "How many tools" : "How many triangles", count)];
    }
    if (cat === "rollover_protection") return [h("p", { class: "element-desc" }, ["The cage is checked on its logbook -- judge it there."])];
    if (meta.presenceOnly) {
      return [h("label", { class: "account-checks" }, [h("input", { type: "checkbox", disabled: !ed, checked: entry.skipped === false,
        onchange: (e) => { if (e.target.checked) entry.skipped = false; else delete entry.skipped; changed(true); } }), " Present in the car"])];
    }
    // Certified gear: the certification(s) and their dates; hybrid categories can be plain material / stock.
    if (meta.hybrid) {
      out.push(field("What it is", pick(entry, "mode", [["certified", meta.certifiedLabel || "Certified (SFI or FIA rated)"], ["material_only", meta.materialOnlyLabel || "Fire-resistant material (no certification)"]])));
    }
    if (cat === "helmet") out.push(field("Helmet type", pick(entry, "helmetType", [["full_face", "Full face"], ["open_face", "Open face"]])));
    if (cat === "seat") out.push(field("Mounting", pick(entry, "seatMounting", [["fixed", "Fixed"], ["rails", "On sliders / rails"]])));
    if (meta.hybrid && entry.mode !== "certified") return [h("div", { class: "techsheet-values" }, out)];
    entry.certifications = entry.certifications || [];
    if (!entry.certifications.length) entry.certifications.push({ key: newKey() });
    const standards = E.standardsFor(cat);
    const certRows = entry.certifications.map((c, i) => h("div", { class: "techsheet-values techsheet-gear-cert" }, [
      field("Certification", h("select", { disabled: !ed, onchange: (e) => { c.standardId = e.target.value || undefined; changed(true); } },
        [h("option", { value: "" }, ["—"])].concat(standards.map((s) => h("option", { value: s.id, selected: c.standardId === s.id }, [s.label])),
          [h("option", { value: E.NOT_LISTED, selected: c.standardId === E.NOT_LISTED }, ["Not listed…"])])), "wide"),
      c.standardId === E.NOT_LISTED ? field("Which", h("input", { type: "text", disabled: !ed, value: c.customStandardLabel || "", onchange: (e) => { c.customStandardLabel = e.target.value; changed(true); } })) : null,
      cat === "fire_suppression" ? field("Next service due", date(c, "nextServiceDate")) : field("Label / manufacture date", date(c, "labelDate")),
      cat === "fire_suppression" ? null : field("Expiration on the tag", date(c, "tagExpirationDate")),
      entry.certifications.length > 1 ? small("Remove", () => { entry.certifications.splice(i, 1); changed(true); }) : null,
    ]));
    return [h("div", { class: "techsheet-values" }, out), certRows];
  }

  // The sheet. opts: {
  //   template, variant, header, competitor, inspection (all filled in place),
  //   editable (the scrutineer can fill it in), view (the caller's object for
  //   what's folded: { open: {lineKey: bool}, closed: {sectionId: bool} }),
  //   photoUrl(sha) -> Promise<url>, addPhoto(file) -> Promise<sha256> (the
  //   scrutineer's own photos), setVariant(v), onChange() (re-render) }
  // Each line folds up once it has a result; a section folds when its title is clicked.
  function sheet(opts) {
    const t = opts.template;
    const header = opts.header;
    const insp = opts.inspection;
    insp.items = insp.items || {};
    const declared = (opts.competitor && opts.competitor.items) || {};
    const ed = !!opts.editable;
    const view = opts.view || {};
    view.open = view.open || {};
    view.closed = view.closed || {};
    const E = window.PassTechEngine || null;
    if (!E && t.sections.some((s) => (s.items || []).some((i) => i.gear))) loadEngine().then(() => opts.onChange(), () => {});
    const rs = E ? rulesetFor(E, t, opts.variant || ((t.variants || [])[0] || {}).id || null) : null;
    // The ruleset's class from the sheet's class field ("Prepared 2" -> its class id), when it has classes.
    const clsText = String(header.class || "").trim().toLowerCase();
    const classId = rs && clsText ? ((rs.classes || []).find((c) => c.label.toLowerCase() === clsText || c.id.toLowerCase() === clsText) || {}).id : undefined;
    const out = [];
    if (t.instructions) out.push(h("p", { class: "element-desc techsheet-instructions" }, [t.instructions]));
    if ((t.variants || []).length > 1) {
      out.push(h("div", { class: "techsheet-variants" }, ["Car class: ", t.variants.map((v) => h("label", {}, [
        h("input", { type: "radio", name: "techsheet-variant", disabled: !ed, checked: (opts.variant || t.variants[0].id) === v.id,
          onchange: () => { opts.setVariant(v.id); opts.onChange(); } }), " " + v.label + " ",
      ]))]));
    }
    // The team's photos of the car and crew (PassTech), to know them at a glance.
    const pics = (opts.competitor && opts.competitor.pictures) || {};
    const slots = [["Car", pics.car || []], ["Driver", pics.driver ? [pics.driver] : []], ["Co-driver", pics.codriver ? [pics.codriver] : []]].filter(([, l]) => l.length);
    if (slots.length) {
      out.push(h("div", { class: "techsheet-pictures" }, slots.map(([label, list]) => h("figure", {}, [
        h("div", { class: "techsheet-pictures-row" }, list.map((p) => photo(Object.assign({ kind: "item" }, p), opts))),
        h("figcaption", {}, [label]),
      ]))));
    }
    // Header.
    out.push(h("div", { class: "techsheet-header" }, (t.header || []).map((f) => h("label", { class: "techsheet-field" }, [
      h("span", {}, [f.label]), fieldInput(f, header[f.id], (v) => { header[f.id] = v; }, !ed),
    ]))));

    // Each line: its result, and PassTech's verdict on its gear (the scrutineer's details, else the team's).
    const groups = lines(t, opts.variant);
    const info = {};
    groups.forEach(({ rows }) => rows.forEach((r) => {
      const res = insp.items[r.key] = insp.items[r.key] || {};
      const dec = declared[r.key];
      // The team's gear details are the starting point for the scrutineer's.
      if (ed && r.item.gear && !res.gear && dec && dec.gear) res.gear = JSON.parse(JSON.stringify(dec.gear));
      info[r.key] = { res, dec, verdict: E && r.item.gear ? gearVerdict(E, rs, classId, r.item.gear, res.gear || (dec && dec.gear)) : null };
    }));
    const isOpen = (key) => (view.open[key] !== undefined ? view.open[key] : !info[key].res.result);
    const jump = (key, sectionId) => {
      view.open[key] = true; view.closed[sectionId] = false; opts.onChange();
      setTimeout(() => { const el = document.getElementById("techsheet-line-" + key); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 30);
    };

    // Summary: the counts, then the lines needing attention (each a link to it).
    const all = groups.flatMap(({ section, rows }) => rows.map((r) => ({ section, r, i: info[r.key] })));
    const count = (fn) => all.filter(fn).length;
    const passTechFlags = (x) => x.i.verdict && verdictClass(x.i.verdict) === "bad" && x.i.res.result !== "fail" && x.i.res.result !== "na";
    const attention = all.filter((x) => x.i.res.result === "fail" || passTechFlags(x) || !x.i.res.result)
      .sort((a, b) => rank(a) - rank(b));
    function rank(x) { return x.i.res.result === "fail" ? 0 : passTechFlags(x) ? 1 : 2; }
    out.push(h("div", { class: "techsheet-summary" }, [
      h("div", { class: "techsheet-summary-counts" }, [
        h("span", { class: "techsheet-chip pass" }, [count((x) => x.i.res.result === "pass") + " pass"]),
        h("span", { class: "techsheet-chip fail" }, [count((x) => x.i.res.result === "fail") + " fail"]),
        count((x) => x.i.res.result === "na") ? h("span", { class: "techsheet-chip na" }, [count((x) => x.i.res.result === "na") + " N/A"]) : null,
        h("span", { class: "techsheet-chip todo" }, [count((x) => !x.i.res.result) + " to check"]),
        count(passTechFlags) ? h("span", { class: "techsheet-chip warn", title: "PassTech rejects the gear details entered" }, [count(passTechFlags) + " flagged by PassTech"]) : null,
      ]),
      attention.length ? h("ul", { class: "techsheet-summary-list" }, attention.slice(0, view.summaryAll ? attention.length : 8).map((x) => h("li", {}, [
        h("button", { type: "button", onclick: () => jump(x.r.key, x.section.id) }, [
          h("span", { class: "techsheet-chip " + (x.i.res.result === "fail" ? "fail" : passTechFlags(x) ? "warn" : "todo") }, [x.i.res.result === "fail" ? "Fail" : passTechFlags(x) ? "PassTech: rejected" : "To check"]),
          " " + x.r.label, h("span", { class: "element-desc" }, [" · " + x.section.title]),
          passTechFlags(x) || x.i.res.result === "fail" ? h("span", { class: "element-desc techsheet-summary-why" }, [x.i.res.note || (x.i.verdict ? x.i.verdict.reason : "")]) : null,
        ]),
      ]))) : h("p", { class: "element-desc" }, ["Every line has a result."]),
      attention.length > 8 ? h("button", { type: "button", class: "btn small secondary", onclick: () => { view.summaryAll = !view.summaryAll; opts.onChange(); } },
        [view.summaryAll ? "Show fewer" : "Show all " + attention.length]) : null,
    ]));

    // Sections: a title bar (click to fold) with its progress, then its lines.
    groups.forEach(({ section, rows }) => {
      const closed = !!view.closed[section.id];
      const done = rows.filter((r) => info[r.key].res.result).length;
      const fails = rows.filter((r) => info[r.key].res.result === "fail").length;
      out.push(h("div", { class: "techsheet-section" + (closed ? " closed" : "") }, [
        h("button", { type: "button", class: "techsheet-section-title", "aria-expanded": String(!closed), onclick: () => { view.closed[section.id] = !closed; opts.onChange(); } }, [
          h("span", {}, [(closed ? "▸ " : "▾ ") + section.title]),
          h("span", { class: "element-desc" }, [done + "/" + rows.length + " checked" + (fails ? " · " + fails + " fail" : "")]),
        ]),
        closed ? null : rows.map((r) => line(r, section)),
      ]));
    });

    function line(r, section) {
      const { res, dec, verdict } = info[r.key];
      const open = isOpen(r.key);
      const set = (result) => {
        res.result = res.result === result ? undefined : result;
        // Judged: fold the line away (unless it was just cleared).
        view.open[r.key] = res.result ? false : true;
        opts.onChange();
      };
      const choice = (result, label, cls) => h("button", { type: "button", disabled: !ed,
        class: "techsheet-result " + cls + (res.result === result ? " on" : ""), onclick: (e) => { e.stopPropagation(); set(result); } }, [label]);
      const results = h("div", { class: "techsheet-results" }, [
        choice("pass", "Pass", "pass"), choice("fail", "Fail", "fail"),
        r.item.allowNA || r.item.checkedBy === "team" ? choice("na", "N/A", "na") : null,
      ]);
      const verdictChip = verdict ? h("span", { class: "techsheet-verdict " + verdictClass(verdict), title: verdict.reason }, ["PassTech: " + VERDICT_LABEL[verdict.status]]) : null;
      const head = h("div", { class: "techsheet-line-head", onclick: () => { view.open[r.key] = !open; opts.onChange(); } }, [
        h("span", { class: "techsheet-caret" }, [open ? "▾" : "▸"]),
        h("strong", {}, [r.label]),
        r.item.checkedBy === "team" ? h("span", { class: "badge info", title: "Checked by the competitor" }, ["competitor"]) : null,
        verdictChip,
        !open && res.note ? h("span", { class: "element-desc techsheet-line-note" }, [res.note]) : null,
        h("span", { class: "techsheet-line-spacer" }),
        results,
      ]);
      if (!open) return h("div", { class: "techsheet-row folded" + (res.result ? " " + res.result : ""), id: "techsheet-line-" + r.key }, [head]);
      const gearEntry = r.item.gear ? (ed ? (res.gear = res.gear || { category: r.item.gear }) : res.gear || (dec && dec.gear)) : null;
      return h("div", { class: "techsheet-row" + (res.result ? " " + res.result : ""), id: "techsheet-line-" + r.key }, [
        head,
        h("div", { class: "techsheet-item" }, [
          r.item.accepts ? h("div", { class: "element-desc" }, [r.item.accepts]) : null,
          r.item.rule ? h("div", { class: "element-ref" }, [r.item.rule]) : null,
          dec ? h("div", { class: "techsheet-declared" }, [
            h("span", {}, ["Competitor: " + (dec.declared || (dec.done ? "OK" : dec.na ? "N/A" : "—"))]),
            // Its values, by their field's label (PassTech's own keys, "__options", hold what it ticked).
            Object.entries(dec.values || {}).filter(([k, v]) => v !== "" && v != null).map(([k, v]) => {
              const f = (r.item.fields || []).find((x) => x.id === k);
              const label = k === "__options" ? "ticked" : f ? f.label : k;
              return h("span", { class: "element-desc" }, [" · " + label + ": " + (Array.isArray(v) ? v.join(", ") : v)]);
            }),
            E && dec.gear ? h("span", { class: "element-desc" }, [" · details: " + gearSummary(E, r.item.gear, dec.gear)]) : null,
            (dec.photos || []).length ? h("span", { class: "techsheet-photos" }, dec.photos.map((p) => photo(p, opts))) : null,
          ]) : null,
          // The gear's details, as PassTech asks for them -- with PassTech's verdict on them.
          gearEntry ? h("div", { class: "techsheet-gear-form" }, [
            h("div", { class: "techsheet-gear-form-title" }, ["Gear details" + (dec && dec.gear ? " (from the competitor's sheet -- correct them if needed)" : "")]),
            E ? gearForm(E, r.item.gear, gearEntry, ed, () => opts.onChange()) : h("p", { class: "element-desc" }, ["Loading PassTech's gear checks…"]),
            verdict ? h("div", { class: "techsheet-verdict-box " + verdictClass(verdict) }, [h("strong", {}, ["PassTech: " + VERDICT_LABEL[verdict.status] + " -- "]), verdict.reason]) : null,
          ]) : null,
          (r.item.fields || []).length ? h("div", { class: "techsheet-values" }, r.item.fields.map((f) => h("label", { class: "techsheet-field" }, [
            h("span", {}, [f.label + (f.unit ? " (" + f.unit + ")" : "")]),
            fieldInput(f, (res.values || {})[f.id], (v) => { res.values = Object.assign({}, res.values, { [f.id]: v }); }, !ed),
          ]))) : null,
          // The tick list -- not for gear lines, whose details say what's fitted.
          (r.item.options || []).length && !gearEntry ? h("div", { class: "techsheet-values" }, [
            fieldInput({ type: r.item.gear ? "single" : "multi", name: "techsheet-seen-" + r.key, options: r.item.options }, res.seen, (v) => { res.seen = v; }, !ed)]) : null,
          (ed || res.note) ? h("input", { type: "text", class: "techsheet-note", placeholder: "Note", value: res.note || "", disabled: !ed,
            oninput: (e) => { res.note = e.target.value; } }) : null,
          // The scrutineer's own photos of it.
          h("div", { class: "techsheet-photos techsheet-own-photos" }, [
            (res.photos || []).map((p, i) => h("span", { class: "techsheet-own-photo" }, [photo(p, opts),
              ed ? h("button", { type: "button", class: "techsheet-photo-x", title: "Remove", onclick: () => { res.photos.splice(i, 1); opts.onChange(); } }, ["×"]) : null])),
            ed && opts.addPhoto ? addPhotoButton(res) : null,
          ]),
        ]),
      ]);
    }
    function addPhotoButton(res) {
      const input = h("input", { type: "file", accept: "image/*", multiple: true, class: "techsheet-file", onchange: async () => {
        const files = [...input.files];
        input.value = "";
        for (const f of files) {
          try { const sha = await opts.addPhoto(f); res.photos = (res.photos || []).concat({ sha256: sha, kind: "item" }); }
          catch (e) { alert("Couldn't add the photo: " + (e.message || e)); }
        }
        opts.onChange();
      } });
      return h("label", { class: "btn small secondary techsheet-add-photo" }, ["📷 Add photo", input]);
    }

    out.push(h("label", { class: "techsheet-field techsheet-corrections" }, [
      h("span", {}, ["Corrections required"]),
      h("textarea", { rows: 2, disabled: !ed, oninput: (e) => { insp.corrections = e.target.value; } }, [insp.corrections || ""]),
    ]));
    const sigs = insp.signatures || {};
    const signed = (t.signoff || []).filter((s) => sigs[s.id]);
    if (signed.length) {
      out.push(h("div", { class: "element-desc" }, signed.map((s) => {
        const x = sigs[s.id];
        return h("div", {}, [s.label + ": " + x.name + (x.license ? " (" + x.license + ")" : "") + " · " + new Date(x.at).toLocaleString()]);
      })));
    }
    return h("div", { class: "techsheet" }, out);
  }
  // A team photo (in the tech-sheet-photos bucket), loaded when shown.
  function photo(p, opts) {
    const img = h("img", { alt: p.kind === "tag" ? "Tag photo" : "Photo", title: p.kind === "tag" ? "Tag / label" : "Photo" });
    const a = h("a", { target: "_blank", rel: "noopener", class: "techsheet-photo" + (p.kind === "tag" ? " tag" : "") }, [img]);
    if (opts.photoUrl) opts.photoUrl(p.sha256).then((url) => { if (url) { img.src = url; a.href = url; } }).catch(() => {});
    return a;
  }

  // ---- Gear picker (the editor's PassTech categories) -----------------------
  // tech-sheets/gear-catalog.json, exported from PassTech (its
  // scripts/export-gear-catalog.mjs): the categories with their icons and
  // standards, and every ruleset's accepted standards per category and class.
  let catalog = null, catalogLoading = null;
  function loadCatalog() {
    if (!catalogLoading) {
      catalogLoading = fetch("/tech-sheets/gear-catalog.json").then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then((c) => { catalog = c; return c; })
        .catch((e) => { catalogLoading = null; throw e; });
    }
    return catalogLoading;
  }
  const REQ_ROWS = [["required", "Required"], ["conditional", "Conditional"], ["recommended", "Recommended"], ["not_addressed", "Not in the rules"]];
  // A ruleset's rule for a category, with its class's override.
  function ruleFor(rs, cls, cat) {
    if (!rs) return null;
    const c = cls && (rs.classes || []).find((x) => x.id === cls);
    return (c && c.overrides[cat]) || rs.categories[cat] || null;
  }
  const standardLabel = (cat, id) => ((cat.standards || []).find((s) => s.id === id) || {}).label || id;
  // The line's tick list is its accepted standards; its "what is accepted"
  // text only says what the list doesn't (material accepted, no certification)
  // -- kept in step while it's still the generated one (not rewritten by hand).
  // The tick list: the accepted standards, then the no-certification choice
  // when the sheet accepts it (stock/OEM belts, plain fire-resistant socks...).
  const autoOptions = (cat, ids, noCert) => ids.map((id) => standardLabel(cat, id)).concat(noCert && cat.noCertLabel ? [cat.noCertLabel] : []);
  function setStandards(it, cat, ids, noCert) {
    if (noCert === undefined) noCert = !!it.noCert;
    const wasAuto = !it.accepts || /^(Accepted: |No certification required|Fire-resistant material accepted without)/.test(it.accepts);
    const optionsWereAuto = !it.options || !it.options.length || JSON.stringify(it.options) === JSON.stringify(autoOptions(cat, it.standards || [], !!it.noCert));
    it.standards = ids;
    if (noCert) it.noCert = true; else delete it.noCert;
    if (wasAuto) { if (ids.length || noCert) delete it.accepts; else it.accepts = "No certification required"; }
    if (optionsWereAuto) { const o = autoOptions(cat, ids, noCert); if (o.length) it.options = o; else delete it.options; }
  }
  // The ruleset the editor pre-fills from (st.ruleset, st.cls), once the catalog is in.
  function gearContext(def, st) {
    if (!catalog) return null;
    const bodyRulesets = catalog.rulesets.filter((r) => r.bodyId === def.bodyId || (def.passtechRulesetIds || []).includes(r.id));
    if (st.ruleset === undefined) st.ruleset = ((def.passtechRulesetIds || [])[0]) || (bodyRulesets[0] || {}).id || "";
    const rs = catalog.rulesets.find((r) => r.id === st.ruleset) || null;
    if (rs && st.cls && !(rs.classes || []).some((c) => c.id === st.cls)) st.cls = "";
    return { rs, cls: st.cls, bodyRulesets, others: catalog.rulesets.filter((r) => !bodyRulesets.includes(r)) };
  }
  // A gear line's accepted standards, inside the line: the ticked ones, or
  // (Show all) every standard for its category, the ruleset's first.
  function standardsBox(it, ctx, st, small, onChange) {
    const cat = catalog.categories.find((c) => c.id === it.gear);
    if (!cat) return null;
    const rs = ctx.rs;
    const rule = ruleFor(rs, ctx.cls, cat.id);
    const inRules = new Map(((rule && rule.accepted) || []).map((a) => [a.id, a]));
    const ids = it.standards || [];
    const known = new Set(cat.standards.map((x) => x.id));
    const list = cat.standards.concat(ids.filter((id) => !known.has(id)).map((id) => ({ id, label: id })));
    list.sort((a, b) => (inRules.has(b.id) ? 1 : 0) - (inRules.has(a.id) ? 1 : 0));
    st.expanded = st.expanded || {};
    const all = !!st.expanded[it.id];
    const shown = all ? list : list.filter((x) => ids.includes(x.id));
    return h("div", { class: "techsheet-standards-box" }, [
      h("div", { class: "techsheet-gear-actions" }, [
        h("strong", {}, ["Accepted standards"]),
        h("span", { class: "element-desc" }, [rs ? rs.bodyName + " " + rs.disciplineName + ": " + ((rule && rule.requirement) || "not addressed").replace("_", " ") + (rule && rule.condition ? " -- " + rule.condition : "") : ""]),
      ]),
      cat.standards.length ? [
        h("div", { class: "techsheet-gear-actions" }, [
          small(all ? "Show the accepted ones only" : "Show all " + list.length + " standards", () => { st.expanded[it.id] = !all; onChange(true); }),
          rs ? small("Tick the ruleset's (" + inRules.size + ")", () => { setStandards(it, cat, [...inRules.keys()], !!(rule && rule.materialOnly)); onChange(true); }) : null,
          small("Clear all", () => { setStandards(it, cat, [], false); onChange(true); }),
        ]),
        cat.noCertLabel ? h("label", { class: "techsheet-standard techsheet-nocert" + (it.noCert ? " on" : "") }, [
          h("input", { type: "checkbox", checked: !!it.noCert, onchange: (e) => { setStandards(it, cat, ids, e.target.checked); onChange(true); } }),
          " Also accept: " + cat.noCertLabel,
          rule && rule.materialOnly ? h("span", { class: "badge info", title: "Accepted by " + rs.bodyName + " " + rs.disciplineName + (rule.materialNote ? ": " + rule.materialNote : "") }, ["in rules"]) : null,
        ]) : null,
        shown.length ? h("div", { class: "techsheet-standards" }, shown.map((x) => {
          const r = inRules.get(x.id);
          return h("label", { class: "techsheet-standard" + (ids.includes(x.id) ? " on" : "") }, [
            h("input", { type: "checkbox", checked: ids.includes(x.id), onchange: (e) => {
              const next = e.target.checked ? ids.concat(x.id) : ids.filter((y) => y !== x.id);
              setStandards(it, cat, list.map((y) => y.id).filter((y) => next.includes(y))); onChange(true);
            } }),
            " " + x.label,
            r ? h("span", { class: "badge info", title: "Accepted by " + rs.bodyName + " " + rs.disciplineName + (r.note ? ": " + r.note : "") }, ["in rules" + (r.expiresOn ? " to " + r.expiresOn : "") + (r.yearsFromLabel ? " · " + r.yearsFromLabel + " yrs from label" : "")]) : null,
          ]);
        })) : h("p", { class: "element-desc" }, ["None ticked yet -- Show all to pick them."]),
      ] : h("p", { class: "element-desc" }, ["No certification standards for this category: the scrutineer checks it's there and in good order."]),
    ]);
  }
  function gearPicker(def, st, ctx, uid, allItemIds, onChange) {
    if (!ctx) {
      loadCatalog().then(() => onChange(true), () => {});
      return h("div", { class: "techsheet-gear" }, [h("p", { class: "element-desc" }, ["Loading PassTech's gear categories…"])]);
    }
    const rs = ctx.rs;
    const items = def.sections.flatMap((s) => s.items || []);
    const itemFor = (catId) => items.find((it) => it.gear === catId);
    // Adds the category as a line, in its group's section (made if needed).
    const add = (cat) => {
      const title = cat.groupLabel;
      let sec = def.sections.find((s) => s.gearGroup === cat.group) || def.sections.find((s) => s.title === title);
      if (!sec) { sec = { id: uid(cat.group, def.sections.map((x) => x.id)), title, gearGroup: cat.group, items: [] }; def.sections.push(sec); }
      const rule = ruleFor(rs, st.cls, cat.id);
      const it = { id: uid(cat.id, allItemIds()), label: cat.label, checkedBy: "scrutineer", gear: cat.id };
      if (cat.perOccupant) it.perOccupant = true;
      if (rule && rule.requirement !== "required") it.allowNA = true;
      setStandards(it, cat, ((rule && rule.accepted) || []).map((a) => a.id), !!(rule && rule.materialOnly));
      const sug = st.suggestRule && st.suggestRule(it);
      if (sug) it.rule = sug.rule;
      sec.items.push(it);
      if (rs && !(def.passtechRulesetIds || []).includes(rs.id)) def.passtechRulesetIds = (def.passtechRulesetIds || []).concat(rs.id);
      return it;
    };
    // Open the line's section and bring the line into view.
    const show = (it) => {
      st.open = def.sections.findIndex((s) => (s.items || []).includes(it));
      st.gear = it.gear;
      onChange(true);
      setTimeout(() => { const el = document.getElementById("techsheet-item-" + it.id); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); }, 50);
    };
    const tile = (cat) => {
      const it = itemFor(cat.id);
      const rule = ruleFor(rs, st.cls, cat.id);
      return h("button", { type: "button", class: "techsheet-gear-tile" + (it ? " in" : "") + (st.gear === cat.id ? " active" : ""),
        title: cat.label + (it ? " -- on the sheet: click to edit its line" : " -- click to add it to the sheet") + (rule && rule.condition ? "\n" + rule.condition : ""),
        onclick: () => show(it || add(cat)) }, [
        cat.icon ? h("img", { src: "/tech-sheets/" + cat.icon, alt: "" }) : null,
        h("span", {}, [cat.label]),
        it ? h("span", { class: "techsheet-gear-check", "aria-label": "on the sheet" }, ["✓"]) : null,
      ]);
    };
    // Rows like PassTech's Equipment summary: by requirement with a ruleset, else by group.
    const rows = rs
      ? REQ_ROWS.map(([req, label]) => [label, req, catalog.categories.filter((c) => ((ruleFor(rs, st.cls, c.id) || {}).requirement || "not_addressed") === req)])
      : [...new Set(catalog.categories.map((c) => c.group))].map((g) => [catalog.categories.find((c) => c.group === g).groupLabel, g, catalog.categories.filter((c) => c.group === g)]);
    return h("div", { class: "techsheet-gear" }, [
      h("div", { class: "techsheet-field" }, [h("span", {}, ["Gear checked -- click a category to add it to the sheet (with the standards the rules accept), or to edit its line"])]),
      h("div", { class: "techsheet-editor-row" }, [
        h("label", { class: "techsheet-field" }, [h("span", {}, ["Pre-fill from PassTech's rules for"]),
          h("select", { onchange: (e) => { st.ruleset = e.target.value; st.cls = ""; onChange(true); } }, [
            h("option", { value: "", selected: !st.ruleset }, ["No ruleset (pick standards by hand)"]),
            ctx.bodyRulesets.length ? h("optgroup", { label: "This body" }, ctx.bodyRulesets.map((r) => h("option", { value: r.id, selected: r.id === st.ruleset }, [r.bodyName + " -- " + r.disciplineName]))) : null,
            h("optgroup", { label: "Other bodies" }, ctx.others.map((r) => h("option", { value: r.id, selected: r.id === st.ruleset }, [r.bodyName + " -- " + r.disciplineName]))),
          ])]),
        rs && (rs.classes || []).length ? h("label", { class: "techsheet-field" }, [h("span", {}, ["Class"]),
          h("select", { onchange: (e) => { st.cls = e.target.value; onChange(true); } }, [h("option", { value: "" }, ["All classes"]),
            rs.classes.map((c) => h("option", { value: c.id, selected: c.id === st.cls }, [c.label]))])]) : null,
      ]),
      rows.filter((r) => r[2].length).map(([label, key, cats]) => h("div", { class: "techsheet-gear-row" }, [
        h("div", { class: "techsheet-gear-row-label " + key }, [label]),
        h("div", { class: "techsheet-gear-tiles" }, cats.map(tile)),
      ])),
    ]);
  }

  // ---- Compare with the body's automatic sheet (from its ruleset) ---------
  // The automatic sheet's lines this sheet doesn't have (no line with the same
  // id, the same PassTech gear, or the same name), by section -- each can be
  // added, into the section of the same name (made if needed).
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  function missingFrom(def, ref) {
    const items = def.sections.flatMap((s) => s.items || []);
    const ids = new Set(items.map((i) => i.id));
    const names = new Set(items.map((i) => norm(i.label)));
    // Gear matches one for one: a sheet with one tow hook line still lacks the second (front and rear).
    const gearLeft = {};
    items.forEach((i) => { if (i.gear && !(ref.sections || []).some((s) => (s.items || []).some((r) => r.id === i.id || norm(r.label) === norm(i.label)))) gearLeft[i.gear] = (gearLeft[i.gear] || 0) + 1; });
    const has = (i) => {
      if (ids.has(i.id) || names.has(norm(i.label))) return true;
      if (i.gear && gearLeft[i.gear] > 0) { gearLeft[i.gear]--; return true; }
      return false;
    };
    return (ref.sections || []).map((section) => ({ section, items: (section.items || []).filter((i) => !has(i)) })).filter((x) => x.items.length);
  }
  function addFromReference(def, refSection, item, uid, allItemIds) {
    let sec = def.sections.find((s) => norm(s.title) === norm(refSection.title));
    if (!sec) { sec = { id: uid(refSection.id || refSection.title, def.sections.map((x) => x.id)), title: refSection.title, items: [] }; def.sections.push(sec); }
    const copy = JSON.parse(JSON.stringify(item));
    copy.id = uid(item.id, allItemIds());
    // Its car classes: kept where this sheet has the same ones, else it applies to every car.
    const mine = new Set((def.variants || []).map((v) => v.id));
    if (copy.variants) { copy.variants = copy.variants.filter((v) => mine.has(v)); if (!copy.variants.length) delete copy.variants; }
    sec.items = sec.items || [];
    sec.items.push(copy);
  }
  function comparePanel(def, st, references, small, uid, allItemIds, onChange) {
    if (!references || !references.length) return null;
    const ref = references.find((r) => r.id === st.compareWith) || references[0];
    const missing = missingFrom(def, ref.definition);
    const total = missing.reduce((n, x) => n + x.items.length, 0);
    const open = !!st.compareOpen;
    return h("div", { class: "techsheet-compare" }, [
      h("button", { type: "button", class: "techsheet-compare-head", "aria-expanded": String(open), onclick: () => { st.compareOpen = !open; onChange(true); } }, [
        (open ? "▾ " : "▸ ") + "Compare with " + ref.title + (ref.builtIn ? " (automatic, from ruleset)" : "") + ": ",
        h("span", { class: "techsheet-chip " + (total ? "warn" : "pass") }, [total ? total + " line" + (total === 1 ? "" : "s") + " not on this sheet" : "nothing missing"]),
      ]),
      open ? [
        references.length > 1 ? h("label", { class: "techsheet-field" }, [h("span", {}, ["Compare with"]),
          h("select", { onchange: (e) => { st.compareWith = e.target.value; onChange(true); } }, references.map((r) => h("option", { value: r.id, selected: r.id === ref.id }, [r.title + (r.builtIn ? " (automatic, from ruleset)" : "")])))]) : null,
        total ? null : h("p", { class: "element-desc" }, ["Every line of " + ref.title + " is on this sheet (or one for the same gear or with the same name is)."]),
        missing.map(({ section, items }) => h("div", { class: "techsheet-compare-section" }, [
          h("div", { class: "techsheet-compare-title" }, [section.title,
            items.length > 1 ? small("Add all " + items.length, () => { items.forEach((i) => addFromReference(def, section, i, uid, allItemIds)); onChange(true); }) : null]),
          items.map((i) => h("div", { class: "techsheet-compare-item" }, [
            h("div", { class: "techsheet-compare-text" }, [
              h("strong", {}, [i.label]),
              i.gear ? h("span", { class: "badge info" }, ["gear: " + i.gear.replace(/_/g, " ")]) : null,
              i.perOccupant ? h("span", { class: "badge info" }, ["driver & co-driver"]) : null,
              i.accepts ? h("div", { class: "element-desc" }, [i.accepts]) : null,
              i.rule ? h("div", { class: "element-ref" }, [i.rule]) : null,
            ]),
            small("Add", () => { addFromReference(def, section, i, uid, allItemIds); onChange(true); }),
          ])),
        ])),
      ] : null,
    ]);
  }

  // ---- Rule # suggestions -----------------------------------------------------
  // For a line with no rule: the same line on the sheets compared with (same id
  // or name, else the same gear), else the PassTech ruleset's citation for its
  // gear -- written the way this sheet writes its rules ("NEHA 1.3.9.1", "ARA RTR 1.1.1").
  function rulePrefix(def, refs) {
    const counts = {};
    const add = (r) => { const m = String(r || "").match(/^([A-Za-z][A-Za-z .&/-]*?)\s*\d/); if (m) counts[m[1].trim()] = (counts[m[1].trim()] || 0) + 1; };
    def.sections.forEach((s) => (s.items || []).forEach((i) => add(i.rule)));
    if (!Object.keys(counts).length) (refs || []).forEach((r) => (r.definition.sections || []).forEach((s) => (s.items || []).forEach((i) => add(i.rule))));
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : String(def.bodyId || "").toUpperCase();
  }
  function suggestRule(def, it, ctx, refs) {
    if (it.rule) return null;
    const refItems = (refs || []).flatMap((r) => (r.definition.sections || []).flatMap((s) => s.items || [])).filter((i) => i.rule);
    const same = refItems.find((i) => i.id === it.id || norm(i.label) === norm(it.label)) || (it.gear && refItems.find((i) => i.gear === it.gear));
    if (same) return { rule: same.rule, from: "the automatic tech sheet" };
    const r = it.gear && ctx && ctx.rs ? ruleFor(ctx.rs, ctx.cls, it.gear) : null;
    if (r && r.section) {
      const section = r.section.replace(/\s*\(.*?\)\s*/g, " ").trim();
      const prefix = rulePrefix(def, refs);
      // A section that names its own rulebook ("NRR 11.1.6") gets the body only ("CARS NRR 11.1.6").
      const rule = /^[A-Za-z]/.test(section) ? prefix.split(" ")[0] + " " + section : prefix + " " + section;
      return { rule, from: ctx.rs.bodyName + " " + ctx.rs.disciplineName + " (PassTech)" };
    }
    return null;
  }

  // The version of the sheet for a competitor's class: the variant listing
  // that class (case-insensitive), else the first.
  function variantForClass(template, cls) {
    const vs = template.variants || [];
    if (!vs.length) return null;
    const c = String(cls || "").trim().toLowerCase();
    const hit = c && vs.find((v) => (v.classes || []).some((x) => String(x).trim().toLowerCase() === c));
    return (hit || vs[0]).id;
  }

  // ---- Template editor ------------------------------------------------------
  // definition: the template (FORMAT.md), edited in place. onChange(rerender).
  // Sections are collapsed until opened for editing (one at a time); Preview
  // shows the sheet as the scrutineers will see it.
  const editorState = new WeakMap();
  // opts.references: sheets to compare with ([{ id, title, builtIn, definition }], the body's automatic one first).
  function editor(def, onChange, opts) {
    opts = opts || {};
    def.sections = def.sections || [];
    const st = editorState.get(def) || { open: null, preview: false, variant: null };
    editorState.set(def, st);
    const text = (value, set, attrs) => h("input", Object.assign({ type: "text", value: value || "", oninput: (e) => set(e.target.value) }, attrs || {}));
    const move = (list, i, d) => { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; onChange(true); };
    const small = (label, fn, title) => h("button", { type: "button", class: "btn small secondary", title, onclick: (e) => { e.stopPropagation(); fn(); } }, [label]);
    const uid = (base, taken) => { let id = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "item"; const t = new Set(taken); let n = 2, out = id; while (t.has(out)) out = id + "_" + n++; return out; };
    const allItemIds = () => def.sections.flatMap((s) => (s.items || []).map((i) => i.id));
    const variants = def.variants || [];
    const ctx = gearContext(def, st);
    st.suggestRule = (it) => suggestRule(def, it, ctx, opts.references);
    const missingRules = def.sections.flatMap((s) => (s.items || []).map((it) => [it, st.suggestRule(it)])).filter(([, x]) => x);
    const previewButton = h("div", { class: "techsheet-editor-row" }, [
      h("button", { type: "button", class: "btn small" + (st.preview ? "" : " secondary"), onclick: () => { st.preview = !st.preview; onChange(true); } }, [st.preview ? "Back to editing" : "Preview the sheet"]),
    ]);

    if (st.preview) {
      const v = variants.some((x) => x.id === st.variant) ? st.variant : variants.length ? variants[0].id : null;
      return h("div", { class: "techsheet-editor" }, [
        previewButton,
        h("div", { class: "techsheet-preview" }, [
          h("div", { class: "techsheet-preview-title" }, [def.title || "Untitled sheet", def.revision ? " · rev. " + def.revision : ""]),
          variants.length > 1 ? h("div", { class: "techsheet-variants" }, ["Car class: ", variants.map((x) => h("label", {}, [
            h("input", { type: "radio", name: "techsheet-preview-variant", checked: x.id === v, onchange: () => { st.variant = x.id; onChange(true); } }), " " + x.label + " ",
          ]))]) : null,
          sheet({ template: Object.assign({}, def, { variants: [] }), variant: v, header: {}, inspection: { items: {} }, editable: false, onChange: () => {} }),
        ]),
        h("div", { class: "techsheet-editor-row" }, [h("button", { type: "button", class: "btn small", onclick: () => { st.preview = false; onChange(true); } }, ["Back to editing"])]),
      ]);
    }

    // Car classes: versions of the sheet (e.g. NEHA Standard / X car), each for
    // some of the event's classes; a line can apply to some of them only.
    const variantEditor = h("div", { class: "techsheet-variants-editor" }, [
      h("div", { class: "techsheet-field" }, [h("span", {}, ["Car classes (a version of the sheet for each) -- leave empty when every car gets the same sheet"])]),
      variants.map((v, vi) => h("div", { class: "techsheet-editor-row" }, [
        text(v.label, (x) => { v.label = x; }, { placeholder: "e.g. X car", class: "techsheet-item-input" }),
        text((v.classes || []).join(", "), (x) => { v.classes = x.split(",").map((c) => c.trim()).filter(Boolean); },
          { placeholder: "Event class codes, comma-separated (e.g. X, XS)", class: "techsheet-accepts-input", title: "Competitors in these event classes get this version of the sheet; the others get the first one." }),
        h("label", { title: "Driver & co-driver lines get a line for each in this class (e.g. hillclimb R1/R2); otherwise one line, the driver's." }, [
          h("input", { type: "checkbox", checked: !!v.codriver, onchange: (e) => { if (e.target.checked) v.codriver = true; else delete v.codriver; } }), " Has a co-driver"]),
        small("Delete", () => {
          if (!confirm("Delete the car class \"" + v.label + "\"? Lines only for it then apply to every car.")) return;
          variants.splice(vi, 1);
          def.sections.forEach((s) => (s.items || []).forEach((it) => { if (it.variants) { it.variants = it.variants.filter((x) => x !== v.id); if (!it.variants.length) delete it.variants; } }));
          if (!variants.length) delete def.variants;
          onChange(true);
        }),
      ])),
      h("div", { class: "techsheet-editor-row" }, [small("Add a car class", () => {
        def.variants = def.variants || [];
        if (!def.variants.length) def.variants.push({ id: "standard", label: "Standard", codriver: true });
        def.variants.push({ id: uid("type", def.variants.map((x) => x.id)), label: "New car class" });
        onChange(true);
      })]),
    ]);

    return h("div", { class: "techsheet-editor" }, [
      previewButton,
      h("div", { class: "field-row" }, [
        h("label", { class: "techsheet-field" }, [h("span", {}, ["Title"]), text(def.title, (v) => { def.title = v; })]),
        h("label", { class: "techsheet-field" }, [h("span", {}, ["Form revision"]), text(def.revision, (v) => { def.revision = v; })]),
      ]),
      h("label", { class: "techsheet-field" }, [h("span", {}, ["Instructions (shown at the top)"]), text(def.instructions, (v) => { def.instructions = v; })]),
      variantEditor,
      missingRules.length ? h("div", { class: "techsheet-editor-row techsheet-rule-fill" }, [
        h("span", { class: "element-desc" }, [missingRules.length + " line" + (missingRules.length === 1 ? " has" : "s have") + " no rule # but one can be suggested."]),
        small("Fill " + missingRules.length + " rule #", () => { missingRules.forEach(([it, x]) => { it.rule = x.rule; }); onChange(true); }),
      ]) : null,
      gearPicker(def, st, ctx, uid, allItemIds, onChange),
      comparePanel(def, st, opts.references, small, uid, allItemIds, onChange),
      def.sections.map((s, si) => {
        const open = st.open === si;
        s.items = s.items || [];
        const toggle = () => { st.open = open ? null : si; onChange(true); };
        return h("div", { class: "techsheet-section techsheet-editor-section" + (open ? " editing" : "") }, [
          h("div", { class: "techsheet-editor-row techsheet-editor-head", onclick: (e) => { if (e.target.tagName !== "INPUT") toggle(); } }, [
            h("button", { type: "button", class: "techsheet-caret", "aria-expanded": String(open), title: open ? "Collapse" : "Edit this section", onclick: (e) => { e.stopPropagation(); toggle(); } }, [open ? "▾" : "▸"]),
            open ? text(s.title, (v) => { s.title = v; }, { class: "techsheet-section-input" })
              : h("span", { class: "techsheet-section-name" }, [s.title || "Untitled section", h("span", { class: "element-desc" }, [" · " + s.items.length + " item" + (s.items.length === 1 ? "" : "s")])]),
            small("↑", () => { if (open && si > 0) st.open = si - 1; move(def.sections, si, -1); }, "Move up"),
            small("↓", () => { if (open && si < def.sections.length - 1) st.open = si + 1; move(def.sections, si, 1); }, "Move down"),
            open ? small("Delete section", () => { if (confirm("Delete the section \"" + s.title + "\" and its " + s.items.length + " items?")) { def.sections.splice(si, 1); st.open = null; onChange(true); } }) : null,
          ]),
          open ? [
            s.items.map((it, ii) => h("div", { class: "techsheet-editor-item" + (it.gear && it.gear === st.gear ? " active" : ""), id: "techsheet-item-" + it.id }, [
              h("div", { class: "techsheet-editor-row" }, [
                text(it.label, (v) => { it.label = v; }, { placeholder: "Item", class: "techsheet-item-input" }),
                h("select", { onchange: (e) => { it.checkedBy = e.target.value; } }, [["scrutineer", "Scrutineer checks"], ["team", "Competitor checks"]].map(([v, l]) => h("option", { value: v, selected: (it.checkedBy || "scrutineer") === v }, [l]))),
                h("label", { title: variants.length ? "A line for the driver and one for the co-driver, in the car classes with a co-driver" : "A line for the driver and one for the co-driver" }, [h("input", { type: "checkbox", checked: !!it.perOccupant, onchange: (e) => { it.perOccupant = e.target.checked; } }), variants.length ? " Driver & co-driver (classes with one)" : " Driver & co-driver"]),
                h("label", {}, [h("input", { type: "checkbox", checked: !!it.allowNA, onchange: (e) => { it.allowNA = e.target.checked; } }), " N/A allowed"]),
                small("↑", () => move(s.items, ii, -1), "Move up"), small("↓", () => move(s.items, ii, 1), "Move down"),
                small("Delete", () => { s.items.splice(ii, 1); onChange(true); }),
              ]),
              h("div", { class: "techsheet-editor-row" }, [
                h("textarea", { rows: 2, placeholder: it.gear ? "Anything else accepted or required (optional -- the standards are listed below)" : "What is accepted", class: "techsheet-accepts-input", oninput: (e) => { it.accepts = e.target.value; } }, [it.accepts || ""]),
                text(it.rule, (v) => { it.rule = v; }, { placeholder: "Rule (section)", class: "techsheet-rule-input" }),
                (() => { const x = st.suggestRule(it); return x ? h("span", { class: "techsheet-rule-suggest", title: "From " + x.from }, ["Suggested: " + x.rule + " ",
                  h("button", { type: "button", class: "btn small secondary", onclick: () => { it.rule = x.rule; onChange(true); } }, ["Use"])]) : null; })(),
                // A gear line's category is fixed (it was added from the gear picker).
                it.gear ? gearChip(it.gear) : null,
              ]),
              it.gear && ctx ? standardsBox(it, ctx, st, small, onChange) : null,
              // Which car types the line is on (all, unless some are unticked).
              variants.length ? h("div", { class: "techsheet-editor-row techsheet-applies" }, ["Applies to: ", variants.map((v) => h("label", {}, [
                h("input", { type: "checkbox", checked: !it.variants || it.variants.includes(v.id), onchange: (e) => {
                  const on = new Set(it.variants || variants.map((x) => x.id));
                  if (e.target.checked) on.add(v.id); else on.delete(v.id);
                  if (!on.size) { e.target.checked = true; return alert("A line has to apply to at least one car class -- delete it instead."); }
                  if (on.size === variants.length) delete it.variants; else it.variants = variants.map((x) => x.id).filter((x) => on.has(x));
                } }), " " + v.label,
              ]))]) : null,
            ])),
            h("div", { class: "techsheet-editor-row" }, [small("Add an item", () => { s.items.push({ id: uid("item", allItemIds()), label: "New item", checkedBy: "scrutineer" }); onChange(true); })]),
          ] : null,
        ]);
      }),
      h("div", { class: "techsheet-editor-row" }, [small("Add a section", () => { def.sections.push({ id: uid("section", def.sections.map((x) => x.id)), title: "New section", items: [] }); st.open = def.sections.length - 1; onChange(true); })]),
    ]);
  }

  // A gear line's PassTech category: its icon and name.
  function gearChip(id) {
    const cat = catalog && catalog.categories.find((c) => c.id === id);
    return h("span", { class: "techsheet-gear-chip", title: "PassTech gear category -- competitors' gear is pre-filled and checked against it" }, [
      cat && cat.icon ? h("img", { src: "/tech-sheets/" + cat.icon, alt: "" }) : null, "PassTech: " + (cat ? cat.label : id.replace(/_/g, " ")),
    ]);
  }
  // Whether the editor for this definition is showing its preview.
  const isPreview = (def) => !!(editorState.get(def) || {}).preview;

  window.TechSheet = { lines, counts, sheet, editor, variantForClass, loadCatalog, isPreview, hasCodriver, loadEngine };
})();
