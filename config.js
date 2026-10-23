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

// Two sites from this one app, by address: logbook.frogracing.us (logbooks:
// create, the library) and scrutineering.frogracing.us (scrutineering, event
// admin); both manage the sanctioning bodies and their scrutineers. Locally,
// ?site=scrutineering (or ?site=logbook) picks one, for this browser tab.
window.APP_SITE = (function () {
  let site = new URLSearchParams(location.search).get("site");
  try {
    if (site) sessionStorage.setItem("app-site", site);
    else site = sessionStorage.getItem("app-site");
  } catch (e) { /* no storage: the address decides */ }
  if (site !== "logbook" && site !== "scrutineering") site = /^scrutineering\./.test(location.hostname) ? "scrutineering" : "logbook";
  return site;
})();
if (window.APP_SITE === "scrutineering") {
  Object.assign(window.APP_CONFIG, { appName: "Scrutineering", tourSeenKey: "scrutineering-app-tour-seen" });
  // The page's own name: its title, header, home-screen name and install manifest.
  document.addEventListener("DOMContentLoaded", () => {
    document.title = "Scrutineering";
    const h1 = document.querySelector("header h1, h1");
    const text = h1 && [...h1.childNodes].find((n) => n.nodeType === 3 && /Digital logbooks/.test(n.textContent));
    if (text) text.textContent = text.textContent.replace("Digital logbooks", "Scrutineering");
    const apple = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (apple) apple.setAttribute("content", "Scrutineering");
    const manifest = document.querySelector('link[rel="manifest"]');
    if (manifest) manifest.setAttribute("href", "/manifest-scrutineering.webmanifest?v=1");
    // Its logo: PassTech's "Check my gear" frog (icons/scrutineering-*).
    const logo = h1 && h1.querySelector("img.app-logo");
    if (logo) logo.setAttribute("src", "/icons/scrutineering-icon-192.png?v=1");
    document.querySelectorAll('link[rel="icon"]').forEach((l) =>
      l.setAttribute("href", l.getAttribute("sizes") === "32x32" ? "/icons/scrutineering-favicon-32.png?v=1" : "/icons/scrutineering-icon-192.png?v=1"));
    const touch = document.querySelector('link[rel="apple-touch-icon"]');
    if (touch) touch.setAttribute("href", "/icons/scrutineering-apple-touch-icon.png?v=1");
    // The roll cage app's own header links (its tutorial video, tour and manual) aren't this site's.
    ["tutorialVideoLink", "appTourLink", "userManualLink"].forEach((id) => { const el = document.getElementById(id); if (el) el.style.display = "none"; });
  });
}

// PassTech's photo readers (its /api/analyze-tag and /api/analyze-helmet), for the tech sheets'
// "Scan tag photo": the deployed PassTech, or a local one (port 5004) when this runs locally.
window.PASSTECH_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://localhost:5004" : "https://passtech.frogracing.us";

// The central logbook repository (Supabase -- see supabase/README.md). The
// anon key is public by design: the database's access rules protect the
// data. Never put the service_role key here.
window.LOGBOOK_SERVER = {
  url: "https://opltqtjxrzlgucrgznft.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbHRxdGp4cnpsZ3Vjcmd6bmZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExNjk0NTAsImV4cCI6MjEwNjc0NTQ1MH0.zp9-mI7BUpjIltkZLa707tayiQ-9SvdOomYONU36wPI",
};
