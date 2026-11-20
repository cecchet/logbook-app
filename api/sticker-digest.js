// Vercel cron job (vercel.json, once a day) -- emails each scrutineer who opted in (Annual safety
// stickers: "Email me a daily digest") the annual sticker applications that arrived since their
// last digest, through Resend. Nothing new for someone: no email.
//
// The database decides who gets what and marks it sent (sticker_digest, supabase/migrations/
// 20261120000000_design_reviews.sql), given the shared secret it holds in app_settings
// ('digest_secret') -- no service key here.
//
// Vercel environment variables:
//   RESEND_API_KEY  required -- as for api/notify.js
//   DIGEST_SECRET   required -- the same value as app_settings.digest_secret in the database
//   CRON_SECRET     recommended -- Vercel sends it with its cron calls (Authorization: Bearer ...);
//                   when set, any other call is refused
//   DIGEST_FROM     optional -- default "Frog Racing Scrutineering <logbook@frogracing.us>"
//   SCRUTINEERING_URL optional -- default https://scrutineering.frogracing.us
const SUPABASE_URL = process.env.SUPABASE_URL || "https://opltqtjxrzlgucrgznft.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbHRxdGp4cnpsZ3Vjcmd6bmZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExNjk0NTAsImV4cCI6MjEwNjc0NTQ1MH0.zp9-mI7BUpjIltkZLa707tayiQ-9SvdOomYONU36wPI";
const FROM = process.env.DIGEST_FROM || "Frog Racing Scrutineering <logbook@frogracing.us>";
const SITE = (process.env.SCRUTINEERING_URL || "https://scrutineering.frogracing.us").replace(/\/+$/, "");
const GEAR = { helmet: "Helmet", hnr: "HANS / head & neck restraint", seat: "Seat", fire_extinguisher: "Fire extinguisher", fire_suppression: "Fire suppression system" };

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const day = (d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// One digest: { to, name, groups: [{ scope, newCount, pendingCount, items: [{ category, owner, submittedAt }] }] }.
function render(d) {
  const total = d.groups.reduce((n, g) => n + g.newCount, 0);
  const subject = total + " new annual sticker application" + (total === 1 ? "" : "s");
  const why = "You get this daily digest because you turned it on in Annual safety stickers. Turn it off there, for each body and discipline.";
  const intro = "Hello" + (d.name ? " " + d.name : "") + ",";
  const lead = "New annual sticker applications since your last digest:";
  const howTo = "Sign in to Scrutineering, open Annual safety stickers, then Applications, to review and issue them:";
  const groupText = (g) => g.scope + ": " + g.newCount + " new" + (g.pendingCount > g.newCount ? " (" + g.pendingCount + " waiting in all)" : "") + "\n" +
    g.items.map((i) => "  - " + (GEAR[i.category] || i.category) + (i.owner ? ", " + i.owner : "") + " (" + day(i.submittedAt) + ")").join("\n");
  const text = [intro, lead, d.groups.map(groupText).join("\n\n"), howTo, SITE + "/"].join("\n\n") + "\n\n-- \nFrog Racing Scrutineering, " + SITE + "\n" + why;
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:600px">' +
    "<p>" + esc(intro) + "</p><p>" + esc(lead) + "</p>" +
    d.groups.map((g) => "<p><strong>" + esc(g.scope) + "</strong>: " + g.newCount + " new" + (g.pendingCount > g.newCount ? " (" + g.pendingCount + " waiting in all)" : "") + "</p><ul>" +
      g.items.map((i) => "<li>" + esc((GEAR[i.category] || i.category) + (i.owner ? ", " + i.owner : "")) + " <span style=\"color:#777\">(" + esc(day(i.submittedAt)) + ")</span></li>").join("") + "</ul>").join("") +
    "<p>" + esc(howTo) + '</p><p><a href="' + esc(SITE) + '/" style="color:#1a6dd6">' + esc(SITE) + "</a></p>" +
    '<p style="color:#777;font-size:12px;border-top:1px solid #ddd;padding-top:8px;margin-top:24px">Frog Racing Scrutineering<br>' + esc(why) + "</p></div>";
  return { subject, text, html };
}

module.exports = async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== "Bearer " + process.env.CRON_SECRET) return res.status(401).json({ error: "Not allowed" });
  if (!process.env.RESEND_API_KEY || !process.env.DIGEST_SECRET) return res.status(500).json({ error: "Not set up (RESEND_API_KEY, DIGEST_SECRET)" });
  const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/sticker_digest", {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ p_secret: process.env.DIGEST_SECRET }),
  });
  const digests = await r.json().catch(() => null);
  if (!r.ok) return res.status(502).json({ error: (digests && digests.message) || "The database refused" });
  const results = [];
  for (const d of digests || []) {
    const mail = render(d);
    const sent = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [d.to], subject: mail.subject, text: mail.text, html: mail.html }),
    });
    results.push({ ok: sent.ok });
  }
  return res.status(200).json({ digests: results.length, failed: results.filter((x) => !x.ok).length });
};
module.exports.render = render;
