# Deploying Migraine Tracker to TrueNAS

App conventions per homelab setup: a single Custom App (Docker Compose) on
SCALE Goldeye, dataset on `fast_pool`, Tailscale-only exposure, and Backrest
covering the dataset. The server, SQLite database, nightly JSON dumps, and the
reminder scheduler all run in this one container.

## 1. Create the dataset

Dataset: `/mnt/fast_pool/app_data/migraine-tracker` with a `data/`
subdirectory. The SQLite database and its WAL files live there, and the server
writes rotating nightly JSON dumps under `data/backups/`.

## 2. Get the app source onto the NAS

Copy the `app/` directory (this project) to:

```
/mnt/fast_pool/app_data/migraine-tracker/app
```

Required contents: `Dockerfile`, `compose.yaml`, `.dockerignore`,
`package.json`, `package-lock.json`, `index.html`, `vite.config.ts`,
`tsconfig*.json`, `tailwind.config.js`, `postcss.config.js`, `public/`
(manifest + icons), `shared/`, `src/`, and `server/` (without `node_modules`
or `server/data`).

(e.g. via SMB share, or `scp -r app/ truenas:/mnt/fast_pool/app_data/migraine-tracker/app`)

## 3. Configure reminder delivery and attack alerts (optional)

Reminders and attack alerts are **environment-only**. Never put these values in
the app settings, the database, an export, or this repository. Leave `NTFY_URL`
unset/empty to run with reminders disabled and `NTFY_ATTACK_URL` unset/empty to
run with attack alerts disabled.

| Variable | Required | Meaning |
| --- | --- | --- |
| `NTFY_URL` | for reminders | Full ntfy **topic publish URL**, e.g. `https://ntfy.example.net/migraine`. Must be `http(s)`, must not contain credentials in the URL or query string. |
| `NTFY_TOKEN` | no | Bearer token for a protected reminder topic. Sent only in the `Authorization` header. |
| `NTFY_ATTACK_URL` | for attack alerts | Full ntfy **topic publish URL** for attack start/end alerts, e.g. `https://ntfy.example.net/migraine-attacks`. Same validation as `NTFY_URL`. Use a **separate topic** from reminders. |
| `NTFY_ATTACK_TOKEN` | no | Bearer token for a protected attack-alert topic. Never shared with or derived from `NTFY_TOKEN`. |
| `PUBLIC_APP_URL` | no | Public HTTPS app URL used for the notification click link, e.g. `https://migraine.example.net`. A malformed value only disables click links. Attack alerts link to `<PUBLIC_APP_URL>/view` (the partner read-only view), never the writer UI. |

The checked-in `compose.yaml` passes empty `${NTFY_URL:-}` /
`${NTFY_TOKEN:-}` / `${NTFY_ATTACK_URL:-}` / `${NTFY_ATTACK_TOKEN:-}` /
`${PUBLIC_APP_URL:-}` placeholders. Set the real values in the TrueNAS Compose
UI, an operator-managed env file, or the shell environment used to start
Compose. Do not commit an env file containing credentials.

Behavior to expect:

- With `NTFY_URL` absent or invalid, startup logs `ntfy reminders disabled: ...`
  and `NTFY_ATTACK_URL` absent/invalid logs `ntfy attack alerts disabled: ...`.
  Only the configuration reason is logged; values are never printed. If both
  are disabled, no scheduler or timer is created and no notification traffic is
  attempted.
- With either topic valid, **one** scheduler runs in this one container on a
  minute interval. **Do not run multiple replicas of the container**: the
  scheduler is designed for one process, not a horizontally scaled service.
- Reminders are sent only during the configured waking hours (initially
  09:00-21:00) in the configured IANA timezone. A missed daily check-in or
  exercise prompt may be redelivered for the grace period (about 2 hours);
  persistent conditions (preventive due, low stock) wait for the next waking
  window.
- Failed HTTP attempts back off and retry. Delivery is at-least-once around a
  crash: if the process dies after ntfy accepts a message but before the
  success record is written, startup recovery can send the same message again.
  Do not describe this as exactly-once delivery.
- A 2xx response from ntfy only means ntfy accepted the publish request. It is
  **not** proof the phone displayed the notification (Do Not Disturb, battery
  optimization, revoked topic permissions, and client sync delays all matter).

### Attack start/end alerts

Subscribe a second device (or the partner's phone) to the `NTFY_ATTACK_URL`
topic only. These alerts are separate from personal reminders: they do not
appear on the reminder topic and are not controlled by app reminder settings.

- A **new attack start** and an attack **ending** (the first non-null end time)
  are delivered on a **best-effort near-immediate** basis, not with a delivery
  guarantee. The attack write triggers a scheduler tick, but that tick joins an
  already-running tick/retry batch instead of interrupting it, so a new alert
  can be delayed by whatever that batch is doing. The one-minute interval
  (which also picks up the pending alert) is the fallback.
- Retries are bounded: an alert still undelivered 24 hours after the event
  instant is dropped (skipped as expired) instead of being retried forever.
  Delivery stays at-least-once inside that window.
- A delayed alert whose event fell on an earlier local day (settings timezone)
  includes that date in the message, e.g. `Attack started at 6:00 PM on Apr 10,
  2026.`, so it cannot be mistaken for a current event.
- The end message includes a duration when both timestamps parse and the end is
  not before the start. Messages contain **only** the start/end time (plus the
  date when the alert is delayed) and duration - never pain, medications, notes,
  symptoms, triggers, or aura.
- Attack alerts ignore the personal reminder master switch, per-type toggles,
  and waking hours, because the event is time-critical.
- **Freshness/baseline policy:** alerts are event-driven only, never generated
  from history. An event timestamp must be within 60 minutes in the past to 5
  minutes in the future when the write arrives. Older/historical records,
  backfills, and bulk imports never alert; a newly enabled topic therefore
  cannot flood with past attacks. Delayed client retries and small clock skew
  are tolerated inside that window. The flip side: a client clock running
  significantly fast (event more than ~5 minutes ahead of the server) or a
  write arriving late/offline (event more than ~60 minutes past) is suppressed
  and will **not** alert.
- Editing pain/details never resends a start alert, and correcting an existing
  end time does not send a second end alert. A deleted or changed attack is
  re-checked at send time so a stale or contradictory alert is never sent.
- Delivery is at-least-once around a crash: if the process dies after ntfy
  accepts an alert but before the success record is written, startup recovery
  can send that alert again. A 2xx response is not proof the phone showed it;
  Do Not Disturb, battery optimization, and ntfy client sync delays still
  apply.
- Privacy: the payload contains only the event time and duration, but the ntfy
  server (hosted or self-hosted) still sees topic/timing metadata and the
  bearer token. Delivery bookkeeping is internal and excluded from
  `/api/export` and nightly backups; credentials are never persisted, exported,
  or logged.
- Deleting an attack or using `/api/import` never raises an alert.

### One controlled notification test (performed by the user)

Only the user should run this, once, from a machine that can reach the ntfy
server. Use the real env values already configured for the container; do not
paste them into chat, logs, or the repository.

```bash
# Without a token:
curl -fsS -H "Title: migraine tracker test" \
  -d "Manual reminder delivery test" "$NTFY_URL"

# With a protected topic (NTFY_TOKEN already exported in this shell):
curl -fsS -H "Title: migraine tracker test" \
  -H "Authorization: Bearer $NTFY_TOKEN" \
  -d "Manual reminder delivery test" "$NTFY_URL"
```

For the attack topic, repeat once against `$NTFY_ATTACK_URL` (and
`$NTFY_ATTACK_TOKEN` if that topic is protected):

```bash
curl -fsS -H "Title: migraine tracker test" \
  -d "Manual attack alert test" "$NTFY_ATTACK_URL"

# Protected attack topic:
curl -fsS -H "Title: migraine tracker test" \
  -H "Authorization: Bearer $NTFY_ATTACK_TOKEN" \
  -d "Manual attack alert test" "$NTFY_ATTACK_URL"
```

Then check the phone. A `200` from ntfy with no phone banner still means the
phone side needs attention (topic subscription, notifications enabled for the
ntfy app, DND/battery settings). Do not repeat the test automatically.

## 4. Back up the real database before migrating

Schema upgrades are additive (the current build migrates older databases to
schema version 4 without deleting or rewriting user rows), but take a real
backup anyway before replacing the image or starting a new build for the first
time.

```bash
set -eu
cd /mnt/fast_pool/app_data/migraine-tracker
docker stop migraine-tracker
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="backups/pre-migration-$stamp"
mkdir -p "$dest"

# Mandatory: the database itself. If this fails, `set -e` stops the script.
if [ ! -f data/migraine.db ]; then
  echo "ERROR: data/migraine.db not found; nothing to back up." >&2
  exit 1
fi
cp -a data/migraine.db "$dest/migraine.db"

# WAL/SHM exist only when there are writes not yet checkpointed; copy them
# when present so the backup matches the stopped database.
copied_sidecars=""
for sidecar in data/migraine.db-wal data/migraine.db-shm; do
  if [ -f "$sidecar" ]; then
    cp -a "$sidecar" "$dest/"
    copied_sidecars="$copied_sidecars $sidecar"
  fi
done

# Verify before proceeding. A non-empty DB is required; a zero-length WAL is
# valid, so only its presence is checked.
if [ ! -s "$dest/migraine.db" ]; then
  echo "ERROR: $dest/migraine.db is missing or empty; aborting before any migration." >&2
  exit 1
fi
for sidecar in $copied_sidecars; do
  if [ ! -f "$dest/$(basename "$sidecar")" ]; then
    echo "ERROR: $sidecar was copied but is missing from $dest; aborting." >&2
    exit 1
  fi
done
ls -l "$dest"
```

- The database copy must succeed. Copy the `-wal`/`-shm` sidecars only when
  they exist; never suppress a database copy failure. The script aborts if the
  database backup is missing or empty, or if a sidecar that existed was not
  copied. A zero-length WAL is valid and is not treated as a failure.
- Copy the database and its sidecars together (`migraine.db`, `-wal`, `-shm`)
  while the container is stopped; a database file without a matching WAL can
  lose the most recent writes.
- Keep the backup outside the live `data/` directory you are about to mount, or
  at least in a separate timestamped folder that Backrest also covers.
- Do not delete the backup after a successful start until you have verified
  the app, export, and nightly dump.
- If you use a SQLite CLI, `sqlite3 data/migraine.db ".backup ..."` is also
  acceptable, but the stopped-container file copy is the simplest supported
  path here.

To restore the database: stop the container, remove the live
`migraine.db`/`-wal`/`-shm` files, copy the backed-up files back into `data/`,
and start the container. A JSON dump is not a drop-in replacement for the
SQLite files.

## 5. Create/update the Custom App

In the TrueNAS UI -> Apps -> Custom App, use `compose.yaml` with the correct
build context path:

```yaml
services:
  migraine-tracker:
    build: /mnt/fast_pool/app_data/migraine-tracker/app
    container_name: migraine-tracker
    restart: unless-stopped
    ports:
      - "8097:3000"
    volumes:
      - /mnt/fast_pool/app_data/migraine-tracker/data:/data
    environment:
      NTFY_URL: ${NTFY_URL:-}
      NTFY_TOKEN: ${NTFY_TOKEN:-}
      NTFY_ATTACK_URL: ${NTFY_ATTACK_URL:-}
      NTFY_ATTACK_TOKEN: ${NTFY_ATTACK_TOKEN:-}
      PUBLIC_APP_URL: ${PUBLIC_APP_URL:-}
```

If the UI's compose editor doesn't accept `build:` with a path, build once from
the NAS shell instead and reference the image:

```bash
cd /mnt/fast_pool/app_data/migraine-tracker/app
docker build -t migraine-tracker:latest .
```

then use `image: migraine-tracker:latest` in place of `build:`.

## 6. Access and security boundary

- Keep the app reachable only over Tailscale:
  `https://migraine.crustaceansoup.com` through the existing HTTPS reverse
  proxy/Tailscale setup (or `http://<truenas-tailscale-hostname>:8097` for
  local checks).
- The API has no authentication. The tailnet is the security boundary. Do not
  expose this container on a public interface or a public Cloudflare tunnel.
- HTTPS is required for mobile Chrome installation; use the real HTTPS hostname
  for the install acceptance check.

### Partner read-only view

Send the partner to `https://<host>/view` (the same host used for the app). It
shows Now, Calendar, Reports, and History with a visible **Read only** label.
The page fetches `GET /api/export` and refreshes automatically about every 20
seconds, and also when the tab becomes visible or the window regains focus.
Editing, adding/deleting, quick logging, refills, imports/exports, downloads,
and Settings are absent from this route.

**This is accidental-edit protection only — not authentication or
authorization.** The API remains unauthenticated and the Tailscale network is
the security boundary. Anyone with network access can still open the normal
writer app or call the normal API directly; `/view` does not enforce any
server-side permission.

## 7. Backups (ongoing)

Two layers, both inside the Backrest-covered dataset
(`/mnt/fast_pool/app_data/migraine-tracker/data`):

1. **Nightly JSON dump** - the server writes a full export to
   `data/backups/migraine-YYYY-MM-DD.json` once a day (checked hourly, written
   at startup if missing), keeping the newest 31 daily files.
2. **The SQLite files themselves** (`migraine.db` + WAL) - the primary store.

Internal reminder occurrence/delivery bookkeeping is intentionally excluded
from the export and nightly dump. Reminder credentials are never included.

Make sure `/mnt/fast_pool/app_data/migraine-tracker/data` is in Backrest's
scope; both layers are then covered on Backrest's normal schedule.

### Restore expectations

- The CSV button in Settings imports a **Migraine Buddy CSV export**. It is
  not a JSON restore, and it does not restore settings.
- `/api/import` accepts both legacy unversioned payloads and the current
  versioned JSON envelope, but it is **additive** (`INSERT OR IGNORE`): it does
  not overwrite existing records, does not restore settings, and does not
  restore internal reminder scheduler state. There is no JSON-restore UI in
  this version.
- To restore the primary database, use the stopped-container SQLite file
  restore in section 4. Re-enter reminder/timezone/threshold settings after a
  JSON-only recovery.

## 8. First run

Open the app. If you had data in the browser (imported Migraine Buddy CSV,
etc.), it is pushed to the server automatically on first contact; you will see
a "synced N attacks" toast. From then on the server is canonical and the
browser is only a cache. Set the IANA timezone and reminder preferences in
Settings, then verify stock/inventory and the calendar.

## 9. Install on mobile (manual acceptance step)

On Android Chrome, open `https://migraine.crustaceansoup.com` over Tailscale,
open the menu, and choose **Install app**. It then launches standalone with the
app icon. iOS can use Share -> **Add to Home Screen**. This on-device install
is a manual acceptance check; it is not performed from this repository.

The app is **online-only**: no service worker, no offline cache, no Web Push,
and no background sync. Installing does not change that - loading, refreshing,
and sync all need connectivity to the Tailscale host.

## Notes

- Image tags: this is our own image; rebuild with `docker build` on updates
  (WUD will not track it, which is correct - it is not a registry image).
- Nurtec inventory (schema v3): tablet quantities on meds/refills and dated
  stock-baseline corrections are regular records - they flow through
  `/api/export`, the nightly backup, and the additive `/api/import` like the
  rest, and `/api/reset` clears them. Legacy rows keep a NULL quantity
  ("unknown"), which stock arithmetic ignores instead of treating as zero.
  `GET /api/inventory/nurtec` is the authoritative count (settings timezone +
  low-stock threshold; default 2).
- Reminders (schema v4) are server-side ntfy delivery for preventive doses,
  low stock, the daily check-in, and behind-goal exercise. Delivery
  bookkeeping is internal and is deliberately not user backup content.
- Attack start/end alerts are a separate environment-only topic
  (`NTFY_ATTACK_URL`) using the same internal occurrence bookkeeping (no schema
  change). They are event-driven from attack API writes, bypass personal
  reminder settings and waking hours, and carry only event time plus optional
  duration.
- No deployment, production data migration, or real notification is performed
  by this checkout. Treat all values above as placeholders.
