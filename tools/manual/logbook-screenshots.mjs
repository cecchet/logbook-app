// The Digital logbooks user manual's screenshots, taken in headless Chrome from
// the site served at http://localhost:5002 (npx serve of this repo), with
// demo-server.js standing in for the server (a made-up club and car):
//   node driver.mjs logbook-screenshots.mjs 1280 900
// Then build the page: node build-html.mjs logbook-manual.md ../../logbook-user-manual.html logbook
const SITE = "http://localhost:5002/?site=logbook";
const wait = (ms) => `await new Promise(r => setTimeout(r, ${ms}));`;
// Clicks the visible button (or link styled as one) whose text matches; scope: a CSS selector.
const click = (re, scope) => `{ const b = [...document.querySelectorAll(${JSON.stringify((scope ? scope + " " : "") + "button, a.btn, [role=button]")})].find(b => ${re}.test(b.textContent.trim()) && b.offsetParent); if (!b) throw new Error('no button ' + ${JSON.stringify(String(re))}); b.click(); } ${wait(700)}`;
const mode = (re) => `${click(re, ".account-modes")} ${wait(800)} window.scrollTo(0, 0);`;
const unstick = `[...document.querySelectorAll('body *')].forEach(x => { if (getComputedStyle(x).position === 'sticky') x.style.setProperty('position', 'static', 'important'); });`;
// Marks an element (found by the expression) with an id, for a clipped shot.
const mark = (expr, id) => `{ ${unstick} document.getElementById('${id}')?.removeAttribute('id'); const e = ${expr}; if (!e) throw new Error('no element for ${id}'); e.id = '${id}'; e.scrollIntoView({ block: 'start' }); } ${wait(400)}`;
const card = (titleRe) => `[...document.querySelectorAll('.account-card')].find(c => ${titleRe}.test(c.querySelector('.account-card-title')?.textContent || ''))`;
const section = (titleRe) => `[...document.querySelectorAll('.account-panel details, .account-panel section, .account-panel .account-section')].find(s => ${titleRe}.test(s.textContent.trim()))`;
const PANEL = ".account-panel";

export default async function (a) {
  // ---- Signed in: home ----
  await a.go(SITE);
  await a.sleep(1500);
  await a.shot("L01-home");

  // ---- Create a new logbook: from the FIA Article 253 design template ----
  await a.eval(mode("/^1/"));
  await a.shot("L10-create", PANEL);
  await a.eval(`${click("/^Start from a cage template$/", PANEL)} ${wait(1800)}`);
  await a.shot("L11-templates", "#library-dialog", 8, 900);
  await a.eval(`[...document.querySelectorAll('.load-dialog-card')].find(c => /FIA Article 253/.test(c.textContent)).click(); ${wait(500)}
    ${click("/^Start from template$/")} ${wait(3500)} window.scrollTo(0, 0);`);
  await a.eval(mark(card("/^Ready to issue/"), "shot-ready"));
  await a.shot("L12-ready", "#shot-ready");

  // Part 1: the owner, one field missing and the email mistyped -- "Go" on the email.
  await a.eval(`window.RollcageApp.setAnswer('vehicle_owner_email', 'jordan.lee@example'); ${wait(600)}
    window.RollcageApp.jumpTo('field:vehicle_owner_email'); ${wait(2500)}`);
  await a.eval(range(`[...document.querySelectorAll('.category-heading')].find(h => /Owner information/i.test(h.textContent))`,
    `document.querySelector('[data-field="vehicle_owner_email"]').closest('.field-row')`, "shot-owner"));
  await a.shot("L13-required", "#shot-owner");
  await a.eval(mark(`document.getElementById('pictures-ai')`, "shot-ai"));
  await a.shot("L14-ai", "#shot-ai");

  // ---- The library: find the club's logbook online, save it here ----
  await a.eval(`window.confirm = () => true; ${click("/Home/", PANEL)} ${mode("/^2/")}`);
  await a.eval(`${click("/Find a logbook online/", PANEL)}
    const i = document.querySelector('${PANEL} .account-section-body .field input'); i.value = 'Subaru'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); ${wait(200)}
    ${click("/^Find$/", PANEL)} ${wait(1200)}`);
  await a.eval(`${click("/^Save to this device$/", PANEL)} ${wait(4000)}
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Discard' && b.offsetParent)?.click(); ${wait(1500)} window.scrollTo(0, 0);`);
  await a.shot("L20-library", PANEL);

  // Its QR sticker, then scanning one.
  await a.eval(`${click("/^QR sticker$/", PANEL)} ${wait(2500)}`);
  await a.shot("L22-sticker", ".sticker-dialog");
  await a.eval(`[...document.querySelectorAll('.sticker-dialog button')].find(b => /^(Close|Cancel|Done)$/.test(b.textContent.trim()))?.click(); ${wait(500)}
    document.querySelector('.sticker-dialog-backdrop')?.remove(); ${wait(300)}
    ${click("/Scan a QR sticker/", PANEL)} ${wait(1500)}`);
  await a.shot("L23-scan", ".sticker-dialog");
  await a.eval(`document.querySelector('.sticker-dialog-backdrop')?.remove(); ${wait(300)}`);

  // ---- The log: its event, plus a repair ----
  await a.eval(`${click("/^View the event log$/", PANEL)} ${wait(1000)}
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Discard' && b.offsetParent)?.click(); ${wait(3000)}
    ${click("/^Add a repair$/")} ${wait(600)}
    const set = (re, v) => { const c = document.querySelector('.logbook-work'); const f = [...c.querySelectorAll('.field')].find(x => re.test(x.querySelector('label')?.textContent || '')); const i = f.querySelector('input,textarea'); i.value = v; i.dispatchEvent(new Event('change', { bubbles: true })); };
    set(/^What was repaired/, 'Replaced the left door bars'); ${wait(400)}
    set(/^Done by/, 'Northside Fabrication'); ${wait(400)}
    set(/^Notes/, 'Bent in a rollover at the Mud Season Rally; new 1.5" x 0.095" DOM tubes, fully welded.'); ${wait(600)}`);
  await a.eval(mark(`document.getElementById('logbook-events').closest('.panel')`, "shot-log"));
  await a.shot("L24-log", "#shot-log", 8, 1500);

  // ---- Signed out: the sign-in screen ----
  await a.go(SITE + "&demo=signedout");
  await a.sleep(1500);
  await a.shot("L02-signin");
}

// A clip from the top of one element to the bottom of another: an invisible box marking it.
function range(fromExpr, toExpr, id) {
  return `{ ${unstick} document.getElementById('${id}')?.remove(); const a = (${fromExpr}).getBoundingClientRect(), b = (${toExpr}).getBoundingClientRect();
    const d = document.createElement('div'); d.id = '${id}';
    Object.assign(d.style, { position: 'absolute', left: (b.left + scrollX) + 'px', top: (a.top + scrollY - 12) + 'px', width: b.width + 'px', height: (b.bottom - a.top + 12) + 'px', pointerEvents: 'none' });
    document.body.append(d); } ${wait(200)}`;
}
