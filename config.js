// Digital logbooks (logbook.frogracing.us) -- configuration of the shared
// Frog Racing roll cage app (the core submodule, also rollcage.frogracing.us).
// See CFG at the top of core/app.js for what each setting does.
window.APP_CONFIG = {
  appName: "Digital logbooks",
  noun: "logbook",
  libraryName: "Logbook library",
  // Logbook information first (vehicle, sanctioning body, logbook details,
  // event entries), and the logbook in the PDF report.
  logbook: true,
  // The Frog Safety score as the last part (Part 7) rather than a panel under every part.
  safetyScorePart: true,
  // Rally sanctioning bodies only for now. SCCA ProRally, Rally America and
  // FIA passport are documentation only (no automatic compliance check yet).
  orgs: ["none", "nasa", "ara", "cars", "scca-prorally", "rally-america", "fia-passport"],
  // This app's own files live at the site root (the shared page runs with
  // <base href="core/">, see tools/build-index.js).
  swUrl: "/sw.js",
  apiUrl: "/api/analyze-cage",
  tourSeenKey: "logbook-app-tour-seen",
  pdfTitle: "Digital Logbook",
};
