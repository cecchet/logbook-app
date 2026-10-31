# Digital logbooks

## Getting started

Digital logbooks (logbook.frogracing.us) keeps a car's rollcage logbook online. A scrutineer records the cage after inspecting it and issues the logbook; from then on its log collects the car's tech inspections, and the owner can open it from anywhere, show it with a link, or have it scanned from a QR sticker on the cage.

It works hand in hand with two other Frog Racing tools:

- **The Rollcage assessment tool** (rollcage.frogracing.us): owners and builders describe a cage there and export it to a file, which you import here to start its logbook. Parts 2 to 6 of a logbook are the same as in that tool: see its [user manual](https://cecchet.github.io/rollcage-app/rollcage-user-manual.html).
- **Scrutineering** (scrutineering.frogracing.us): tech inspection at events. Passing a car that has a digital logbook records the inspection in its log.

### Signing in

There's no password. Enter your email address and press **Email me a sign-in link**; open the link in that email on the same device, or type the code it contains. You stay signed in on that device until you sign out.

Without signing in, **Open the logbook library** still opens the logbooks saved on this device.

![The sign-in screen.](L02-signin.png)

Who can do what depends on your email:

| Who | What they can do |
|---|---|
| Car owners | prepare their car's logbook for the scrutineer, see their cars in My garage, share a car's public link |
| Scrutineers | issue logbooks, find any logbook online, print its QR sticker, upload changes made to a cage |
| Technical directors | all of the above, and manage their sanctioning body's scrutineers (see the Scrutineering site's manual) |

### The home screen

Once signed in, the home screen shows one card per mode: **Create a new logbook**, **Logbook library**, and for technical directors **Sanctioning bodies, scrutineers and tech sheets**. The bar at the top shows who you're signed in as and your accreditations. **← Home** at the top of each mode brings you back here. Event scrutineering and event admin are on the Scrutineering site; the link under the cards opens it.

![The home screen of a technical director.](L01-home.png)

### Saving your work

A logbook you're working on is saved in this browser, on this device, when you press **Save on this device**; nothing is sent online until it's issued. **Export to a file** downloads it, with its photos, to hand to someone else or to keep as a backup. Reloading or closing the page with unsaved changes asks you first.

## Creating a logbook

**Create a new logbook** starts one, in one of three ways:

- **Start a blank logbook**.
- **Start from a cage template**: opens the cage templates (design templates, rollcage kits and real cars) to start from a copy of one. Your saved and issued logbooks aren't offered here: an issued logbook is never the start of a new one.
- **Import a file**: a file exported from the Rollcage assessment tool, or from this site. This is how a car owner's own description of the cage, with its pictures, becomes a logbook.

![Create a new logbook.](L10-create.png)

![Starting from a cage template.](L11-templates.png)

The logbook then opens below the panel, in parts like the Rollcage assessment tool:

| Part | What it holds |
|---|---|
| Part 1 — Logbook information and Pictures | the vehicle, the sanctioning body, the owner, builder and inspector, the logbook details, and the pictures |
| Parts 2 to 6 | the cage: design, tubing, installation, welds, seats and belts, checked against the sanctioning body's rules |
| Part 7 — Log | the car's events, repairs and cage updates, once the logbook is issued |

A car owner prepares the logbook the same way, then brings this device to the inspection or sends the scrutineer the file (**Export to a file**): the scrutineer issues it.

### Logbook information

Part 1 starts with the vehicle and its sanctioning body. A body with a rulebook offers two kinds of logbook:

- **New logbook**: a new construction, checked against the current rules.
- **Existing logbook**: one already issued on paper. Nothing is checked against the rules; instead you record its original issue date, photos of every page of the paper logbook, and its past events, which all go online with it.

Then come the owner, the builder and the inspector, the issue date and the logbook number, and whether a paper logbook was issued too (with photos of its pages, if you like).

The fields a logbook can't be issued without are outlined in red with what's missing under them, until they're filled in: the sanctioning body, the vehicle's manufacturer, model and year, the owner's name and email, and the logbook number (for an existing logbook, also its original issue date and its paper pages). An email address that isn't valid says so.

![Required fields: a missing owner name and a mistyped email.](L13-required.png)

### Pictures and AI processing

Pictures works as in the Rollcage assessment tool: vehicle pictures, rollcage pictures by category, each tagged with the cage elements it shows. Its **AI processing (beta)** box holds the tools that use a vision model: the video walk-around, bulk upload with automatic sorting, and AI analysis of several pictures at once.

These features send your pictures over the internet to Google's Gemini AI vision model to be analyzed. Don't use them if you want all your data to stay on your device.

![The AI processing box.](L14-ai.png)

## Issuing a logbook

Scrutineers see **Ready to issue?** above the logbook: everything it still needs, with a **Go** button that jumps to the field or question and puts the cursor in it. The sanctioning body must be one you're accredited by, with the permission to issue its logbooks. For an ARA logbook, a **Use** button suggests the number from your scrutineer code and the end of the VIN.

![Ready to issue? with what's still missing.](L12-ready.png)

Once everything has a tick, **Issue logbook** asks you to confirm, uploads the logbook's photos and records it online. It gets its digital number (like FL-7KQ2-M9XD), and the owner can sign in with their email to see it. The record can't be edited afterwards, only added to.

After that, the panel shows **Issued as** with its number. Changes made to the cage later are uploaded from the Logbook library (**Upload changes**), as an amendment.

## The log

Part 7 — Log is the car's logbook pages: every entry, newest first.

- **Events**: each event the car entered, with its tech inspection result, the scrutineers, notes and photos. Inspections recorded on the Scrutineering site appear here on their own when the logbook is refreshed. If the rollcage was damaged, tick it, add photos and mark the damaged parts on the 3D model: they show in red, on the cage's own bars.
- **Repairs**: what was repaired, when and by whom, notes, photos, the repaired parts marked on the 3D model (in green), and the scrutineer who checked the work.
- **Cage updates**: an added bar or a changed design, recorded the same way. Update the design in Parts 2 to 6 to match, so the logbook shows the cage as it is now.

![The log: a repair being added, and an earlier event.](L24-log.png)

Entries you add here are saved with the logbook on your device and in its exported file. Except for an existing logbook's past events, which go online when it's issued, they aren't part of the online logbook yet.

## The logbook library

**Logbook library** lists the logbooks you can open:

- **On this device**: the logbooks saved in this browser, each with whether it's **Up to date**, **Changed on this device**, **Newer online** or only on this device. **View the rollcage** and **View the event log** open it; **Refresh** brings in what's newer online; **Upload changes** sends cage changes made here (scrutineers); **Issue online** issues a logbook that isn't online yet; **QR sticker** prints its sticker (scrutineers); **Delete** removes it from this device. **Check for updates** compares them all with the online logbooks, and **Refresh all** updates every one that's out of date.
- **My garage**: for car owners, the cars whose logbook lists your email. **Save to this device** downloads one; **Copy public link** and **Open public view** share it.
- **Find a logbook online** (scrutineers): search by number, VIN, owner, car, make, model or year, or **Scan a QR sticker**. Each result can be saved to this device or opened.

Download the logbooks you'll need before going where there's no signal: a logbook on this device opens without a connection.

![The Logbook library: a logbook on this device, and a search.](L20-library.png)

### QR stickers

A logbook's QR sticker goes on the cage. **QR sticker** prints it: on a label printer (through the print dialog, or a label maker's own app with the saved images) or on a sheet to cut out. Each logbook keeps the same sticker; printing it again gives the same code.

![Printing a logbook's QR sticker.](L22-sticker.png)

Scanning the sticker with any phone camera opens the logbook's public view, as its owner allows, without signing in. In **Find a logbook online**, **Scan a QR sticker** uses the camera, a photo of the sticker or its code typed in, and lists that logbook.

![Scanning a sticker.](L23-scan.png)
