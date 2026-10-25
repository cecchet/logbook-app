// Tech stickers (supabase/migrations/20261022000000_stickers.sql): printable
// QR codes a scrutineer issues for a logbook, a piece of gear (helmet, HANS,
// seat) or a car that passed tech. The QR code holds <site>/?s=<code>.
//   Stickers.svg(sticker)            -> the sticker as an SVG element (QR, what it's for, its code)
//   Stickers.printDialog(stickers)   -> where to print them: a label printer, a sheet, or images
//   Stickers.view(data, opts)        -> what a scanned sticker shows (sticker_view())
//   Stickers.codeFromUrl()           -> the ?s= code of this page, if any
// Plain DOM, like techsheet.js; account.js makes the server calls.
(function () {
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
  const SVG_NS = "http://www.w3.org/2000/svg";
  function s(tag, attrs, children) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => { if (v != null) node.setAttribute(k, v); });
    (children || []).forEach((c) => node.append(c.nodeType ? c : String(c)));
    return node;
  }

  // The QR code library (the same one as photo-capture.js), loaded when first needed.
  const QR_LIB = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
  let qrLoading = null;
  function loadQr() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (!qrLoading) {
      qrLoading = new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = QR_LIB;
        el.crossOrigin = "anonymous";
        el.onload = () => resolve(window.qrcode);
        el.onerror = () => { qrLoading = null; reject(new Error("couldn't load the QR code generator")); };
        document.head.appendChild(el);
      });
    }
    return qrLoading;
  }

  const GEAR_LABEL = { helmet: "Helmet", hnr: "HANS / head & neck restraint", seat: "Seat", fire_extinguisher: "Fire extinguisher", fire_suppression: "Fire suppression system" };
  const GEAR_SHORT = { helmet: "HELMET", hnr: "HANS", seat: "SEAT", fire_extinguisher: "EXTINGUISHER", fire_suppression: "SUPPRESSION" };
  // The gear categories a sticker can go on (the server's sticker_gear()).
  const GEAR = Object.keys(GEAR_LABEL);
  const fmtCode = (c) => c.slice(0, 4) + "-" + c.slice(4);
  const day = (iso) => (iso ? String(iso).slice(0, 10) : "");
  const fmtDate = (d) => (d ? new Date(String(d).length === 10 ? d + "T12:00:00" : d).toLocaleDateString() : "");
  function scanUrl(code) { return location.origin + "/?s=" + code; }
  function codeFromUrl() {
    const p = new URLSearchParams(location.search);
    const code = (p.get("s") || p.get("S") || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
    return code.length === 8 ? code : null;
  }
  // What the sticker says it's for, in capitals: "HELMET · DRIVER", "TECH PASSED · #23", "LOGBOOK · FL-…".
  function title(st) {
    const snap = st.snapshot || {};
    if (st.kind === "gear") return (GEAR_SHORT[snap.category] || "GEAR") + (snap.occupant === "codriver" ? " · CO-DRIVER" : snap.occupant === "driver" ? " · DRIVER" : "");
    if (st.kind === "car") return "TECH PASSED · #" + (snap.carNumber || "");
    return "LOGBOOK · " + (snap.digitalNumber || "");
  }
  // The body and when it's good for: a gear sticker's season ("ARA · 2026"), else the day it was issued.
  function footer(st) {
    return [(st.body || "").toUpperCase(), st.kind === "gear" && st.season ? String(st.season) : day(st.issuedAt)].filter(Boolean).join(" · ");
  }

  // The sticker, 100 x 100 units: the QR code, then what it's for, its code, the body and date.
  async function svg(st) {
    const qrcode = await loadQr();
    const qr = qrcode(0, "M");
    qr.addData(scanUrl(st.code));
    qr.make();
    const n = qr.getModuleCount();
    const size = 70, x0 = 15, y0 = 3, m = size / n;
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += "M" + (x0 + c * m).toFixed(3) + " " + (y0 + r * m).toFixed(3) + "h" + m.toFixed(3) + "v" + m.toFixed(3) + "h-" + m.toFixed(3) + "z";
    const t = title(st);
    return s("svg", { xmlns: SVG_NS, viewBox: "0 0 100 100", width: "100", height: "100", "font-family": "Arial, Helvetica, sans-serif" }, [
      s("rect", { x: "0", y: "0", width: "100", height: "100", fill: "#fff" }),
      s("path", { d, fill: "#000", "shape-rendering": "crispEdges" }),
      s("text", { x: "50", y: "82", "text-anchor": "middle", "font-size": t.length > 20 ? "6.2" : "7.5", "font-weight": "bold", fill: "#000" }, [t]),
      s("text", { x: "50", y: "90.5", "text-anchor": "middle", "font-size": "7.5", "font-family": "Consolas, 'Courier New', monospace", "font-weight": "bold", "letter-spacing": "0.6", fill: "#000" }, [fmtCode(st.code)]),
      s("text", { x: "50", y: "97.5", "text-anchor": "middle", "font-size": "5.5", fill: "#000" }, [footer(st)]),
    ]);
  }

  // ---- Printing ------------------------------------------------------------
  // A label printer prints one sticker per label at the label's size; a
  // sheet puts them on a Letter page to cut out; images go to a phone's
  // label app (Brother iPrint&Label / Design&Print, Bluetooth printers...).
  const FORMATS = [
    { id: "label-62", label: "Label printer, 62 mm roll (e.g. Brother QL)", page: "62mm 62mm", size: "56mm" },
    { id: "label-2in", label: "Label printer, 2 in square labels", page: "2in 2in", size: "1.85in" },
    { id: "label-1in", label: "Label printer, 1 in square labels (small, for a helmet)", page: "1in 1in", size: "0.94in" },
    { id: "sheet", label: "Letter sheet of 1.5 in stickers to cut out", page: "letter", size: "1.5in", sheet: true },
    { id: "images", label: "Images (PNG): save to disk, or share to a label app", images: true },
  ];
  const FORMAT_KEY = "sticker-format";
  const savedFormat = () => { try { return localStorage.getItem(FORMAT_KEY) || "label-62"; } catch (e) { return "label-62"; } };

  async function print(stickers, fmt) {
    const svgs = await Promise.all(stickers.map(svg));
    const w = window.open("", "_blank");
    if (!w) throw new Error("the browser blocked the print window -- allow pop-ups for this site");
    const body = svgs.map((el) => '<div class="st">' + el.outerHTML.replace(/width="100" height="100"/, "") + "</div>").join("");
    w.document.write("<!doctype html><html><head><meta charset=\"utf-8\"><title>Tech stickers</title><style>" +
      "@page { size: " + fmt.page + "; margin: " + (fmt.sheet ? "0.5in" : "0") + "; }" +
      "html, body { margin: 0; padding: 0; background: #fff; }" +
      (fmt.sheet
        ? ".sheet { display: flex; flex-wrap: wrap; gap: 0.25in; } .st { width: " + fmt.size + "; height: " + fmt.size + "; outline: 1px dashed #bbb; break-inside: avoid; }"
        : ".st { width: " + fmt.size + "; height: " + fmt.size + "; margin: auto; padding-top: calc((" + fmt.page.split(" ")[1] + " - " + fmt.size + ") / 2); break-after: page; } .st:last-child { break-after: auto; }") +
      ".st svg { width: 100%; height: 100%; display: block; }" +
      "</style></head><body>" + (fmt.sheet ? '<div class="sheet">' + body + "</div>" : body) +
      "<script>setTimeout(function () { window.print(); }, 300);<\/script></body></html>");
    w.document.close();
  }

  // Whether this browser shares files (a phone's share sheet, Windows' Share): "Share" is offered then.
  const canShareFiles = () => {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File([""], "sticker.png", { type: "image/png" })] })); } catch (e) { return false; }
  };
  // Each sticker as a PNG (about 1000 px): saved to disk ("save"), or shared ("share") to a label app.
  async function images(stickers, how) {
    const files = [];
    for (const st of stickers) {
      const el = await svg(st);
      el.setAttribute("width", "1000"); el.setAttribute("height", "1000");
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error("couldn't draw the sticker")); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(el.outerHTML); });
      const c = document.createElement("canvas");
      c.width = 1000; c.height = 1000;
      c.getContext("2d").drawImage(img, 0, 0, 1000, 1000);
      const blob = await new Promise((resolve) => c.toBlob(resolve, "image/png"));
      files.push(new File([blob], "sticker-" + st.code + ".png", { type: "image/png" }));
    }
    if (how === "share") {
      try { await navigator.share({ files, title: "Tech stickers" }); } catch (e) { if (!e || e.name !== "AbortError") throw new Error("Couldn't share: " + ((e && e.message) || e) + " -- use Save instead."); }
      return;
    }
    files.forEach((f) => {
      const a = h("a", { href: URL.createObjectURL(f), download: f.name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    });
  }

  // The print dialog: a preview of each sticker and where they go.
  function printDialog(stickers) {
    if (!stickers.length) return;
    let format = savedFormat();
    const preview = h("div", { class: "sticker-preview" });
    stickers.forEach((st) => svg(st).then((el) => preview.append(h("figure", {}, [el, h("figcaption", {}, [title(st)])]))).catch(() => {}));
    const error = h("p", { class: "verdict fail", hidden: true });
    const close = () => overlay.remove();
    // how: "print", or for images "save" / "share".
    const go = async (how) => {
      try { localStorage.setItem(FORMAT_KEY, format); } catch (e) { /* not kept */ }
      const fmt = FORMATS.find((f) => f.id === format);
      try {
        if (fmt.images) await images(stickers, how); else await print(stickers, fmt);
        close();
      } catch (e) { error.hidden = false; error.textContent = e.message || String(e); }
    };
    // The buttons for the format picked: Print, or Save / Share for images.
    const buttons = h("div", { class: "account-actions" });
    const drawButtons = () => {
      const fmt = FORMATS.find((f) => f.id === format) || FORMATS[0];
      const n = stickers.length > 1 ? " " + stickers.length + " images" : " image";
      buttons.replaceChildren(
        ...(fmt.images
          ? [h("button", { type: "button", class: "btn small", onclick: () => go("save") }, ["Save" + n + " to disk"]),
             canShareFiles() ? h("button", { type: "button", class: "btn small secondary", onclick: () => go("share") }, ["Share" + n]) : ""]
          : [h("button", { type: "button", class: "btn small", onclick: () => go("print") }, ["Print"])]),
        h("button", { type: "button", class: "btn small secondary", onclick: close }, ["Cancel"]));
    };
    drawButtons();
    const overlay = h("div", { class: "sticker-dialog-backdrop", onclick: (e) => { if (e.target === overlay) close(); } }, [
      h("div", { class: "sticker-dialog", role: "dialog", "aria-label": "Print stickers" }, [
        h("h3", {}, [stickers.length === 1 ? "Print the sticker" : "Print " + stickers.length + " stickers"]),
        preview,
        h("div", { class: "sticker-formats" }, FORMATS.map((f) => h("label", {}, [
          h("input", { type: "radio", name: "sticker-format", checked: f.id === format, onchange: () => { format = f.id; drawButtons(); } }), " " + f.label,
        ]))),
        h("p", { class: "element-desc" }, ["A label printer prints from the print dialog: on a laptop through its driver, on a phone through AirPrint (iPhone) or its maker's print plugin (Android) -- pick the label size there too. Label makers that only print from their own app: save or share the images, then open them in that app."]),
        error,
        buttons,
      ]),
    ]);
    document.body.append(overlay);
  }

  // ---- A scanned sticker ---------------------------------------------------
  // data: sticker_view(). opts: { photoUrl(sha) -> Promise<url>, standardLabel(category, id) -> text,
  //   lines(template, variant) (TechSheet.lines), onVoid() (a scrutineer voids it), onOpenLogbook() }
  function view(data, opts) {
    const snap = data.snapshot || {};
    const valid = data.status === "valid";
    const out = [];
    out.push(h("div", { class: "sticker-status " + (valid ? "valid" : "void") }, [
      h("strong", {}, [valid ? "VALID" : data.status === "expired" ? "EXPIRED" : "VOID"]), " sticker " + fmtCode(data.code),
      data.kind === "gear" && data.season ? " -- " + (data.bodyName || (data.body || "").toUpperCase()) + " " + data.season + " season" : null,
      data.status === "expired" ? (data.kind === "gear" ? " (over)" : " -- for an event that's over") : null,
      data.status === "void" ? " -- " + (data.voidReason === "replaced" && data.replacedBy ? "replaced by sticker " + fmtCode(data.replacedBy) : data.voidReason || "voided") + (data.voidedAt ? " (" + fmtDate(data.voidedAt) + ")" : "") : null,
    ]));
    const who = [data.inspector && data.inspector.name ? "Inspected by " + data.inspector.name + (data.inspector.license ? " (" + data.inspector.license + ")" : "") : "Issued",
      data.bodyName, "on " + fmtDate(data.issuedAt)].filter(Boolean).join(" · ");
    const where = data.event ? [data.event.name, data.event.location, fmtDate(data.event.startsOn) + (data.event.endsOn && data.event.endsOn !== data.event.startsOn ? " to " + fmtDate(data.event.endsOn) : "")].filter(Boolean).join(" · ") : null;
    const photos = (list) => h("div", { class: "sticker-photos" }, list.map((p) => {
      const img = h("img", { alt: p.kind === "tag" ? "Tag photo" : "Photo" });
      const a = h("a", { target: "_blank", rel: "noopener", class: "sticker-photo" + (p.kind === "tag" ? " tag" : "") }, [img, p.kind === "tag" ? h("span", {}, ["tag"]) : null]);
      if (opts.photoUrl) opts.photoUrl(p.sha256).then((url) => { if (url) { img.src = url; a.href = url; } }).catch(() => {});
      return a;
    }));

    if (data.kind === "gear") {
      const g = snap.gear || {};
      out.push(h("h3", {}, [(GEAR_LABEL[snap.category] || "Gear") + (snap.occupant === "codriver" ? " -- co-driver" : snap.occupant === "driver" ? " -- driver" : "") +
        (snap.carNumber ? ", car #" + snap.carNumber : "")]));
      if (snap.driver) out.push(h("p", { class: "element-desc" }, ["Worn by " + snap.driver]));
      if ((snap.photos || []).length) out.push(photos(snap.photos));
      (g.extinguisherUnits || []).forEach((u, i) => out.push(h("p", { class: "element-desc" }, [(g.extinguisherUnits.length > 1 ? "Extinguisher " + (i + 1) + ": " : "") +
        [u.classARating ? u.classARating + "-A" : "", u.bcRating ? u.bcRating + "-B:C" : "", u.weightLbs ? u.weightLbs + " lb" : "",
          u.manufactureDate ? "made " + u.manufactureDate : "", u.certificationDueDate ? "service due " + u.certificationDueDate : ""].filter(Boolean).join(" · ")])));
      const certs = (g.certifications || []).filter((c) => c.standardId);
      out.push(h("div", { class: "sticker-certs" }, certs.length ? certs.map((c) => h("div", { class: "sticker-cert" }, [
        h("strong", {}, [c.customStandardLabel || (opts.standardLabel ? opts.standardLabel(snap.category, c.standardId) : c.standardId)]),
        h("span", {}, [[c.homologationNumber ? "homologation " + c.homologationNumber : null, c.serialNumber ? "serial " + c.serialNumber : null,
          c.labelDate ? (c.dateType === "recertification" ? "recertified " : "label date ") + c.labelDate : null, c.tagExpirationDate ? "tag expires " + c.tagExpirationDate : null,
          c.nextServiceDate ? "service due " + c.nextServiceDate : null].filter(Boolean).join(" · ")]),
      ])) : (g.extinguisherUnits || []).length ? [] : [h("p", { class: "element-desc" }, ["No certification recorded."])]));
      if (g.helmetType || g.seatMounting) out.push(h("p", { class: "element-desc" }, [[g.helmetType === "full_face" ? "Full face" : g.helmetType === "open_face" ? "Open face" : "", g.seatMounting === "rails" ? "On rails" : g.seatMounting === "fixed" ? "Fixed mount" : ""].filter(Boolean).join(" · ")]));
      out.push(h("p", { class: "element-desc" }, ["Check the photos and the serial number against the item in hand. Whether this certification is accepted depends on the event's rules: PassTech's scrutineer mode checks it when it scans this sticker."]));
    } else if (data.kind === "car") {
      out.push(h("h3", {}, ["Car #" + (snap.carNumber || "") + " passed tech" + (snap.class ? " -- class " + snap.class : "")]));
      out.push(h("p", { class: "element-desc" }, [[[snap.year, snap.make, snap.model].filter(Boolean).join(" "), snap.driver ? [snap.driver, snap.codriver].filter(Boolean).join(" / ") : null].filter(Boolean).join(" · ")]));
      if ((snap.photos || []).length) out.push(photos(snap.photos));
      const sh = data.sheet || {};
      const sigs = sh.signatures || {};
      if (sigs.chief) out.push(h("p", { class: "element-desc" }, ["Signed off by chief scrutineer " + sigs.chief.name + (sigs.chief.license ? " (" + sigs.chief.license + ")" : "")]));
      if (sh.template && opts.lines) {
        const res = sh.results || {};
        out.push(h("div", { class: "sticker-results" }, opts.lines(sh.template, sh.variant).map(({ section, rows }) => h("div", {}, [
          h("div", { class: "sticker-results-title" }, [section.title]),
          h("ul", {}, rows.map((r) => h("li", {}, [h("span", { class: "techsheet-chip " + (res[r.key] === "pass" ? "pass" : res[r.key] === "fail" ? "fail" : res[r.key] === "na" ? "na" : "todo") },
            [res[r.key] === "pass" ? "Pass" : res[r.key] === "fail" ? "Fail" : res[r.key] === "na" ? "N/A" : "—"]), " " + r.label]))),
        ]))));
      }
    } else {
      const lb = data.logbook || {};
      out.push(h("h3", {}, ["Logbook " + (lb.digitalNumber || snap.digitalNumber || "")]));
      out.push(h("p", { class: "element-desc" }, [[[snap.year, snap.make, snap.model].filter(Boolean).join(" "), lb.status && lb.status !== "active" ? "logbook " + lb.status : null].filter(Boolean).join(" · ")]));
      if (!lb.publicToken) out.push(h("p", { class: "element-desc" }, ["Its owner keeps the logbook private: a scrutineer finds it by its number once signed in."]));
      else if (opts.onOpenLogbook) out.push(h("div", { class: "account-actions" }, [h("button", { type: "button", class: "btn small", onclick: opts.onOpenLogbook }, ["Open the logbook"])]));
    }
    out.push(h("p", { class: "element-desc" }, [who]));
    if (where) out.push(h("p", { class: "element-desc" }, ["At " + where]));
    if (valid && opts.onVoid) out.push(h("div", { class: "account-actions" }, [h("button", { type: "button", class: "btn small secondary", onclick: opts.onVoid }, ["Void this sticker"])]));
    return h("div", { class: "sticker-view" }, out);
  }

  // ---- Reading a sticker's QR code -----------------------------------------
  // ZXing (the browser build of the barcode library PassTech uses), loaded when first needed.
  const ZXING_LIB = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";
  let zxingLoading = null;
  function loadZxing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (!zxingLoading) {
      zxingLoading = new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = ZXING_LIB;
        el.crossOrigin = "anonymous";
        el.onload = () => resolve(window.ZXing);
        el.onerror = () => { zxingLoading = null; reject(new Error("couldn't load the QR code reader")); };
        document.head.appendChild(el);
      });
    }
    return zxingLoading;
  }
  // The sticker code in a QR code's text (a ?s= link) or typed by hand ("K7Q3-M9XD"), or null.
  function codeFrom(text) {
    let t = String(text || "").trim();
    try { const u = new URL(t); t = u.searchParams.get("s") || u.searchParams.get("S") || ""; } catch (e) { /* the code itself */ }
    const code = t.toUpperCase().replace(/[^0-9A-Z]/g, "");
    return /^[2-9A-Z]{8}$/.test(code) ? code : null;
  }
  // A sticker code in a photo (a File), or null: e.g. a "tag" photo that's really of a sticker.
  async function codeInPhoto(file) {
    const ZX = await loadZxing();
    const url = URL.createObjectURL(file);
    try { return codeFrom((await new ZX.BrowserQRCodeReader().decodeFromImageUrl(url)).getText()); }
    catch (e) { return null; }
    finally { URL.revokeObjectURL(url); }
  }
  // "Scan a sticker": the camera, a photo of it, or its code typed in -> onCode(code).
  function scanDialog(onCode) {
    let reader = null;
    const stop = () => { try { if (reader) reader.reset(); } catch (e) { /* stopped */ } reader = null; };
    const close = () => { stop(); overlay.remove(); };
    const msg = h("p", { class: "element-desc" }, ["Point the camera at the sticker's QR code."]);
    const video = h("video", { class: "sticker-scan-video", muted: true, playsinline: true });
    const got = (code) => { if (!code) return false; close(); onCode(code); return true; };
    const photo = h("input", { type: "file", accept: "image/*", class: "techsheet-file", onchange: async () => {
      const f = photo.files[0];
      photo.value = "";
      if (!f) return;
      msg.textContent = "Reading the photo…";
      if (!got(await codeInPhoto(f).catch(() => null))) msg.textContent = "No sticker QR code found in that photo -- get closer, or type the code printed under it.";
    } });
    const typed = h("input", { type: "text", placeholder: "or its code, e.g. K7Q3-M9XD", class: "sticker-scan-code" });
    const lookUp = () => { if (!got(codeFrom(typed.value))) msg.textContent = "That isn't a sticker code: 8 letters and digits, e.g. K7Q3-M9XD."; };
    const overlay = h("div", { class: "sticker-dialog-backdrop", onclick: (e) => { if (e.target === overlay) close(); } }, [
      h("div", { class: "sticker-dialog", role: "dialog", "aria-label": "Scan a sticker" }, [
        h("h3", {}, ["Scan a sticker"]),
        video, msg,
        h("div", { class: "account-actions" }, [
          h("label", { class: "btn small secondary" }, ["📷 Photo of the sticker", photo]),
          typed, h("button", { type: "button", class: "btn small secondary", onclick: lookUp }, ["Look up"]),
          h("button", { type: "button", class: "btn small secondary", onclick: close }, ["Cancel"]),
        ]),
      ]),
    ]);
    typed.addEventListener("keydown", (e) => { if (e.key === "Enter") lookUp(); });
    document.body.append(overlay);
    loadZxing().then((ZX) => {
      if (!overlay.isConnected) return;
      reader = new ZX.BrowserQRCodeReader();
      return reader.decodeFromConstraints({ video: { facingMode: "environment" } }, video, (result) => {
        if (result && overlay.isConnected) got(codeFrom(result.getText()));
      });
    }).catch(() => { video.remove(); msg.textContent = "No camera here (or it isn't allowed): use a photo of the sticker, or type its code."; });
  }

  window.Stickers = { svg, printDialog, view, codeFromUrl, title, fmtCode, scanUrl, GEAR_LABEL, GEAR, codeFrom, codeInPhoto, scanDialog };
})();
