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
  // Open on the account panel (account.js), not the library: the logbook
  // editor shows once a logbook is opened or prepared.
  startHidden: true,
  // A logbook being prepared has no event log: events come once it's issued.
  eventsOnlyWhenIssued: true,
};

// The central logbook repository (Supabase -- see supabase/README.md). The
// anon key is public by design: the database's access rules protect the
// data. Never put the service_role key here.
window.LOGBOOK_SERVER = {
  url: "https://opltqtjxrzlgucrgznft.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbHRxdGp4cnpsZ3Vjcmd6bmZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExNjk0NTAsImV4cCI6MjEwNjc0NTQ1MH0.zp9-mI7BUpjIltkZLa707tayiQ-9SvdOomYONU36wPI",
};
