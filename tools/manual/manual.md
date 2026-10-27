# Scrutineering

## Getting started

Scrutineering (scrutineering.frogracing.us) is where scrutineers, chief scrutineers and technical directors run tech inspection: each car's tech sheet at an event, its sign-off and its tech stickers, the season's annual safety stickers, the events themselves, and each sanctioning body's scrutineers and tech sheets.

It works hand in hand with two other Frog Racing tools:

- **PassTech** (passtech.frogracing.us), the competitors' side: they keep their gear in My gear, pre-fill their car's tech sheet with it (with photos) and submit it to the event, and apply for annual stickers. What they submit shows up here, ready to check.
- **Digital logbooks** (logbook.frogracing.us): the cars' logbooks. Passing a car that has a digital logbook records the inspection in its logbook.

### Signing in

There's no password. Enter your email address and press **Email me a sign-in link**; open the link in that email on the same device, or type the code it contains. You stay signed in on that device until you sign out.

![The sign-in screen.](02-signin.png)

Only people with a scrutineer accreditation can use the site: ask your sanctioning body's technical director to add you (see Sanctioning bodies, scrutineers and tech sheets). Signed in without one, the site says so.

### The home screen

Once signed in, the home screen shows one card per mode you can use, numbered like PassTech's options:

| Mode | Who sees it | What it's for |
|---|---|---|
| Scrutineering | every accredited scrutineer | the events you're on the staff of: each car's tech sheet, its sign-off and stickers |
| Annual safety stickers | scrutineers allowed to issue them | season stickers for helmets, HANS, seats, fire extinguishers and suppression systems, outside an event |
| Event admin | technical directors | creating events, their staff, tech sheets and competitors |
| Sanctioning bodies, scrutineers and tech sheets | technical directors, and scrutineers allowed to manage scrutineers | the body's disciplines, scrutineers, licenses, permissions and tech sheets |

The bar at the top shows who you're signed in as and your accreditations (for example "Demo Rally Club technical director"). If your license has expired, a warning says so: ask your technical director to renew it. **← Home** at the top of each mode brings you back here, and **User manual** in the header opens this manual.

![The home screen of a technical director.](01-home.png)

### Installing it on your phone

The site works in any browser, and can be installed like an app: on Android, open the browser menu and choose **Install app** (or **Add to Home screen**); on an iPhone or iPad, tap **Share**, then **Add to Home Screen**. It then opens full screen from its own icon, which is handy in the paddock.

## Scrutineering at an event

The Scrutineering mode lists the events you're on the staff of, the next one first, then the past ones. Each card shows the event's dates, your role (scrutineer or chief scrutineer) and how far inspection has got: passed cars in green, failed in red, and how many are left. An event marked **open** is in its scrutineering window.

![Your events.](10-events.png)

### The event page

Click an event to open it. Under its name and dates, the cars are grouped by where they stand:

- **Checked -- waiting for sign-off**: every line of the car's sheet has a result; open it and finish it as Passed or Failed.
- **Ready for re-tech**: the car failed, then the team corrected what failed and re-submitted its sheet from PassTech; only the lines they changed need checking again.
- **To inspect**: the cars still to inspect.
- **Passed** and **Failed**: the cars signed off.

Each car shows its number, its crew, the car and its logbook number, and its class. Badges tell you more: **team sheet** when the team pre-filled its sheet in PassTech, how many lines are checked ("18/57 checked"), and **open: (email)** when another scrutineer has the car's sheet open on their device. **Find a car** filters the lists by car number, driver, car or logbook number.

![An event's cars, grouped by where they stand.](11-event.png)

The chief scrutineer can also add a late entry from here with **Add competitor** (see Event admin). Teams that submitted a sheet for a car number that isn't on the competitor list yet are listed above the cars, so the chief scrutineer can add them.

### A car's tech sheet

Click **Tech sheet** on a car to open its sheet. If the event uses a different sheet for some classes, the car gets the sheet listing its class; when that isn't clear (no class, or a class no sheet lists) you pick the sheet. While you have a car's sheet open, the team can't re-submit it from PassTech, and other scrutineers see it as open on your device.

At the top: **Save**, **Finish: Passed**, **Finish: Failed** and **Close** (the same buttons are repeated at the bottom of the sheet), a count of the lines passed, failed and still to check, and where the team's part came from. Then come the sheet's instructions, the pictures of the car and crew the team sent (add your own with **Add**), and the header: event, car number, crew, car, VIN and so on, filled in from the competitor list, the car's logbook and the team's sheet.

![The top of a car's tech sheet, as the team submitted it from PassTech.](12-sheet-top.png)

The summary box lists every line still to check (and the failed ones first); **Show all** lists them all, and clicking one takes you to it. Below it, the sheet's sections, each with how many of its lines are checked.

![The summary: what's failed and what's left to check.](14-sheet-summary.png)

### Checking a line

Each line shows what the sheet accepts, then what the team declared, its photos (the item, and its certification tag), and **Pass** / **Fail** (and **N/A** where the sheet allows it). A line can also hold values (a date, a size), a note, and your own photos (**Add photo**, **Add tag photo**).

On a gear line (helmet, HANS, suit, seat, harness, extinguisher...), PassTech checks the gear details against the rules: its verdict shows next to the line's name (**PassTech: OK**) and in a box under the details. The details start from the team's declaration: correct them if the item in hand says otherwise -- the certification, the label date, the serial number -- and the verdict updates. **Scan tag photo** reads the certification off a photo of the tag; **Scan a sticker** reads the item's tech sticker, if it already has one.

![A gear line: the team's helmet, its photos, and PassTech's verdict.](13-sheet-line.png)

Click a photo to see it full screen; click the image to zoom in, use ← / → for the line's other photos, and Esc (or a click around it) to close.

![A photo, full screen.](17-photo-viewer.png)

A line marked Pass folds up, so the sheet shrinks to what's left. A line marked Fail needs a note saying what's wrong.

### Saving and signing off

**Save** keeps the sheet as it is, to finish later or on another device; a scrutineer can fill a sheet in and save it from the moment it's created, even before scrutineering opens. If you close a sheet, open another car or leave the mode with unsaved changes, the site asks whether to save them.

When every line has a result, finish the sheet:

- **Finish: Passed**: no line may be marked Fail. If some lines aren't checked yet, the site asks whether to pass the car anyway. The car moves to Passed and, if it has a digital logbook, the inspection is recorded in it.
- **Finish: Failed**: mark the lines that fail, or write the **Corrections required** at the bottom of the sheet. The team sees them in PassTech, fixes the car and re-submits the lines they changed; the car then shows under Ready for re-tech, with those lines marked "updated by the team".

Either way you're asked to confirm, and the sheet is signed with your name and license. The chief scrutineer can tick **Also sign as chief scrutineer** to sign both. A signed sheet is read-only.

Passed / Failed can be recorded during the event's scrutineering window only: from the day scrutineering starts until the day after the event ends. Signing off needs the **Sign off tech sheets** permission; without it you fill the sheet in and save it, and a scrutineer who has it records Passed or Failed.

![The bottom of the sheet: corrections, sign-off, the team's file, and the car's stickers.](16-sheet-bottom.png)

**Import the team's sheet (file)** brings in a sheet the team exported from PassTech as a file (for a team that couldn't submit it online): their declarations and photos come into the open sheet. Save to keep them.

### Tech stickers at the event

Below the sheet, the **Stickers** box lists what can get a printed QR-code sticker: each helmet, HANS, seat, fire extinguisher and suppression system line, and the car itself (its tech pass). Scanning a gear sticker later shows the item's photos and certification, so the next scrutineer can check it at a glance.

A gear line gets its sticker once it's marked Pass and has a photo of the whole item and one of its tag; until then the box says what's missing. The car's tech pass comes once the sheet is finished as Passed. Save the sheet before issuing stickers.

![A passed car's stickers.](18-sheet-stickers.png)

**Issue sticker** issues it and opens the print dialog; **Print** prints it again; **Void** cancels it (for a lost or damaged sticker, or an item that failed later), saying why -- you can then **Re-issue** a new one. **Print all** prints the car's stickers in one go, and **Print the event's stickers** on the event page prints every sticker issued at the event.

### Printing stickers

The print dialog shows the stickers and where to print them:

- a label printer with a 62 mm roll (e.g. Brother QL), or 2 in or 1 in square labels (1 in fits on a helmet);
- a Letter sheet of 1.5 in stickers to cut out;
- images (PNG), saved to disk or shared to a label maker's own app.

A label printer prints through the browser's print dialog: on a laptop through its driver, on a phone through AirPrint (iPhone) or its maker's print plugin (Android). The site remembers your choice.

![The print dialog.](19-print-dialog.png)

### Events without a tech sheet

An event whose body has no tech sheet yet works the simple way: each car with a logbook gets **Passed** and **Failed** buttons, with a note, and the result is recorded in its logbook.

### Working offline

Paddocks often have little or no signal. Before the event, while you have a connection, open the event and tap **Download for offline** in its **Offline copy** box. Your device then keeps:

- the event, its cars and their tech sheets;
- the stickers valid there, both those issued at the event and the accepted bodies' annual stickers for the season;
- copies of their photos;
- 30 sticker codes reserved for you, so you can print stickers without a connection.

While you're online, the copy refreshes itself every few minutes. Open the site once online on the device you'll use, so it can start without a connection.

With no connection, the site says **Offline** and works from that copy:

- **Tech sheets** open and save as usual. A sheet saved offline shows **not synced** until it reaches the server. You can also finish a sheet as Passed or Failed offline: it's signed at the time you did it.
- **Photos** you add stay on the device until it syncs.
- **Stickers** print under your reserved codes, and the box shows how many are left. Voiding a sticker needs a connection.
- **🔳 Check a sticker** on the event page checks a sticker against the copy. The result says it was checked offline and when the copy was made: a sticker voided since then still shows as valid.

Once the connection is back, everything saved offline syncs on its own, in order. **Sync now** forces it. Sync within three days: the server refuses changes made offline longer ago than that.

If another scrutineer, or the team re-submitting, changed a sheet on the server in the meantime, your version doesn't overwrite theirs. The car shows **conflict**, and **Couldn't sync** lists it:

1. Tap **Compare and resolve**.
2. For each line that differs, pick the server's version or this device's. **Keep all the server's** and **Keep all this device's** pick them all at once.
3. If you finished the sheet offline, tick the box to also sign it off, so a verdict is never applied without your say. Then **Save**.

A sheet already signed off on the server can't take your changes: discard them. The same check applies online: a save that would overwrite someone else's change opens the same comparison.

**Remove from this device** deletes an event's copy. Copies also go two days after the event ends, and when you sign out (except changes still waiting to sync), since they hold people's names and photos.

## Annual safety stickers

Some bodies check personal gear once a season instead of at every event: the helmet, HANS, seat, fire extinguisher and suppression system get a season sticker, and scrutineers at events just scan it. The Annual safety stickers mode issues those stickers, outside any event.

Pick the **Sanctioning body**, its **Discipline** if it has several (a sticker is good for that discipline's events) and the **Season**. Then three tabs: Issue a sticker, Applications (from PassTech) and the stickers already issued.

Stickers and applications from before a body had disciplines belong to none of them. If you're accredited for all of the body's disciplines, pick **No discipline (older stickers)** to see them: you can view, print and void those stickers, and decline those applications, but not issue new ones.

![Annual safety stickers: which gear?](20-annual.png)

### Issuing a sticker

On **Issue a sticker**, pick the gear: Helmet, HANS / head & neck restraint, Seat, Fire extinguisher or Fire suppression system. Fill in the **Owner** (shown to scrutineers only), then check the item in hand: its certification and details, as on a tech sheet line, with PassTech reading the tag from a photo if you like. A sticker needs a photo of the whole item and one of its tag or label. **Issue the sticker** issues it and opens the print dialog.

**Read last season's sticker** scans the QR code of the sticker the item already has: its details and photos fill the new one in. Last season's sticker simply expires with its season; a sticker of the same season (one that's damaged, say) is voided, replaced by the new one.

### Applications from PassTech

Competitors can apply for an annual sticker from My gear in PassTech, with their gear's details and photos. The **Applications** tab lists the ones waiting, with who sent them and when.

![Applications from PassTech.](21-annual-applications.png)

**Review and issue** opens the application as a sticker to issue: the competitor's details and photos come in, ready to check against the item in hand and correct. Then **Issue the sticker**, or **Decline**, saying why -- the competitor sees your note in PassTech.

![Reviewing an application.](22-annual-review.png)

### Issued stickers

The third tab lists the stickers issued for the season, newest first. **Search** finds them by anything they hold: the code, the owner, who submitted the application, who issued it, the standard, the serial number. **Gear** narrows the list to one kind, and **Every season** includes the earlier seasons too.

![Searching the issued stickers.](24-annual-search.png)

**View** opens a sticker's record right in the list: its status, the gear's photos (click one to zoom in) and certification, and who issued it. **Print** prints it again; **Void** cancels it, saying why.

![An issued sticker's record.](23-annual-issued.png)

## Scanned stickers

Every sticker's QR code opens this site on the sticker: anyone can scan it with a phone camera. The page says whether the sticker is **VALID**, **EXPIRED** (an event that's over, a past season) or **VOID** (and why), and for gear: what it's for, its photos and certification, and who inspected it. The owner's name is only shown to scrutineers. A scrutineer of the body allowed to void stickers can **Void this sticker** from here.

A logbook sticker opens the car's logbook page instead.

![A scanned helmet sticker, as a scrutineer sees it.](50-sticker.png)

## Event admin

Event admin is for technical directors: creating events, and for each one its staff, tech sheets and competitors. It lists the events you organize, like the Scrutineering mode.

### Creating an event

**Create new event** opens the form:

- **Sanctioning body**, and its **Discipline** if it has several: the event's scrutineers sign under their accreditation for it.
- **Name** and **Location**.
- **Scrutineering starts**, **Event starts** and **Event ends**: Passed / Failed can be recorded from the day scrutineering starts until the day after the event ends.
- **Also accepts logbooks from**: the other bodies whose logbooks are good for this event.

![Creating an event.](30-admin-events.png)

After **Create event**, the event opens on its **Admin** tab: add its staff and pick its tech sheet, then its competitors. **Edit event** changes it later.

### Staff and tech sheets

The **Admin** tab holds the event, its staff and its tech sheets.

- **Staff**: add the chief scrutineer and the scrutineers working the event by email, each with their role. A scrutineer whose accreditation can't sign off tech sheets shows **can't sign off**: they fill sheets in, someone else records Passed / Failed. The event warns you if nobody on its staff can sign off.
- **Tech sheets**: the event uses its body's sheet by default. **Change tech sheets** picks the sheet, or several -- one per group of classes (for example a separate sheet for historic cars): list each sheet's class codes, comma-separated; a sheet with no classes is for all the others. **Use the body's default** goes back to the body's sheet.

![An event's Admin tab.](33-admin-event.png)

![Two tech sheets for one event, by class.](34-admin-sheets.png)

Teams pick the event's sheet in PassTech to pre-fill it and submit it.

### Competitors

The **Competitor management** tab lists the event's competitors, with their email. Add them one at a time with **Add competitor** -- car number (required), driver, co-driver, class, email, and the car's digital logbook number, or its make, model and year when it has none -- or all at once from MotorsportReg.

![An event's competitors.](31-admin-competitors.png)

**Bulk import from MSR**: in MotorsportReg, export the event's entry list as CSV (with the number, name, email, year, make, model, color and class columns), then **Choose the CSV file**. Nothing is saved until you've seen the list:

- names in capitals or lower case are tidied up ("CASEY RIVERA" becomes "Casey Rivera");
- a car already entered is updated, keeping its logbook and tech status (**update**), or shows **replaces** if it was entered for another driver;
- a number taken twice, or a row without a number, is marked in red: change the number or untick the row;
- registrations still **new** (not confirmed) in MotorsportReg can be skipped in one click.

Then **Import** the competitors.

![Checking a MotorsportReg entry list before importing it.](32-admin-msr.png)

## Sanctioning bodies, scrutineers and tech sheets

This mode is for technical directors, and for scrutineers allowed to manage scrutineers. It lists the bodies you manage; click one to open it, on its **Scrutineers** tab (technical directors also get a **Tech sheets** tab).

![The bodies you manage.](40-bodies.png)

### Disciplines

A body with several disciplines (say Rally and Autocross) gives each its own events, scrutineers and annual stickers. **Add a discipline** with a short id (e.g. autox), its name (Autocross) and what its stickers say (AUTOX). A discipline you no longer use can be archived. A body without disciplines works as one.

### Scrutineers

The table lists the body's technical directors and scrutineers: their discipline ("All" works every discipline), license number and expiry, scrutineer code, permissions and status (active, license expired, disabled).

![A body's disciplines and scrutineers.](41-body.png)

**Add a scrutineer** with their name and email, the discipline they're accredited for, their license number and expiry date (optional) and scrutineer code. They sign in with that email.

![Adding a scrutineer.](42-body-add.png)

On each row: **Renew** sets the license's new expiry date (or none); **Permissions** changes what they may do; **Disable** stops them signing anything new (**Re-enable** undoes it); **Delete** removes them. What they signed before stays valid.

### Permissions

A technical director holds every permission. A scrutineer gets the standard five unless you choose otherwise:

| Permission | Lets them | Standard scrutineer |
|---|---|---|
| Sign off tech sheets | finish a car's sheet as Passed or Failed | yes |
| Issue annual stickers | use Annual safety stickers | yes |
| Void stickers | void a sticker | yes |
| Issue logbooks | issue a car's digital logbook | yes |
| Add logbook entries | record events in a logbook | yes |
| Add scrutineers | add scrutineers to the body | no |
| Renew licenses / disable | renew licenses, disable and re-enable scrutineers | no |
| Edit permissions | change scrutineers' permissions | no |
| Delete scrutineers | delete scrutineers | no |

You can only grant the permissions you hold yourself, in that discipline; the others can't be ticked. **Standard scrutineer** puts a scrutineer back on the standard five.

![Editing a scrutineer's permissions.](43-body-permissions.png)

### The body's tech sheets

The **Tech sheets** tab lists the body's own sheets, each with its version, number of lines and last update, and whether it's **Public** (also listed in PassTech as the body's generic tech sheet, for competitors to pre-fill without an event) or **Private** (only used by the events it's attached to). Without a sheet of its own, the body's events use the automatic tech sheet built from its ruleset in PassTech, if it has one.

![A body's tech sheets.](44-body-sheets.png)

**Start a new tech sheet** offers a blank sheet, the automatic sheet from the body's ruleset, or a copy of an existing sheet (the body's own, or another body's). **Edit** changes a sheet; **Copy** starts a new one from it.

### Editing a tech sheet

The editor holds everything the sheet asks:

- **Preview the sheet** shows it as scrutineers will see it; **Back to editing** returns.
- **Title**, the paper **Form revision**, and the **Instructions** shown at the top (for example the team's declaration).
- **Car classes**: a version of the sheet for some of the event's classes (e.g. X cars), each with the class codes it's for and whether those cars carry a co-driver. Leave it empty when every car gets the same sheet.
- **Gear checked**: the PassTech gear categories, as the body's rules require them (required, conditional, recommended). Click one to add its line to the sheet, with the standards the rules accept, or to edit it. Competitors' gear is pre-filled into those lines from My gear, and PassTech checks it.
- The **sections** and their **items**: click a section to edit it. Each item has its label, who checks it (the scrutineer or the competitor), whether it's one line per occupant (driver and co-driver), whether N/A is allowed, what's accepted, and the rule it comes from. When rule numbers can be found from the body's rules, the editor offers to fill them in.

**Save tech sheet** saves it as a new version; **Cancel** throws the changes away.

![Editing a tech sheet.](45-sheet-editor.png)

## Getting help

Questions, problems or ideas: email info@frogracing.us. If something doesn't look right, say which page you were on and what you did -- a screenshot helps.

### Frequently asked questions

**I don't get the sign-in email.** Check your spam folder, and that you typed the address your technical director registered. You can also type the code from the email instead of opening its link.

**I can't press Finish: Passed.** Either scrutineering for the event hasn't opened yet (save the sheet and finish it then), the event is over, the sheet is already signed, or your accreditation doesn't have the Sign off tech sheets permission.

**A team says it submitted its sheet, but the car isn't on the list.** Teams submit by car number: their sheet shows above the cars as "Tech sheets from teams not on the competitor list yet". The chief scrutineer or the technical director adds the car with Add competitor, and its sheet is there.

**Someone else has the car's sheet open.** The car shows "open: (their email)". The lock lasts 15 minutes after they last had it open, so it frees itself if they forget to close it.

**A sticker was lost or damaged.** Void it, saying why, then issue a new one: on the car's tech sheet (Re-issue) or in Annual safety stickers.
