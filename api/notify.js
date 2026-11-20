// Vercel serverless function -- emails a car's owner about their logbook,
// through Resend (the same account and domain as the sign-in emails).
//
// POST /api/notify   Authorization: Bearer <the signed-in user's Supabase access token>
//   body (JSON): { logbookId, kind, ref? }   kind: "issued" | "reminder" -- to a car's owner
//            or: { requestId, kind }         kind: "submitted" | "returned" -- a roll cage design
//                review or logbook request: to its reviewer when sent, its owner when it comes back
//                (claim_design_notification; called from the Rollcage assessment tool too, so it
//                answers its origin's CORS preflight).
// The database decides whether the caller may send it, and records it so it
// goes out once (claim_notification, called as the caller): this function
// never chooses the recipient.
//
// Vercel environment variables:
//   RESEND_API_KEY  required -- a Resend API key with sending access to frogracing.us
//   NOTIFY_FROM     optional -- default "Frog Racing Digital Logbooks <logbook@frogracing.us>"
//   APP_URL         optional -- default https://logbook.frogracing.us
// Zero npm dependencies (the platform's built-in fetch).

// The repository's address and public key (as in config.js: the anon key is
// public by design, the database's access rules protect the data).
const SUPABASE_URL = process.env.SUPABASE_URL || "https://opltqtjxrzlgucrgznft.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbHRxdGp4cnpsZ3Vjcmd6bmZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExNjk0NTAsImV4cCI6MjEwNjc0NTQ1MH0.zp9-mI7BUpjIltkZLa707tayiQ-9SvdOomYONU36wPI";
const FROM = process.env.NOTIFY_FROM || "Frog Racing Digital Logbooks <logbook@frogracing.us>";
const APP_URL = (process.env.APP_URL || "https://logbook.frogracing.us").replace(/\/+$/, "");
// Where design reviews happen, and where logbook requests are issued.
const ROLLCAGE_URL = (process.env.ROLLCAGE_URL || "https://rollcage.frogracing.us").replace(/\/+$/, "");
const SCRUTINEERING_URL = (process.env.SCRUTINEERING_URL || "https://scrutineering.frogracing.us").replace(/\/+$/, "");
const DESIGN_FROM = process.env.DESIGN_NOTIFY_FROM || "Frog Racing Rollcage <logbook@frogracing.us>";
// The pages that may call this from a browser.
const ORIGINS = [ROLLCAGE_URL, SCRUTINEERING_URL, APP_URL, "http://localhost:5003", "http://localhost:5002"];

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// One email per kind: { subject, lines } -- each line is plain text, or
// { text, href } for a link. Rendered as both text and HTML below.
const longDate = (d) => (d ? new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "");
// What every email about the logbook says after its opening: how to reach it.
function logbookLines(n) {
  return [
    "To see it, sign in to Digital logbooks with this email address (" + n.to + ") and open My garage:",
    { text: APP_URL, href: APP_URL + "/" },
    "From My garage you can:",
    { bullets: [
      "Save to this device -- to see the whole logbook (its rollcage, pictures and event log) offline.",
      "Export to a file -- to import the logbook into PassTech or the Rollcage assessment tool.",
      "Privacy and public link -- choose what its public link and QR sticker show.",
    ] },
    n.publicToken ? "Its public page (what anyone scanning its QR sticker sees):" : null,
    n.publicToken ? { text: APP_URL + "/?logbook=" + n.publicToken, href: APP_URL + "/?logbook=" + n.publicToken } : null,
    "Only scrutineers can add to it: they record each inspection and event, and you'll see them in its event log.",
  ];
}
const carOf = (n) => n.car || n.carName || "car";
const nameOf = (n) => (n.carName && n.car && n.carName !== n.car ? " (“" + n.carName + "”)" : "");
const bodyLine = (n) => (n.body ? " It is your " + n.body + " logbook" + (n.bodyNumber ? ", number " + n.bodyNumber : "") + "." : "");
const hello = (n) => "Hello" + (n.ownerName ? " " + n.ownerName : "") + ",";

// One email per kind: { subject, lines } -- each line is plain text,
// { text, href } for a link or { bullets }. Rendered as both text and HTML below.
const TEMPLATES = {
  // The logbook was just issued.
  issued: (n) => ({
    subject: "Your " + carOf(n) + "'s digital logbook " + n.digitalNumber + " has been issued",
    lines: [hello(n),
      (n.issuedBy || "A scrutineer") + " has issued the digital logbook " + n.digitalNumber + " for your " + carOf(n) + nameOf(n) + "." + bodyLine(n),
    ].concat(logbookLines(n)).filter(Boolean),
  }),
  // A scrutineer's "Email owner": how to reach it, again (or for a new owner).
  reminder: (n) => ({
    subject: "Your " + carOf(n) + "'s digital logbook " + n.digitalNumber,
    lines: [hello(n),
      (n.sentBy || "A scrutineer") + " sent you the details of the digital logbook " + n.digitalNumber + " for your " + carOf(n) + nameOf(n) +
        (n.issuedAt ? ", issued on " + longDate(n.issuedAt) + (n.issuedBy ? " by " + n.issuedBy : "") : "") + "." + bodyLine(n),
    ].concat(logbookLines(n)).filter(Boolean),
  }),
};

// Roll cage design reviews and logbook requests: { subject, lines, why, site }.
const DESIGN_TEMPLATES = {
  submitted: (n) => n.kind === "logbook" ? {
    subject: "Logbook request: " + n.title,
    lines: ["Hello " + n.reviewerName + ",",
      n.ownerEmail + " asks you to issue the digital logbook for their roll cage design \u201c" + n.title + "\u201d" + (n.scope ? " (" + n.scope + ")" : "") + ".",
      n.message ? "Their message: \u201c" + n.message + "\u201d" : null,
      n.keepHistory ? "They'd like the logbook to keep the design's history (" + n.versions + " version" + (n.versions === 1 ? "" : "s") + " and its reviews)." : null,
      "Sign in to Scrutineering with this email address (" + n.to + "), open Digital logbooks, then Logbook requests: open the design, inspect the car, and issue its logbook.",
      { text: SCRUTINEERING_URL, href: SCRUTINEERING_URL + "/" },
      "You can contact them at " + n.ownerEmail + ".",
    ].filter(Boolean),
    why: "This email was sent because you're listed as a scrutineer who issues logbooks.", site: "Frog Racing Scrutineering, " + SCRUTINEERING_URL,
  } : {
    subject: "Roll cage design to review: " + n.title,
    lines: ["Hello " + n.reviewerName + ",",
      n.ownerEmail + " sent you their roll cage design \u201c" + n.title + "\u201d to review" + (n.scope ? " (" + n.scope + ")" : "") + ".",
      n.message ? "Their message: \u201c" + n.message + "\u201d" : null,
      "Open the Rollcage assessment tool and sign in with this email address (" + n.to + "): Design reviews, then Sent to me. Open the design in the editor -- change it if you like -- then send it back with your comments. Its whole history comes with it.",
      { text: ROLLCAGE_URL, href: ROLLCAGE_URL + "/" },
      "You can contact them at " + n.ownerEmail + ".",
    ].filter(Boolean),
    why: "This email was sent because you're listed as a " + (n.reviewerKind === "fabricator" ? "roll cage fabricator" : "scrutineer") + " in the Frog Racing directory.", site: "Frog Racing Rollcage assessment tool, " + ROLLCAGE_URL,
  },
  returned: (n) => ({
    subject: (n.status === "declined" ? "Declined: " : "Your design is back: ") + n.title,
    lines: ["Hello,",
      n.status === "declined"
        ? n.reviewerName + " declined your " + (n.kind === "logbook" ? "logbook request" : "review request") + " for \u201c" + n.title + "\u201d."
        : n.reviewerName + " sent your roll cage design \u201c" + n.title + "\u201d back" + (n.changed ? ", with changes (a new version)" : "") + ".",
      n.returnNote ? (n.status === "declined" ? "Why: " : "Their comments: ") + "\u201c" + n.returnNote + "\u201d" : null,
      "Open the Rollcage assessment tool and sign in with this email address (" + n.to + "): Design reviews, then My designs. Open the latest version, change it if you like, and send it again -- to them or someone else; its history goes with it.",
      { text: ROLLCAGE_URL, href: ROLLCAGE_URL + "/" },
    ].filter(Boolean),
    why: "This email was sent because you sent this design from the Rollcage assessment tool.", site: "Frog Racing Rollcage assessment tool, " + ROLLCAGE_URL,
  }),
};

function render({ subject, lines, why, site }) {
  why = why || "This email was sent because a scrutineer recorded this address as the car's owner.";
  site = site || "Frog Racing Digital Logbooks, " + APP_URL;
  const text = lines.map((l) => (typeof l === "string" ? l : l.bullets ? l.bullets.map((b) => "  - " + b).join("\n") : l.text)).join("\n\n") +
    "\n\n-- \n" + site + "\n" + why;
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:600px">' +
    lines.map((l) => (typeof l === "string" ? "<p>" + esc(l) + "</p>"
      : l.bullets ? "<ul>" + l.bullets.map((b) => "<li>" + esc(b) + "</li>").join("") + "</ul>"
      : '<p><a href="' + esc(l.href) + '" style="color:#1a6dd6">' + esc(l.text) + "</a></p>")).join("") +
    '<p style="color:#777;font-size:12px;border-top:1px solid #ddd;padding-top:8px;margin-top:24px">' + esc(site) + "<br>" + esc(why) + "</p></div>";
  return { subject, text, html };
}

// A design request's email: claimed as the caller, then sent.
async function designEmail(res, auth, requestId, kind) {
  const claim = await fetch(SUPABASE_URL + "/rest/v1/rpc/claim_design_notification", {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ p_request: requestId, p_kind: kind }),
  });
  const n = await claim.json().catch(() => null);
  if (!claim.ok) return res.status(403).json({ error: (n && n.message) || "Not allowed" });
  const mail = render(DESIGN_TEMPLATES[kind](n));
  const sent = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: DESIGN_FROM, to: [n.to], reply_to: kind === "submitted" ? n.ownerEmail : undefined, subject: mail.subject, text: mail.text, html: mail.html }),
  });
  const out = await sent.json().catch(() => ({}));
  if (!sent.ok) return res.status(502).json({ error: "The email couldn't be sent", detail: out.message || sent.status });
  return res.status(200).json({ sent: true, id: out.id });
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const auth = req.headers.authorization || "";
  if (!/^Bearer\s+\S+/.test(auth)) return res.status(401).json({ error: "Sign in first" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  if (body.requestId) {
    if (!DESIGN_TEMPLATES[body.kind]) return res.status(400).json({ error: "a known kind is required" });
    if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: "Email isn't set up (RESEND_API_KEY)" });
    return designEmail(res, auth, body.requestId, body.kind);
  }
  const { logbookId, kind, ref } = body;
  if (!logbookId || !TEMPLATES[kind]) return res.status(400).json({ error: "logbookId and a known kind are required" });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: "Email isn't set up (RESEND_API_KEY)" });

  // Claim it, as the caller: refused unless they may send it (and not sent yet).
  const claim = await fetch(SUPABASE_URL + "/rest/v1/rpc/claim_notification", {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ p_logbook: logbookId, p_kind: kind, p_ref: ref || "" }),
  });
  const n = await claim.json().catch(() => null);
  if (!claim.ok) return res.status(403).json({ error: (n && n.message) || "Not allowed" });

  const mail = render(TEMPLATES[kind](n));
  const sent = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [n.to], subject: mail.subject, text: mail.text, html: mail.html }),
  });
  const out = await sent.json().catch(() => ({}));
  if (!sent.ok) return res.status(502).json({ error: "The email couldn't be sent", detail: out.message || sent.status });
  return res.status(200).json({ sent: true, to: n.to, id: out.id });
};

// The emails as rendered (for checking their wording).
module.exports.render = (kind, n) => render(TEMPLATES[kind](n));
module.exports.renderDesign = (kind, n) => render(DESIGN_TEMPLATES[kind](n));
