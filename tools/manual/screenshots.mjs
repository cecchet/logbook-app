// The Scrutineering user manual's screenshots, taken in headless Chrome from
// the site served at http://localhost:5002 (npx serve of this repo), with
// demo-server.js standing in for the server (a made-up club and event):
//   rm -r profile out; node driver.mjs screenshots.mjs 1280 900
// Then build the page: node build-html.mjs manual.md ../../scrutineering-user-manual.html
const SITE = "http://localhost:5002/?site=scrutineering";
const wait = (ms) => `await new Promise(r => setTimeout(r, ${ms}));`;
// Clicks the visible button (or link styled as one) whose text matches; scope: a CSS selector.
const click = (re, scope) => `{ const b = [...document.querySelectorAll(${JSON.stringify((scope ? scope + " " : "") + "button, a.btn, [role=button]")})].find(b => ${re}.test(b.textContent.trim()) && b.offsetParent); if (!b) throw new Error('no button ' + ${JSON.stringify(String(re))}); b.click(); } ${wait(700)}`;
const mode = (re) => `${click(re, ".account-modes")} ${wait(800)} window.scrollTo(0, 0);`;
const unstick = `[...document.querySelectorAll('body *')].forEach(x => { if (getComputedStyle(x).position === 'sticky') x.style.setProperty('position', 'static', 'important'); });`;
// Marks an element (found by the expression) with an id, for a clipped shot.
const mark = (expr, id) => `{ ${unstick} document.getElementById('${id}')?.removeAttribute('id'); const e = ${expr}; if (!e) throw new Error('no element for ${id}'); e.id = '${id}'; e.scrollIntoView({ block: 'start' }); } ${wait(400)}`;
const select = (labelRe, value) => `{ const f = [...document.querySelectorAll('.account-panel .field')].find(f => ${labelRe}.test(f.querySelector('label')?.textContent || ''));
  const s = f.querySelector('select'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); } ${wait(900)}`;
const card = (titleRe) => `[...document.querySelectorAll('.account-card')].find(c => ${titleRe}.test(c.querySelector('.account-card-title')?.textContent || ''))`;
const PANEL = ".account-panel";

export default async function (a) {
  // ---- Signed in: home ----
  await a.go(SITE);
  await a.sleep(1500);
  await a.shot("01-home");

  // ---- Scrutineering at an event ----
  await a.eval(mode("/^1/"));
  await a.shot("10-events", PANEL);
  await a.eval(`${click("/Pine Hills Rally/", ".account-panel")} ${wait(1200)} window.scrollTo(0, 0);`);
  await a.shot("11-event", PANEL);

  // Car #23's sheet: the team's (from PassTech), nothing checked yet.
  const row23 = `[...document.querySelectorAll('.account-entry')].find(r => /^#23/.test(r.textContent.trim()))`;
  await a.eval(`${row23}.querySelector('button').click(); ${wait(2500)}`);
  await a.shot("12-sheet-top", "#techsheet-panel", 8, 1060);
  // The driver's helmet line, open: the team's declaration and photos, PassTech's verdict, the gear details.
  await a.eval(mark(`document.querySelectorAll('#techsheet-panel .techsheet-row')[0]`, "shot-line"));
  await a.shot("13-sheet-line", "#shot-line", 8, 1100);
  // A few results: Pass on the first lines, Fail with a note on one.
  await a.eval(`const rows = [...document.querySelectorAll('#techsheet-panel .techsheet-row')];
    for (const i of [0, 1, 2, 3, 4, 5]) { rows[i].querySelector('.techsheet-result.pass')?.click(); ${wait(150)} }
    console.log('rows', rows.length);`);
  await a.eval(`const r = [...document.querySelectorAll('#techsheet-panel .techsheet-row')][6]; r.querySelector('.techsheet-result.fail')?.click(); ${wait(300)}
    const n = r.querySelector('.techsheet-note input, input.techsheet-note, .techsheet-note textarea, textarea.techsheet-note'); if (n) { n.value = 'Driver name patch missing on the suit'; n.dispatchEvent(new Event('input', { bubbles: true })); } ${wait(300)}`);
  await a.eval(mark(`document.querySelector('#techsheet-panel .techsheet-summary')`, "shot-summary"));
  await a.shot("14-sheet-summary", "#shot-summary");
  // The bottom: corrections, sign-off, import, stickers.
  await a.eval(range(`document.querySelector('#techsheet-panel .techsheet-corrections')`, `document.getElementById('techsheet-panel')`, "shot-bottom"));
  await a.shot("16-sheet-bottom", "#shot-bottom", 0);
  // A photo, full screen.
  await a.eval(`document.querySelector('#techsheet-panel .techsheet-photos img').click(); ${wait(1200)}`);
  await a.shot("17-photo-viewer");
  await a.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); ${wait(300)}`);

  // A passed car (#55): its stickers, then printing them.
  await a.eval(`${click("/^Close$/", "#techsheet-panel")} ${wait(400)} [...document.querySelectorAll('.sticker-dialog button')].find(b => /without saving/.test(b.textContent))?.click(); ${wait(800)}`);
  const row55 = `[...document.querySelectorAll('.account-entry')].find(r => /^#55/.test(r.textContent.trim()))`;
  await a.eval(`${row55}.querySelector('button').click(); ${wait(2500)}`);
  await a.eval(mark(card("/^Stickers/"), "shot-stickers"));
  await a.shot("18-sheet-stickers", "#shot-stickers");
  await a.eval(`${click("/^Print all/", "#shot-stickers")} ${wait(1500)}`);
  await a.shot("19-print-dialog", ".sticker-dialog");
  await a.eval(`document.querySelector('.sticker-dialog-backdrop').remove(); ${wait(200)}`);

  // ---- Annual safety stickers ----
  await a.go(SITE);
  await a.sleep(1200);
  await a.eval(mode("/^2/"));
  await a.eval(select("/^Discipline/", "autox"));
  await a.shot("20-annual", PANEL);
  await a.eval(`${click("/^Applications/", ".account-tabs")}`);
  await a.shot("21-annual-applications", PANEL);
  await a.eval(`${click("/^Review and issue$/", ".account-panel")} ${wait(1500)}`);
  await a.eval(mark(card("/sticker$/"), "shot-review"));
  await a.shot("22-annual-review", "#shot-review", 8, 1300);
  await a.eval(`${click("/^Cancel$/", "#shot-review")}`);
  await a.eval(`${click("/^Issued/", ".account-tabs")}`);
  await a.eval(`[...document.querySelectorAll(".account-entry")].find(r => /K7M2/.test(r.textContent)).querySelector("button").click(); ${wait(1500)} window.scrollTo(0, 0);`);
  await a.shot("23-annual-issued", PANEL, 8, 1300);
  await a.eval(`const i = document.querySelector('[data-id=annual-search]'); i.value = 'jordan'; i.dispatchEvent(new Event('input', { bubbles: true })); ${wait(600)}
    [...document.querySelectorAll(".account-panel button")].find(b => b.textContent === "Hide")?.click(); ${wait(500)}`);
  await a.eval(mark(card("/stickers$/"), "shot-search"));
  await a.shot("24-annual-search", "#shot-search");

  // ---- Event admin ----
  await a.go(SITE);
  await a.sleep(1200);
  await a.eval(mode("/^3/"));
  await a.eval(`${click("/^Create new event$/", ".account-panel")}`);
  await a.eval(`${select("/^Discipline/", "rally")}`);
  await a.shot("30-admin-events", PANEL);
  await a.eval(`${click("/^Cancel$/", ".account-panel")} ${click("/Pine Hills Rally/", ".account-panel")} ${wait(1200)} window.scrollTo(0, 0);`);
  await a.shot("31-admin-competitors", PANEL, 8, 1000);
  // MotorsportReg: a demo entry list, as if picked in the file dialog.
  await a.eval(`const csv = 'Registration Status,No.,Full Name,E-mail,Year,Make,Model,Color,Class\\n' +
      'Confirmed,7,CASEY RIVERA,casey.rivera@example.com,2008,Subaru,Impreza WRX,Blue,O4WD\\n' +
      'Confirmed,12,priya nair,priya.nair@example.com,2002,Ford,Focus,Red,L2WD\\n' +
      'Confirmed,19,Morgan Hale,morgan.hale@example.com,2016,Ford,Fiesta ST,White,L2WD\\n' +
      'New,27,Ellis Grant,ellis.grant@example.com,1997,Subaru,Impreza 2.5RS,Green,O4WD\\n' +
      'Confirmed,31,Chris Walker,chris.walker@example.com,1990,Volvo,240,Gray,NA\\n' +
      'Confirmed,31,Jesse Park,jesse.park@example.com,2005,Mazda,RX-8,Black,O2WD\\n';
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== 'file') return orig.call(this);
      const dt = new DataTransfer(); dt.items.add(new File([csv], 'pine-hills-entries.csv', { type: 'text/csv' }));
      this.files = dt.files; this.dispatchEvent(new Event('change'));
    };
    ${click("/^Bulk import from MSR$/", ".account-panel")} ${click("/^Choose the CSV file$/", ".account-panel")} ${wait(800)}`);
  await a.eval(mark(card("/^Bulk import from MotorsportReg/"), "shot-msr"));
  await a.shot("32-admin-msr", "#shot-msr");
  await a.eval(`${click("/^Cancel$/", "#shot-msr")} ${click("/^Admin$/", ".account-tabs")} window.scrollTo(0, 0);`);
  await a.shot("33-admin-event", PANEL);
  await a.eval(`${click("/^Change tech sheets$/", ".account-panel")} ${click("/^Add a tech sheet$/", ".account-panel")}
    const rows = document.querySelectorAll('.event-sheet-row'); const sel = rows[1].querySelector('select'); sel.value = 'tpl-historic'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    const c = rows[1].querySelector('input'); c.value = 'NA, H2WD'; c.dispatchEvent(new Event('input', { bubbles: true })); ${wait(300)}`);
  await a.eval(mark(card("/^Tech sheets$/"), "shot-sheets"));
  await a.shot("34-admin-sheets", "#shot-sheets");

  // ---- Sanctioning bodies, scrutineers and tech sheets ----
  await a.go(SITE);
  await a.sleep(1200);
  await a.eval(mode("/^4/"));
  await a.shot("40-bodies", PANEL);
  await a.eval(`${click("/^Demo Rally Club/", ".account-panel")} window.scrollTo(0, 0);`);
  await a.shot("41-body", PANEL);
  await a.eval(`${click("/^Add a scrutineer$/", ".account-panel")}`);
  await a.eval(`const f = ${card("/^Add a scrutineer for/")}; const set = (re, v) => { const fl = [...f.querySelectorAll('.field')].find(x => re.test(x.querySelector('label').textContent)); const i = fl.querySelector('input,select'); i.value = v; i.dispatchEvent(new Event(i.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
    set(/^Name/, 'Jesse Park'); set(/^Email/, 'jesse.park@example.com'); set(/^License number/, 'DRC-040'); set(/^Scrutineer code/, '40'); ${wait(300)}`);
  await a.eval(mark(card("/^Add a scrutineer for/"), "shot-add"));
  await a.shot("42-body-add", "#shot-add");
  await a.eval(`${click("/^Cancel$/", "#shot-add")}
    const row = [...document.querySelectorAll('.account-table tr')].find(r => /Jamie Chen/.test(r.textContent)); [...row.querySelectorAll('button')].find(b => /Permissions/.test(b.textContent)).click(); ${wait(500)}`);
  await a.eval(mark(`document.querySelector('.account-panel .account-table')`, "shot-perms"));
  await a.shot("43-body-permissions", "#shot-perms");
  await a.eval(`${click("/^Cancel$/", "#shot-perms")} ${click("/^Tech sheets/", ".account-tabs")} window.scrollTo(0, 0);`);
  await a.shot("44-body-sheets", PANEL);
  await a.eval(`const e = [...document.querySelectorAll('.account-entry')].find(r => /Rally Tech Sheet/.test(r.textContent)); [...e.querySelectorAll('button')].find(b => b.textContent === 'Edit').click(); ${wait(1500)} window.scrollTo(0, 0);`);
  await a.shot("45-sheet-editor", PANEL, 8, 1300);

  // ---- A scanned sticker ----
  await a.go("http://localhost:5002/?site=scrutineering&s=K7M2Q9TX");
  await a.sleep(2000);
  await a.shot("50-sticker", PANEL);

  // ---- Signed out: the sign-in screen ----
  await a.go("http://localhost:5002/?site=scrutineering&demo=signedout");
  await a.sleep(1500);
  await a.shot("02-signin");
}

// A clip from the top of one element to the bottom of another: an invisible box marking it.
function range(fromExpr, toExpr, id) {
  return `{ ${unstick} document.getElementById('${id}')?.remove(); const a = (${fromExpr}).getBoundingClientRect(), b = (${toExpr}).getBoundingClientRect();
    const d = document.createElement('div'); d.id = '${id}';
    Object.assign(d.style, { position: 'absolute', left: (b.left + scrollX) + 'px', top: (a.top + scrollY - 12) + 'px', width: b.width + 'px', height: (b.bottom - a.top + 12) + 'px', pointerEvents: 'none' });
    document.body.append(d); } ${wait(200)}`;
}
