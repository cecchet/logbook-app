// Builds the Scrutineering user manual (scrutineering-user-manual.html at the
// site's root, linked from the header's "User manual") from manual.md and the
// screenshots (screenshots.mjs) -- one self-contained page, the images
// embedded. The same page as the rollcage app's manual (core/app/tools/manual):
//   node build-html.mjs manual.md ../../scrutineering-user-manual.html
// The Digital logbooks manual, the same way:
//   node build-html.mjs logbook-manual.md ../../logbook-user-manual.html logbook
// manual.md: "# Title", "## Section", "### Subsection", paragraphs, "- " and
// "1. " lists, | tables |, **bold**, *italics*, and "![caption](file.png)"
// for a screenshot from out/.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const [mdFile, outFile] = process.argv.slice(2, 4).map((p) => resolve(p));
// Which site's manual (the third argument): scrutineering (the default) or logbook.
const SITES = {
  scrutineering: {
    name: "Scrutineering", icon: "scrutineering-icon-192.png", host: "scrutineering.frogracing.us",
    description: "How to use Frog Racing's Scrutineering site: tech sheets and sign-off at an event, tech stickers, annual safety stickers, event admin, and a sanctioning body's scrutineers and tech sheets.",
    note: "<b>For scrutineers, chief scrutineers and technical directors.</b> The screenshots show a made-up club, the Demo Rally Club, and its event; what you see depends on your role and permissions. Competitors use PassTech to pre-fill their tech sheets and apply for stickers.",
  },
  logbook: {
    name: "Digital logbooks", icon: "icon-192.png", host: "logbook.frogracing.us",
    description: "How to use Frog Racing's Digital logbooks site: preparing and issuing a car's rollcage logbook, its log of events, repairs and cage updates, QR stickers, and the logbook library.",
    note: "<b>For scrutineers who issue logbooks, and for car owners.</b> The screenshots show a made-up club, the Demo Rally Club, and a made-up car; what you see depends on your role and permissions.",
  },
};
const SITE = SITES[process.argv[4] || "scrutineering"];
const shots = join(here, "out");
const esc = (s) => s.replace(/&(?!#\d+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<span class="mono-inline">$1</span>')
  .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  .replace(/\*([^*]+)\*/g, "<em>$1</em>")
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  .replace(/\b([\w.+-]+@frogracing\.us)\b/g, '<a href="mailto:$1">$1</a>');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dataUrl = (file, type) => "data:" + type + ";base64," + readFileSync(file).toString("base64");
// A PNG's width (its IHDR chunk): narrow screenshots (a dialog, a card) show at their own size.
const pngWidth = (file) => readFileSync(file).readUInt32BE(16);

const lines = readFileSync(mdFile, "utf8").replace(/\r/g, "").split("\n");
let title = "";
const sections = []; // { id, title, html: [], subs: [{ id, title }] }
let cur = null;
const push = (html) => { if (cur) cur.html.push(html); };
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  let m;
  if ((m = /^(#{1,3}) (.*)$/.exec(line))) {
    const level = m[1].length;
    if (level === 1) { title = m[2]; continue; }
    if (level === 2) {
      cur = { id: slug(m[2]), title: m[2], html: [], subs: [] };
      sections.push(cur);
    } else {
      const id = cur.id + "--" + slug(m[2]);
      cur.subs.push({ id, title: m[2] });
      push(`<h3 class="sub-head" id="${id}">${inline(m[2])}</h3>`);
    }
  } else if ((m = /^!\[(.*)\]\((.*)\)$/.exec(line))) {
    const file = join(shots, m[2]);
    const narrow = pngWidth(file) < 700;
    push(`<figure class="shot${narrow ? " narrow" : ""}"><img src="${dataUrl(file, "image/png")}" alt="${esc(m[1])}" loading="lazy"><figcaption>${inline(m[1])}</figcaption></figure>`);
  } else if (/^\|/.test(line)) {
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
    i--;
    const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    push('<div class="table-wrap"><table><thead><tr>' + cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>"
      + rows.slice(2).map((r) => "<tr>" + cells(r).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table></div>");
  } else if (/^(\s*)(-|\d+\.) /.test(line)) {
    const items = [];
    while (i < lines.length && /^(\s*)(-|\d+\.) /.test(lines[i])) {
      const mm = /^(\s*)(-|\d+\.) (.*)$/.exec(lines[i++]);
      items.push({ depth: mm[1].length >= 2 ? 1 : 0, ordered: mm[2] !== "-", text: mm[3] });
    }
    i--;
    let html = "", open = [];
    for (const it of items) {
      while (open.length > it.depth + 1) html += `</li></${open.pop()}>`;
      if (open.length === it.depth) { const tag = it.ordered ? "ol" : "ul"; html += `<${tag} class="${it.ordered ? "steps" : "plain-list"}">`; open.push(tag); }
      else html += "</li>";
      html += `<li>${inline(it.text)}`;
    }
    while (open.length) html += `</li></${open.pop()}>`;
    push(html);
  } else {
    // A section's first paragraph is its lede.
    const lede = cur && !cur.html.length;
    push(`<p${lede ? ' class="lede"' : ""}>${inline(line)}</p>`);
  }
}

const logo = dataUrl(join(here, "..", "..", "icons", SITE.icon), "image/png");
const updated = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
const toc = sections.map((s, n) => `<li class="toc-section"><a href="#${s.id}"><span class="toc-num">${n + 1}</span>${inline(s.title)}</a>`
  + (s.subs.length ? `<ul class="toc-sub">${s.subs.map((x) => `<li><a href="#${x.id}">${inline(x.title)}</a></li>`).join("")}</ul>` : "") + "</li>").join("");
const body = sections.map((s) => `<section class="manual-section" id="${s.id}">
  <h2>${inline(s.title)}</h2>
  ${s.html.join("\n  ")}
</section>`).join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SITE.name} User Manual</title>
<meta name="description" content="${SITE.description}">
<link rel="icon" type="image/png" href="${logo}">
<style>
  :root {
    --ground: #f4f5f7; --surface: #ffffff; --surface-2: #eef2f9; --line: #d6dbe4; --line-soft: #e6e9ef;
    --ink: #1c1f24; --ink-dim: #4a5160; --ink-faint: #7a8190; --accent: #2454b3; --accent-soft: #dce6fa;
    --warn-bg: #fff5dc; --warn-line: #f0d48a; --warn-ink: #6b4d00;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #111317; --surface: #1a1d23; --surface-2: #202634; --line: #2d323c; --line-soft: #242830;
      --ink: #e8eaee; --ink-dim: #b0b6c2; --ink-faint: #7d8492; --accent: #6ea1ff; --accent-soft: #22304d;
      --warn-bg: #2b2308; --warn-line: #4a3b0a; --warn-ink: #f2d27a;
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; background: var(--ground); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  a { color: var(--accent); }
  .shell { display: grid; grid-template-columns: 270px minmax(0, 1fr); max-width: 1200px; margin: 0 auto; }
  @media (max-width: 860px) { .shell { grid-template-columns: 1fr; } }

  .sidebar { position: sticky; top: 0; align-self: start; max-height: 100vh; overflow-y: auto; padding: 28px 18px 28px 22px; border-right: 1px solid var(--line); }
  @media (max-width: 860px) { .sidebar { position: static; max-height: none; border-right: none; border-bottom: 1px solid var(--line); padding: 18px 16px 6px; } }
  .sidebar-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; text-decoration: none; }
  .sidebar-brand img { width: 38px; height: 38px; border-radius: 8px; flex-shrink: 0; }
  .sidebar-brand span { font-weight: 700; font-size: 16px; color: var(--ink); line-height: 1.25; }
  .sidebar-tag { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); margin: 0 0 20px; }
  .nav-toggle { display: none; width: 100%; align-items: center; justify-content: space-between; padding: 9px 12px; margin: 2px 0 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); font: 600 13.5px inherit; cursor: pointer; }
  @media (max-width: 860px) { .nav-toggle { display: flex; } .toc { display: none; } .sidebar.nav-open .toc { display: block; padding-bottom: 8px; } }
  .toc { list-style: none; margin: 0; padding: 0; }
  .toc-section { margin-bottom: 4px; }
  .toc a { display: block; padding: 6px 10px; border-radius: 6px; font-size: 13.5px; color: var(--ink-dim); text-decoration: none; line-height: 1.4; }
  .toc a:hover { background: var(--surface-2); color: var(--ink); }
  .toc-num { display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px; border-radius: 50%; background: var(--surface-2); border: 1px solid var(--line); font-size: 10px; color: var(--ink-faint); margin-right: 8px; }
  .toc-sub { list-style: none; margin: 2px 0 6px 27px; padding: 0; border-left: 1px solid var(--line-soft); }
  .toc-sub a { padding: 3px 10px; font-size: 12.5px; color: var(--ink-faint); }

  .content { padding: 40px 44px 120px; min-width: 0; }
  @media (max-width: 640px) { .content { padding: 26px 16px 90px; } }
  .page-title h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .page-title p { margin: 0; color: var(--ink-dim); font-size: 15px; }
  .disclaimer { margin-top: 20px; padding: 14px 18px; border-radius: 10px; background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn-ink); font-size: 13.5px; line-height: 1.6; }

  section.manual-section { padding-top: 48px; margin-top: 8px; border-top: 1px solid var(--line); scroll-margin-top: 12px; }
  section.manual-section:first-of-type { border-top: none; padding-top: 28px; }
  .manual-section h2 { font-size: 25px; margin: 0 0 10px; letter-spacing: -0.005em; }
  .lede { font-size: 15.5px; color: var(--ink) !important; }
  h3.sub-head { font-size: 16px; margin: 30px 0 6px; padding-top: 16px; border-top: 1px solid var(--line-soft); scroll-margin-top: 12px; }
  .manual-section p, .manual-section li { color: var(--ink-dim); font-size: 14.5px; line-height: 1.65; max-width: 72ch; }
  .manual-section b { color: var(--ink); font-weight: 600; }
  .mono-inline { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 13px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; color: var(--ink); }
  ol.steps, ul.plain-list { margin: 10px 0 18px; padding-left: 24px; max-width: 72ch; }
  ol.steps li, ul.plain-list li { padding-bottom: 6px; }
  ol.steps li::marker { color: var(--accent); font-weight: 700; }
  ul.plain-list ul.plain-list { margin: 6px 0 0; }

  figure.shot { margin: 16px 0 24px; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--surface); max-width: 860px; }
  figure.shot.narrow { max-width: 620px; width: fit-content; }
  figure.shot img { display: block; width: 100%; height: auto; }
  figure.shot.narrow img { width: auto; max-width: 100%; margin: 0 auto; }
  figure.shot figcaption { padding: 9px 16px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--ink-dim); line-height: 1.5; }

  .table-wrap { overflow-x: auto; margin: 12px 0 22px; max-width: 860px; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  th, td { border-bottom: 1px solid var(--line-soft); padding: 8px 12px; text-align: left; vertical-align: top; color: var(--ink-dim); }
  th { background: var(--surface-2); color: var(--ink); font-weight: 600; }
  td:first-child { color: var(--ink); white-space: nowrap; }
  @media (max-width: 640px) { td:first-child { white-space: normal; } }

  .page-foot { margin-top: 60px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--ink-faint); }
</style>
</head>
<body>
<div class="shell">
  <aside class="sidebar" id="sidebar">
    <a class="sidebar-brand" href="#top"><img src="${logo}" alt=""><span>${SITE.name}</span></a>
    <p class="sidebar-tag">User manual · Frog Racing</p>
    <button class="nav-toggle" type="button" aria-expanded="false" onclick="var s=document.getElementById('sidebar');var o=s.classList.toggle('nav-open');this.setAttribute('aria-expanded',o)">Contents <span>▾</span></button>
    <ol class="toc">${toc}</ol>
  </aside>
  <main class="content" id="top">
    <div class="page-title">
      <h1>${inline(title || SITE.name)} — User manual</h1>
      <p>Updated ${updated}. Open the site at <a href="https://${SITE.host}/" target="_blank" rel="noopener">${SITE.host}</a>.</p>
    </div>
    <div class="disclaimer">${SITE.note}</div>
${body}
    <p class="page-foot">Frog Racing · questions or corrections: <a href="mailto:info@frogracing.us">info@frogracing.us</a></p>
  </main>
</div>
<script>
  // On a phone, picking a section closes the contents again.
  document.querySelectorAll('.toc a').forEach(function (a) { a.addEventListener('click', function () { document.getElementById('sidebar').classList.remove('nav-open'); }); });
</script>
</body>
</html>
`;
writeFileSync(outFile, html);
console.log("Wrote", outFile, Math.round(html.length / 1024) + " KB,", sections.length, "sections");
