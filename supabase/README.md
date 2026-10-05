# Digital logbooks — server (Supabase)

The central repository of logbooks: sanctioning bodies, scrutineers and
technical directors, logbooks and their append-only records. See the design
document for technical directors for the reasoning; this is phase 1
(accounts, roles, issuing logbooks, owners' garage, public link).

## What's here

| File | Purpose |
|---|---|
| `migrations/20261005000000_logbooks.sql` | Tables, access rules (row level security) and the functions every write goes through |
| `migrations/20261006000000_events_search_licenses.sql` | License expiry and renewal; optional VIN (custom builds) with the car's details kept for searching; `search_logbooks`; events with staff, competitor list and tech status, and inspection records limited to the event's staff during its window |
| `migrations/20261007000000_sync.sql` | `logbook_heads` (which local copies are out of date, in one call) and `logbook_full` (a whole logbook with its records, authors and event names) for syncing local copies |
| `migrations/20261008000000_photos.sql` | The private `logbook-photos` storage bucket (photos named by their SHA-256, uploaded by scrutineers only, never replaced or deleted), the `logbook_photos` index filled from records, and who may see each photo: staff, the logbook's readers, and the public link for cage and car photos when the owner allows them |
| `../tools/test-db.mjs` | Runs the migrations in an in-process PostgreSQL and checks every role and rule: `npm install`, then `npm run test:db` |

## How it works

- **Identity is the email.** People sign in with a one-time code sent to
  their email; nobody needs an account set up first. A scrutineer is an
  email with an accreditation from a body; an owner is the email the
  scrutineer recorded on the logbook.
- **Roles:** Frog Racing admins (`admins` table) create sanctioning bodies
  and appoint technical directors; a technical director adds and disables
  their own body's scrutineers; a person can be accredited by several bodies.
- **Writes only through functions** (`issue_logbook`, `add_record`,
  `grant_accreditation`, `set_privacy`...), each checking the caller's role.
  Clients can only read the tables, and only what the access rules allow:
  owners their own cars, scrutineers all logbooks, strangers nothing.
- **Records are append-only:** a trigger refuses any update or delete, even
  by the database owner, and each record carries a SHA-256 hash of its
  content chained to the previous record's hash.
- **Public link:** `public_logbook(token)` returns the logbook filtered by
  the owner's privacy choices; anyone with the link can call it.
- **Digital logbook numbers:** `FL-XXXX-XXXC`, Crockford base 32 (no I, L, O
  or U) with a check character; `digital_number_valid()` checks a typed one.

## Setting up the Supabase project (one time)

1. Create a project at [supabase.com](https://supabase.com) (the free plan
   is fine for development and the pilot).
2. **Run the migrations, in order:** in the dashboard's SQL Editor, paste
   the contents of each file in `migrations/` (oldest first) and run it.
   Each new migration is run once, the same way, when it's added.
3. **Make yourself the first Frog Racing admin** (SQL Editor):
   ```sql
   insert into admins (email) values ('you@example.com');
   ```
   Every later admin is added from the app (`add_admin`).
4. **Sign-in by email code:** Authentication → Sign In / Providers → Email:
   keep it enabled. Authentication → Emails → "Magic Link" template: add
   `{{ .Token }}` so the email carries the 6-digit code people type in the
   app.
5. **Give the app the project's address:** Project Settings → API: copy the
   Project URL and the `anon` public key into `config.js` (`supabaseUrl`,
   `supabaseAnonKey`). The anon key is meant to be public; the access rules
   are what protect the data. **Never** put the `service_role` key in the
   app or the repository.

Before real use: Supabase's built-in email sender allows only a few emails
an hour. Set up your own SMTP sender (Authentication → Emails → SMTP
settings) before a pilot event.
