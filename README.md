# Digital logbooks — Frog Racing

logbook.frogracing.us: digital logbooks for rally cars, replacing the paper
logbook. A logbook records:

- **Logbook information** (Part 1): the vehicle, its sanctioning body (and
  whether the cage meets its rules), the logbook details (owner, builder,
  inspector, logbook number), and an **entry for every event** the car enters
  — event name and date, driver, tech inspection result (pass/fail) with
  optional notes, optional scrutineer name/license, chief scrutineer
  name/license, optional event notes, and for **rollcage damage**: photos and
  the damaged parts marked on the 3D model.
- **The roll cage itself** (Parts 2–6): the same checklist, live 3D model and
  Frog Safety score as the Rollcage assessment tool.

Sanctioning bodies: NASA Rally Sport, ARA and CARS (full FIA 253 checklist,
new construction or grandfathered rules), plus SCCA ProRally, Rally America
and FIA passport (documentation only for now — no automatic compliance check).

## Two sites, one app

The same deployment serves two addresses, and the address picks the site
(`config.js`, `window.APP_SITE`):

- **logbook.frogracing.us** — Digital logbooks: create a new logbook, the
  logbook library, sanctioning bodies.
- **scrutineering.frogracing.us** — Scrutineering: each car's tech sheet at
  an event, event admin (events, staff, tech sheets, competitors and the
  MotorsportReg import), sanctioning bodies.

Both share the accounts, scrutineer accreditations and data (one Supabase
project); each home links to the other site. To add the second address, add
`scrutineering.frogracing.us` as a domain of this Vercel project (and its DNS
record), and in Supabase add it under Authentication → URL Configuration →
Redirect URLs. Locally, `?site=scrutineering` (or `?site=logbook`) picks the
site for that browser tab.

## How it's built

This app is the shared Frog Racing roll cage app (the
[rollcage-app](https://github.com/cecchet/rollcage-app) repo, which is also
rollcage.frogracing.us), configured for logbooks. That repo is included here
as the `core` git submodule; this repo only adds:

| File | Purpose |
|---|---|
| `config.js` | `window.APP_CONFIG` — logbook mode, names, sanctioning bodies offered (see `CFG` at the top of `core/app.js`) |
| `index.html` | **Generated** from `core/index.html` by `tools/build-index.js` (runs the shared page under `<base href="core/">`, with this app's title, icons, manifest and config) |
| `manifest.webmanifest`, `sw.js`, `icons/` | Installable app (Android "Install app" / iPhone "Add to Home Screen") and offline support |
| `api/analyze-cage.js` | Serves the shared AI photo-analysis function from this app's `/api/` |

No build step beyond that: it's a static site plus one serverless function.

## The Scrutineering user manual

`scrutineering-user-manual.html` (the Scrutineering site's "User manual"
button, `manualUrl` in `config.js`) is built from `tools/manual/manual.md`
and screenshots of the site, taken in headless Chrome with
`tools/manual/demo-server.js` standing in for the server (a made-up club,
event and scrutineers -- no account, no real people). With this repo served
on port 5002 (`npx serve . -l 5002`), in `tools/manual/`:

```bash
rm -rf profile out
node driver.mjs screenshots.mjs 1280 900
node build-html.mjs manual.md ../../scrutineering-user-manual.html
```

Edit `manual.md` for the text; a screenshot is `![caption](file.png)`, from
`out/`.

## Updating to a newer core

```bash
git submodule update --remote core
node tools/build-index.js
git add core index.html
git commit -m "Update core"
```

Clone with `git clone --recurse-submodules` (or run
`git submodule update --init` after cloning).
