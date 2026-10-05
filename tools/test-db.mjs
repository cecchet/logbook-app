// Runs the Supabase migrations in an in-process PostgreSQL (PGlite) and
// checks the roles, access rules and logbook chain, acting as each kind of
// user the way Supabase does (role anon / authenticated + the JWT claims).
//   npm install && npm run test:db
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");

const db = new PGlite({ extensions: { pgcrypto } });

// What a Supabase project already has before our migrations run.
await db.exec(`
  create schema extensions;
  create schema auth;
  create role anon nologin;
  create role authenticated nologin;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant usage on schema auth, extensions, public to anon, authenticated;
  grant execute on function auth.jwt() to anon, authenticated;
  -- Supabase Storage's tables (just what the access rules use).
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, created_at timestamptz default now());
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated;
  grant select, insert, update, delete on storage.objects to anon, authenticated;
`);
for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
  await db.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
}

// Run fn(query) as a signed-in user (email) or anonymously (null).
async function as(email, fn) {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(email ? { email } : {})]);
    await tx.exec(`set local role ${email ? "authenticated" : "anon"}`);
    return fn((sql, params) => tx.query(sql, params).then((r) => r.rows));
  });
}
const rpc = (email, fn, args = []) =>
  as(email, (q) => q(`select ${fn}(${args.map((_, i) => "$" + (i + 1)).join(", ")}) as r`, args).then((rows) => rows[0].r));

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log("  ok    " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n        " + e.message); }
}
async function refused(name, fn, pattern) {
  try { await fn(); failed++; console.log("  FAIL  " + name + " (was allowed)"); }
  catch (e) {
    if (pattern && !pattern.test(e.message)) { failed++; console.log("  FAIL  " + name + " (wrong error: " + e.message + ")"); return; }
    passed++; console.log("  ok    " + name + " -- refused: " + e.message.split("\n")[0]);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const ADMIN = "admin@frog.test", TD = "td@ara.test", S1 = "s1@ara.test", MULTI = "multi@scrut.test";
const OWNER = "owner@car.test", BUYER = "buyer@car.test", STRANGER = "stranger@nowhere.test";

console.log("Administration");
await db.query("insert into admins (email) values ($1)", [ADMIN]);
await check("admin creates sanctioning bodies", async () => {
  await rpc(ADMIN, "save_body", ["ara", "American Rally Association", "Scrutineer code + last 6 of the VIN"]);
  await rpc(ADMIN, "save_body", ["nasa", "NASA Rally Sport", "Pre-printed logbook number"]);
});
await refused("a stranger can't create a body", () => rpc(STRANGER, "save_body", ["x", "X"]), /not allowed/);
await check("admin appoints a technical director", () => rpc(ADMIN, "grant_accreditation", [TD, "Tech Director", "ara", "technical_director", "TD-1", "01"]));
await check("the technical director adds a scrutineer", () => rpc(TD, "grant_accreditation", [S1, "Sam One", "ara", "scrutineer", "L-77", "07"]));
await refused("a technical director can't appoint another director", () => rpc(TD, "grant_accreditation", ["x@y.test", "X", "ara", "technical_director"]), /not allowed/);
await refused("a technical director can't add scrutineers to another body", () => rpc(TD, "grant_accreditation", ["x@y.test", "X", "nasa", "scrutineer"]), /not allowed/);
await check("one person, accredited by two bodies", async () => {
  await rpc(ADMIN, "grant_accreditation", [MULTI, "Multi", "ara", "scrutineer", "A-1"]);
  await rpc(ADMIN, "grant_accreditation", [MULTI, "Multi", "nasa", "scrutineer", "N-1"]);
  const roles = await rpc(MULTI, "my_roles");
  assert(roles.accreditations.length === 2, "expected 2 accreditations, got " + roles.accreditations.length);
});
await check("a director sees their body's scrutineers only", async () => {
  const rows = await as(TD, (q) => q("select email, body_id from accreditations"));
  assert(rows.every((r) => r.body_id === "ara"), "saw another body's accreditations");
  assert(rows.some((r) => r.email === S1), "missing their scrutineer");
});

console.log("Issuing a logbook");
const issueRecord = {
  vehicle: { make: "Subaru", model: "Impreza", year: "2004" },
  owner: { name: "Pat Owner", phone: "555-0100" },
  cage: { answers: { vehicle_vin: { value: "JF1GD70625L512345" }, vehicle_builder: { value: "CAS" }, vehicle_owner_name: { value: "Pat Owner" }, roof_bars: { value: "253-12-1" } } },
  pictures: [{ sha256: "abc", category: "overview" }],
  paperPages: [{ sha256: "def" }],
};
let issued;
await check("a scrutineer issues a logbook", async () => {
  issued = await rpc(S1, "issue_logbook", [{ vin: "jf1gd70625l512345", body: "ara", ownerEmail: "Owner@Car.test", ownerName: "Pat Owner", bodyNumber: "07-512345", vehicle: issueRecord.vehicle, record: issueRecord }]);
  assert(/^FL-[0-9A-Z]{4}-[0-9A-Z]{3}.$/.test(issued.digitalNumber), "odd digital number " + issued.digitalNumber);
});
await check("the digital number's check character is valid", async () => {
  assert(await rpc(null, "digital_number_valid", [issued.digitalNumber]), "valid number rejected");
  const typo = issued.digitalNumber.slice(0, 4) + (issued.digitalNumber[4] === "X" ? "Y" : "X") + issued.digitalNumber.slice(5);
  assert(!(await rpc(null, "digital_number_valid", [typo])), "typo accepted: " + typo);
});
await refused("a second logbook for the same VIN", () => rpc(S1, "issue_logbook", [{ vin: "JF1GD70625L512345", body: "ara", ownerEmail: OWNER, record: {} }]), /already has a logbook/);
await refused("a stranger can't issue a logbook", () => rpc(STRANGER, "issue_logbook", [{ vin: "XYZ12345678", body: "ara", ownerEmail: OWNER, record: {} }]), /not an active scrutineer/);
await refused("a scrutineer can't issue for a body they aren't accredited by", () => rpc(S1, "issue_logbook", [{ vin: "XYZ12345678", body: "nasa", ownerEmail: OWNER, record: {} }]), /not an active scrutineer/);

console.log("Reading");
await check("the owner sees the car in My garage", async () => {
  const garage = await rpc(OWNER, "my_garage");
  assert(garage.length === 1 && garage[0].digitalNumber === issued.digitalNumber, "garage: " + JSON.stringify(garage));
  assert(garage[0].bodyNumbers.ara === "07-512345", "body number missing");
});
await check("the owner reads the full records", async () => {
  const rows = await as(OWNER, (q) => q("select body from records"));
  assert(rows.length === 1 && rows[0].body.owner.name === "Pat Owner", "owner can't read their record");
});
await check("any scrutineer can read logbooks (to inspect at events)", async () => {
  const rows = await as(MULTI, (q) => q("select id from logbooks"));
  assert(rows.length === 1, "scrutineer saw " + rows.length);
});
await check("a signed-in stranger sees nothing", async () => {
  const rows = await as(STRANGER, (q) => q("select id from logbooks union all select logbook_id from records"));
  assert(rows.length === 0, "stranger saw " + rows.length + " rows");
});
await refused("an anonymous visitor can't read the tables", () => as(null, (q) => q("select id from logbooks")), /permission denied/);

console.log("Append-only records");
await refused("writing a record directly", () => as(S1, (q) => q("insert into records (logbook_id, kind, body, author_email, accreditation_id, seq, hash) select id, 'note', '{}', $1, (select id from accreditations limit 1), 9, 'x' from logbooks", [S1])), /permission denied/);
await refused("editing a record, even as the database owner", () => db.query("update records set body = '{}'"), /append-only/);
await refused("deleting a record, even as the database owner", () => db.query("delete from records"), /append-only/);
await check("an amendment chains onto the issue record", async () => {
  const r = await rpc(S1, "add_record", [issued.id, "amendment", { note: "Harness bar added" }, "ara"]);
  assert(r.seq === 2, "seq " + r.seq);
});
await check("a scrutineer from another body can add a note", () => rpc(MULTI, "add_record", [issued.id, "note", { note: "Seen at NASA event" }, "nasa"]));
await check("every hash matches its content and the previous record", async () => {
  const rows = (await db.query("select seq, kind, body, created_at, author_email, prev_hash, hash, record_hash(prev_hash, kind, body, created_at, author_email) as recomputed from records order by seq")).rows;
  rows.forEach((r, i) => {
    assert(r.hash === r.recomputed, "record " + r.seq + " hash mismatch");
    assert(i === 0 ? r.prev_hash === null : r.prev_hash === rows[i - 1].hash, "record " + r.seq + " not chained");
  });
  assert(rows.length === 3, "expected 3 records");
});

console.log("Public link and privacy");
await check("the public link hides the owner, the VIN and paper pages by default", async () => {
  const pub = await rpc(null, "public_logbook", [issued.publicToken]);
  assert(pub.vin === "*****" + "*".repeat(6) + "512345", "vin shown as " + pub.vin);
  const body = pub.records[0].body;
  assert(!body.owner && !body.paperPages, "owner or paper pages leaked");
  assert(!body.cage.answers.vehicle_owner_name && !body.cage.answers.vehicle_vin, "owner name or VIN leaked in the answers");
  assert(body.cage.answers.vehicle_builder && body.pictures, "builder or cage photos missing");
  assert(pub.records.length === 3 && pub.records[2].author === "Multi", "records or authors missing");
});
await check("the owner chooses to show their name and the full VIN", async () => {
  await rpc(OWNER, "set_privacy", [issued.id, { owner: true, vin: "full", builder: false, cage_photos: false }, true]);
  const pub = await rpc(null, "public_logbook", [issued.publicToken]);
  assert(pub.vin === "JF1GD70625L512345" && pub.records[0].body.owner.name === "Pat Owner", "privacy not applied");
  assert(!pub.records[0].body.cage.answers.vehicle_builder && !pub.records[0].body.pictures, "builder or photos still shown");
});
await refused("a stranger can't change the privacy", () => rpc(STRANGER, "set_privacy", [issued.id, {}, true]), /not your logbook/);
await check("the owner turns the public link off", async () => {
  await rpc(OWNER, "set_privacy", [issued.id, {}, false]);
  assert((await rpc(null, "public_logbook", [issued.publicToken])) === null, "still public");
  await rpc(OWNER, "set_privacy", [issued.id, {}, true]);
});

console.log("Ownership transfer");
await check("a scrutineer records the sale", () => rpc(S1, "add_record", [issued.id, "transfer", { ownerEmail: BUYER }, "ara"]));
await check("the car moves to the buyer's garage, with its history", async () => {
  assert((await rpc(OWNER, "my_garage")).length === 0, "still in the old owner's garage");
  const garage = await rpc(BUYER, "my_garage");
  assert(garage.length === 1, "not in the buyer's garage");
  const rows = await as(BUYER, (q) => q("select seq from records"));
  assert(rows.length === 4, "buyer sees " + rows.length + " records");
});
await check("the old public link stops working", async () => {
  assert((await rpc(null, "public_logbook", [issued.publicToken])) === null, "old link still works");
});

console.log("Licenses that expire");
const S2 = "s2@ara.test", CHIEF = "chief@ara.test";
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
let s2acc;
await check("a scrutineer whose license has expired", async () => {
  s2acc = await rpc(TD, "grant_accreditation", [S2, "Sam Two", "ara", "scrutineer", "L-88", "08", day(-1)]);
  const roles = await rpc(S2, "my_roles");
  assert(roles.accreditations.length === 0 && roles.expired.length === 1, "roles: " + JSON.stringify(roles));
});
await refused("can't issue a logbook", () => rpc(S2, "issue_logbook", [{ vin: "WVWZZZ1JZXW000001", body: "ara", ownerEmail: OWNER, record: {} }]), /not an active scrutineer/);
await check("the technical director renews the license for a year", async () => {
  await rpc(TD, "renew_license", [s2acc, day(365)]);
  const roles = await rpc(S2, "my_roles");
  assert(roles.accreditations.length === 1 && roles.accreditations[0].licenseExpires === day(365), "not renewed: " + JSON.stringify(roles));
});
await refused("a stranger can't renew a license", () => rpc(STRANGER, "renew_license", [s2acc, day(700)]), /not allowed/);

console.log("Cars without a VIN");
const buggy = { make: "Custom", model: "Rally buggy", year: "2019", name: "Blue buggy" };
let custom;
await check("a custom-built car with no number at all", async () => {
  custom = await rpc(S2, "issue_logbook", [{ body: "ara", ownerEmail: "maker@car.test", ownerName: "Morgan Maker", vehicle: buggy, record: { vehicle: buggy } }]);
  assert(custom.digitalNumber, "no logbook");
});
await refused("the same car again looks like a duplicate", () => rpc(S2, "issue_logbook", [{ body: "ara", ownerEmail: "maker@car.test", vehicle: buggy, record: {} }]), /possible duplicate of FL-/);
await check("...unless the scrutineer confirms it's another car", () => rpc(S2, "issue_logbook", [{ body: "ara", ownerEmail: "maker@car.test", ownerName: "Morgan Maker", vehicle: buggy, record: {}, allowDuplicate: true }]));
await check("a builder's chassis number", () => rpc(S2, "issue_logbook", [{ vin: "ch-001", body: "ara", ownerEmail: "a@car.test", vehicle: { make: "Proto" }, record: {} }]));
await refused("the same chassis number again looks like a duplicate", () => rpc(S2, "issue_logbook", [{ vin: "CH-001", body: "ara", ownerEmail: "b@car.test", vehicle: { make: "Other" }, record: {} }]), /possible duplicate/);

console.log("Finding a logbook");
await check("by owner name", async () => {
  const r = await rpc(S2, "search_logbooks", [{ text: "morgan" }]);
  assert(r.length === 2 && r.every((x) => x.ownerName === "Morgan Maker"), "found " + r.length);
});
await check("by make and year", async () => {
  const r = await rpc(S2, "search_logbooks", [{ make: "subaru", year: "2004" }]);
  assert(r.length === 1 && r[0].digitalNumber === issued.digitalNumber, "found " + r.length);
});
await check("by the body's logbook number", async () => {
  const r = await rpc(S2, "search_logbooks", [{ text: "07-512345" }]);
  assert(r.length === 1, "found " + r.length);
});
await check("by sanctioning body", async () => {
  assert((await rpc(S2, "search_logbooks", [{ body: "nasa" }])).length === 0, "found NASA logbooks");
  // The Subaru, the two buggies and the chassis-numbered car.
  assert((await rpc(S2, "search_logbooks", [{ body: "ara" }])).length === 4, "not every ARA logbook");
});
await refused("an owner can't search other people's logbooks", () => rpc(OWNER, "search_logbooks", [{}]), /not allowed/);

console.log("Events");
let event, car12, car7;
await check("the technical director creates an event and its staff", async () => {
  event = await rpc(TD, "save_event", [{ body: "ara", name: "Test Rally", location: "Somewhere", scrutineeringStartsOn: day(-1), startsOn: day(0), endsOn: day(1), acceptedBodies: ["nasa"] }]);
  await rpc(TD, "grant_accreditation", [CHIEF, "Chris Chief", "ara", "scrutineer", "L-90"]);
  await rpc(TD, "set_event_staff", [event, CHIEF, "chief"]);
  await rpc(TD, "set_event_staff", [event, S2, "scrutineer"]);
  const [ev] = await as(S2, (q) => q("select accepted_bodies from events where id = $1", [event]));
  assert(ev.accepted_bodies.sort().join() === "ara,nasa", "accepted " + ev.accepted_bodies);
});
await refused("a scrutineer can't create events", () => rpc(S2, "save_event", [{ body: "ara", name: "X", scrutineeringStartsOn: day(0), startsOn: day(0), endsOn: day(0) }]), /not allowed/);
await check("the chief scrutineer enters the competitors", async () => {
  car12 = await rpc(CHIEF, "save_entry", [event, { carNumber: "12", driver: "Pat Owner", logbookId: issued.id }]);
  car7 = await rpc(CHIEF, "save_entry", [event, { carNumber: "7", driver: "New Driver", vehicle: { make: "Ford", model: "Fiesta", year: "2012" } }]);
});
await refused("a scrutineer who isn't on the event can't add records", () => rpc(MULTI, "add_event_record", [car12, "inspection", { result: "pass" }, "passed"]), /not on this event's staff/);
await check("an event scrutineer records the inspection: passed", async () => {
  await rpc(S2, "add_event_record", [car12, "inspection", { result: "pass", notes: "All good" }, "passed"]);
  const [r] = (await db.query("select kind, event_id from records where kind = 'inspection'")).rows;
  assert(r && r.event_id === event, "inspection record missing its event");
});
await refused("a car with no logbook gets no inspection record", () => rpc(S2, "add_event_record", [car7, "inspection", {}, "passed"]), /has no logbook/);
await check("tech progress: 1 passed, 1 still to inspect", async () => {
  const [e] = (await rpc(S2, "my_events")).filter((x) => x.id === event);
  assert(e && e.passed === 1 && e.pending === 1 && e.cars === 2, "progress: " + JSON.stringify(e));
});
await check("the event's logbooks download in one go", async () => {
  const b = await rpc(S2, "event_bundle", [event]);
  const e12 = b.entries.find((x) => x.entry.car_number === "12");
  assert(b.entries.length === 2 && e12.records.length >= 5 && !e12.logbook.public_token, "bundle: " + b.entries.length);
});
await refused("an event whose window has passed", async () => {
  const old = await rpc(TD, "save_event", [{ body: "ara", name: "Last month", scrutineeringStartsOn: day(-40), startsOn: day(-39), endsOn: day(-38) }]);
  await rpc(TD, "set_event_staff", [old, S2, "scrutineer"]);
  const entry = await rpc(TD, "save_entry", [old, { carNumber: "12", logbookId: issued.id }]);
  await rpc(S2, "add_event_record", [entry, "inspection", {}, "passed"]);
}, /not open for records/);
await refused("an event that doesn't accept the logbook's body", async () => {
  const nasaEvent = await rpc(ADMIN, "save_event", [{ body: "nasa", name: "NASA event", scrutineeringStartsOn: day(0), startsOn: day(0), endsOn: day(0) }]);
  await rpc(ADMIN, "set_event_staff", [nasaEvent, MULTI, "chief"]);
  const entry = await rpc(MULTI, "save_entry", [nasaEvent, { carNumber: "5", logbookId: issued.id }]);
  await rpc(MULTI, "add_event_record", [entry, "inspection", {}, "passed"]);
}, /does not accept ara logbooks/);

console.log("Syncing local copies");
await check("the owner downloads their whole logbook", async () => {
  const full = await rpc(BUYER, "logbook_full", [issued.id]);
  assert(full.logbook.public_token && full.bodyNumbers.ara === "07-512345", "owner copy incomplete");
  const insp = full.records.find((r) => r.kind === "inspection");
  assert(insp && insp.eventName === "Test Rally" && insp.authorName === "Sam Two", "inspection record without its event or author");
});
await check("a scrutineer's copy leaves out the public link", async () => {
  const full = await rpc(S2, "logbook_full", [issued.id]);
  assert(!full.logbook.public_token && full.records.length >= 5, "scrutineer copy wrong");
});
await refused("a stranger can't download a logbook", () => rpc(STRANGER, "logbook_full", [issued.id]), /no such logbook/);
await check("which local copies are out of date, in one call", async () => {
  const heads = await rpc(S2, "logbook_heads", [[issued.id, custom.id]]);
  const h = heads.find((x) => x.id === issued.id);
  assert(heads.length === 2 && h.lastSeq >= 5, "heads: " + JSON.stringify(heads));
  assert((await rpc(STRANGER, "logbook_heads", [[issued.id]])).length === 0, "a stranger sees heads");
});

console.log("Photos");
const sha = (c) => c.repeat(64);
const [CAGE, SHOT, VEHICLE, PAPER] = [sha("a"), sha("b"), sha("c"), sha("d")];
const upload = (email, name) => as(email, (q) => q("insert into storage.objects (bucket_id, name) values ('logbook-photos', $1)", [name]));
const canSee = (email, name) => as(email, (q) => q("select name from storage.objects where bucket_id = 'logbook-photos' and name = $1", [name])).then((r) => r.length === 1);
let photoBook;
await check("a scrutineer uploads photos, named by their hash", async () => {
  for (const name of [CAGE, SHOT, VEHICLE, PAPER]) await upload(S2, name);
});
await refused("a photo name that isn't a hash", () => upload(S2, "../other.jpg"), /row-level security/);
await refused("a non-scrutineer can't upload", () => upload(OWNER, sha("e")), /row-level security/);
await check("a logbook issued with its photos indexes them", async () => {
  photoBook = await rpc(S2, "issue_logbook", [{ vin: "WVWZZZ1JZXW000002", body: "ara", ownerEmail: "photo@car.test", vehicle: { make: "VW" }, record: {
    pictures: [{ sha256: CAGE, screenshotSha256: SHOT, category: "overview", elements: [] }],
    vehiclePhotos: { front: { sha256: VEHICLE }, rear: null }, paperPages: [{ sha256: PAPER }] } }]);
  const rows = (await db.query("select kind, count(*)::int as n from logbook_photos where logbook_id = $1 group by kind order by kind", [photoBook.id])).rows;
  assert(JSON.stringify(rows) === JSON.stringify([{ kind: "cage", n: 2 }, { kind: "paper", n: 1 }, { kind: "vehicle", n: 1 }]), JSON.stringify(rows));
});
await check("its owner can see its photos", async () => {
  for (const name of [CAGE, SHOT, VEHICLE, PAPER]) assert(await canSee("photo@car.test", name), "owner can't see " + name.slice(0, 4));
});
await check("a signed-in stranger can't see the paper pages", async () => {
  assert(!(await canSee(STRANGER, PAPER)), "stranger sees the paper page");
});
await check("the public link shows the rollcage and vehicle photos, not the paper pages", async () => {
  assert(await canSee(null, CAGE) && await canSee(null, VEHICLE), "public can't see the cage photos");
  assert(!(await canSee(null, PAPER)), "public sees the paper page");
});
await check("...until the owner hides the photos", async () => {
  await rpc("photo@car.test", "set_privacy", [photoBook.id, { cage_photos: false }, true]);
  assert(!(await canSee(null, CAGE)), "public still sees the cage photo");
});
await check("a stored photo can't be changed or deleted", async () => {
  await as(S2, (q) => q("update storage.objects set name = $1 where name = $2", [sha("f"), CAGE]));
  await as(S2, (q) => q("delete from storage.objects where name = $1", [CAGE]));
  const n = (await db.query("select count(*)::int as n from storage.objects where name = $1", [CAGE])).rows[0].n;
  assert(n === 1, "the photo was changed or deleted");
});

console.log("Revoking");
await check("the director disables the scrutineer", async () => {
  const [acc] = await as(TD, (q) => q("select id from accreditations where email = $1", [S1]));
  await rpc(TD, "set_accreditation_state", [acc.id, "disabled"]);
});
await refused("a disabled scrutineer can't add records", () => rpc(S1, "add_record", [issued.id, "note", {}, "ara"]), /not an active scrutineer/);
await check("their earlier records stay", async () => {
  const n = (await db.query("select count(*)::int as n from records where author_email = $1", [S1])).rows[0].n;
  assert(n === 3, "records by the disabled scrutineer: " + n);
});
await check("disabling a body stops its scrutineers", async () => {
  await rpc(ADMIN, "set_body_state", ["nasa", "disabled"]);
  const roles = await rpc(MULTI, "my_roles");
  assert(roles.accreditations.length === 1 && roles.accreditations[0].body === "ara", "still accredited by a disabled body");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
