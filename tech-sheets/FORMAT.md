# Tech sheet templates — format (version 1)

A tech sheet template describes one sanctioning body's tech inspection form:
what is inspected, who inspects it (the scrutineer, or the team itself) and
what is accepted. The same file drives both apps:

- **Digital logbooks** (scrutineers, technical directors): the scrutineer
  fills or reviews a car's sheet at an event; a technical director edits
  their body's template (Admin mode).
- **PassTech** (competitors): the competitor pre-fills the sheet — personal
  gear lines from My gear — with photos, and submits it to the event (or
  exports it as a file the scrutineer imports).

Built-in templates live in `templates/<id>.json`; the server seeds them as
the library a body starts from (see `supabase/migrations`).

## Template

```jsonc
{
  "format": 1,
  "id": "ara-2021-06",                 // stable key: <body>-<form revision>
  "bodyId": "ara",                     // the logbook app's sanctioning body id
  "passtechRulesetIds": ["ara-performance-rally"], // PassTech rulesets this sheet serves
  "title": "ARA Tech Form",
  "revision": "2021-06",               // the paper form's own revision
  "source": {                          // where the items and accepted values come from
    "form": "ARA Tech Form 2021-06 (revised 5/21/2021)",
    "rules": "ARA Rally Technical Rules, 2026 Edition"
  },
  "instructions": "Teams inspect items marked team; the scrutineer checks safety items.", // optional
  "variants": [                        // optional: car types, each with its own item set, e.g. NEHA "X car"
    { "id": "standard", "label": "Standard" },
    { "id": "x", "label": "X car",
      "classes": ["X"],                // optional: the event classes that get this version (case-insensitive);
                                       //   a car in no listed class gets the first variant
      "codriver": false }              // optional: true when cars in these classes carry a co-driver (e.g.
  ],                                   //   hillclimb R1/R2) -- perOccupant items then get a line for each;
                                       //   otherwise one line (the driver's). Without variants: always both
  "header": [ /* Field[] -- event, car number, class, driver, VIN... */ ],
  "sections": [ /* Section[] */ ],
  "signoff": [                         // who signs, in order
    { "id": "scrutineer", "label": "Scrutineer", "license": true },
    { "id": "chief", "label": "Chief Scrutineer", "license": false }
  ]
}
```

## Field (header lines, and an item's extra values)

```jsonc
{
  "id": "class",
  "label": "Class",
  "type": "text" | "number" | "date" | "choice" | "multi",
  "options": ["R2U", "R2O", "R4U", "R4O", "EX"],   // choice / multi only
  "unit": "mm",                                    // number only, optional
  "prefill": "event" | "car_number" | "class" | "driver" | "codriver" |
             "make" | "model" | "year" | "vin" | "plate" | "logbook_body" | "logbook_number",
                                                   // optional: where an app fills it from
  "required": true                                 // optional
}
```

## Section and item

```jsonc
{
  "id": "personal",
  "title": "Personal Protection",
  "gearGroup": "driver",            // optional: the PassTech group the editor adds gear lines to
  "items": [
    {
      "id": "helmet",
      "label": "Helmet",
      "perOccupant": true,            // one line for the driver, one for the co-driver (in car classes
                                      //   with a co-driver -- see variants; else the driver's only)
      "checkedBy": "scrutineer",      // "scrutineer" (default) | "team"
      "gear": "helmet",               // optional: the PassTech EquipmentCategory it checks --
                                      // PassTech pre-fills it from My gear and checks it against
                                      // that ruleset; photos and tag photos attach here
      "standards": ["snell-sa2020", "fia-8860-2018"],
                                      // optional, with gear: the PassTech standard ids accepted
                                      // (picked in the editor from tech-sheets/gear-catalog.json)
      "noCert": true,                 // optional, with gear: also accepts it without certification
                                      // (stock/OEM belts or seat, plain fire-resistant clothing); its
                                      // label is the last of the options
      "accepts": "Snell SA2015/SA2020/SAH2020, FIA 8860-2010/2018, FIA 8859-2015/2024 ...",
                                      // what is accepted, in the scrutineer's words
      "rule": "ARA RTR 5.2.1",        // the rule it comes from (optional)
      "allowNA": false,               // "N/A" is an acceptable result (e.g. N/R on the SCCNH form)
      "variants": ["x"],              // optional: only on these variants (absent = all)
      "fields": [ /* Field[] -- values recorded with the item, e.g. expiration date */ ],
      "options": ["SA2015", "SA2020", "FIA 8860-2018"] // optional: tick-box list of what was seen
    }
  ]
}
```

A `perOccupant` item is shown twice ("Driver helmet", "Co-driver helmet")
with the result keys `helmet.driver` and `helmet.codriver`.

## Filled sheet (what a submission and an inspection record hold)

```jsonc
{
  "format": 1,
  "template": { "id": "ara-2021-06", "templateId": "<server uuid, if any>", "version": 3 },
  "variant": null,
  "header": { "event": "...", "car_number": "23", "class": "O4WD", ... },
  "competitor": {                     // what the team declared (PassTech pre-fill)
    "pictures": {                     // optional: the car (1 or 2) and crew, for the scrutineers
      "car": [ { "sha256": "..." } ],   //   (photos in the tech-sheet-photos bucket, like items' photos)
      "driver": { "sha256": "..." },
      "codriver": { "sha256": "..." }   //   only when the car carries a co-driver
    },
    "items": {
      "helmet.driver": {
        "declared": "Bell HP7, Snell SA2020, label 2021-03",  // text the team wrote / PassTech built
        "gear": { /* the PassTech EquipmentEntry it came from, optional */ },
        "values": { "expires": "2031-03" },
        "photos": [ { "sha256": "...", "kind": "item" | "tag" } ]
      }
    },
    "submittedAt": "2026-10-13T12:00:00Z",
    "by": "driver@example.com"
  },
  "inspection": {                     // the scrutineer's results
    "items": {
      "helmet.driver": { "result": "pass" | "fail" | "na", "note": "...", "values": {},
        "gear": { /* the gear details as checked: a PassTech EquipmentEntry (certifications with
                     their dates, extinguisher units...), starting from the team's -- judged by
                     passtech-engine.js (built by PassTech) for the "PassTech:" verdict */ },
        "seen": ["..."],              // what was ticked on the options list
        "photos": [ { "sha256": "...", "kind": "item" } ] }   // the scrutineer's own photos
    },
    "corrections": "Replace driver gloves before stage 1",
    "result": "pass" | "fail",
    "signatures": { "scrutineer": { "name": "...", "license": "...", "at": "..." } }
  }
}
```
