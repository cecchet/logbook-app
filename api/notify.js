// Vercel serverless function -- emails a car's owner about their logbook,
// through Resend (the same account and domain as the sign-in emails).
//
// POST /api/notify   Authorization: Bearer <the signed-in user's Supabase access token>
//   body (JSON): { logbookId, kind, ref? }   kind: "issued" (more to come)
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

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// One email per kind: { subject, lines } -- each line is plain text, or
// { text, href } for a link. Rendered as both text and HTML below.
const TEMPLATES = {
  issued(n) {
    const car = n.car || n.carName || "car";
    const named = n.carName && n.car && n.carName !== n.car ? " (“" + n.carName + "”)" : "";
    return {
      subject: "Your " + car + "'s digital logbook " + n.digitalNumber + " has been issued",
      lines: [
        "Hello" + (n.ownerName ? " " + n.ownerName : "") + ",",
        (n.issuedBy || "A scrutineer") + " has issued the digital logbook " + n.digitalNumber + " for your " + car + named + "." +
          (n.body ? " It is your " + n.body + " logbook" + (n.bodyNumber ? ", number " + n.bodyNumber : "") + "." : ""),
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
      ].filter(Boolean),
    };
  },
};

function render({ subject, lines }) {
  const text = lines.map((l) => (typeof l === "string" ? l : l.bullets ? l.bullets.map((b) => "  - " + b).join("\n") : l.text)).join("\n\n") +
    "\n\n-- \nFrog Racing Digital Logbooks, " + APP_URL + "\nThis email was sent because a scrutineer recorded this address as the car's owner.";
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:600px">' +
    lines.map((l) => (typeof l === "string" ? "<p>" + esc(l) + "</p>"
      : l.bullets ? "<ul>" + l.bullets.map((b) => "<li>" + esc(b) + "</li>").join("") + "</ul>"
      : '<p><a href="' + esc(l.href) + '" style="color:#1a6dd6">' + esc(l.text) + "</a></p>")).join("") +
    '<p style="color:#777;font-size:12px;border-top:1px solid #ddd;padding-top:8px;margin-top:24px">Frog Racing Digital Logbooks &middot; <a href="' + esc(APP_URL) + '" style="color:#777">' + esc(APP_URL.replace(/^https?:\/\//, "")) + "</a><br>This email was sent because a scrutineer recorded this address as the car's owner.</p></div>";
  return { subject, text, html };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const auth = req.headers.authorization || "";
  if (!/^Bearer\s+\S+/.test(auth)) return res.status(401).json({ error: "Sign in first" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
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
