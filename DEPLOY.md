# Deploying Migraine Tracker to TrueNAS

App conventions per homelab setup: a single Custom App (Docker Compose) on
SCALE Goldeye, dataset on `fast_pool`, Tailscale-only exposure, and Backrest
covering the dataset. The server, SQLite database, nightly JSON dumps, and the
reminder scheduler all run in this one container. CI publishes the container
image to GHCR; the NAS pulls it (sections 2 and 5).

## 1. Create the dataset

Dataset: `/mnt/fast_pool/app_data/migraine-tracker` with a `data/`
subdirectory. The SQLite database and its WAL files live there, and the server
writes rotating nightly JSON dumps under `data/backups/`.

## 2. Get the app image onto the NAS

The standard deployment copies **no** app source to the NAS. CI builds,
smoke-tests, and publishes a `linux/amd64` image (the NAS architecture) on every
push to `main` (and on manual dispatch of `main`) to GitHub Container Registry:

```
ghcr.io/bradybrenot/migraine-tracker:latest
```

`latest` tracks the tip of `main`, and every completed publish also produces a
`sha-<full-commit>` tag; section 5 shows the Compose service that pulls it. Make
the package public after the first publish (next section), so the NAS pulls and
updates the image anonymously with no stored registry credential.

### GHCR package visibility and authentication (make it public after first publish)

**Anonymous pulls from a public package are the standard path here.** After the
first CI publish, make the package public once; the NAS then pulls and updates
the image with no registry credentials at all. The authenticated setup below is
only the alternative for keeping the package private.

- **Make the package public after the first successful publish:** open the
  package page from the owner's **Packages** tab, then
  **Package settings -> Danger Zone -> Change visibility -> Public**. This
  exposes nothing new. The repository that publishes the image is already
  public, the image contains **no health data** (every record lives in the
  mounted `/data` dataset, never in the image), and it contains **no secrets**
  (the ntfy URL/token variables are environment-only at runtime and are never
  baked into the image). It is also the dependable path on this NAS:
  private-registry support in the TrueNAS SCALE **Goldeye / 25.10** Apps
  frontend is unreliable for pulls and updates, because Apps registry
  credentials are only fully honored in fixed newer releases, while anonymous
  public pulls behave the same on every version.
- **Visibility is a one-way change.** GitHub's own **Change visibility** dialog
  warns: *"Once you make a package public, you cannot make it private again."*
  Confirm you are changing the intended package before you flip it; the change
  cannot be undone.
- **One-time publish setup:** the first CI publish creates the package under the
  repository owner, and a new package is **private** by default — even when the
  repository is public; visibility is **not** inherited from the repository. The
  workflow attaches the repository as the package source through the OCI
  `org.opencontainers.image.source` label. If a later publish fails with an
  authorization/permission error, open the package page from the owner's
  **Packages** tab, go to **Package settings -> Manage Actions access**, and
  grant this repository write access.
- **Alternative: keep the package private.** Pulls then require authentication,
  which needs a GitHub **classic** Personal Access Token with the
  `read:packages` scope. Fine-grained PATs do not support package scopes, so
  they cannot be used for GHCR pulls here.

  The reliable fallback is a shell-managed Compose deployment with a shell
  `docker login`. From a NAS shell, with the token exported in `GHCR_PAT` (do
  not paste it into files or logs):

  ```bash
  echo "$GHCR_PAT" | docker login ghcr.io -u <github-username> --password-stdin
  ```

  Docker stores the credential in that user's `~/.docker/config.json` (or the
  configured credential helper), so no secret goes into `compose.yaml`; re-run
  the login if that file does not survive a TrueNAS upgrade.

  Version caveat: the TrueNAS Apps UI sign-in — **Apps -> Configuration ->
  Sign-in to a Docker registry**, then **Add Registry** and **Other Registry**,
  with registry URI `ghcr.io`, a display name, your GitHub username, and the PAT
  as the password (see
  https://apps.truenas.com/getting-started/initial-setup/) — is only dependable
  on the fixed newer releases where Apps fully honors those credentials. Do
  **not** promise or assume it works on 25.10/Goldeye; on this NAS, keeping the
  package private means managing that deployment with shell Compose and the
  login above.

  Do not assume one credential store covers both: a shell login does **not**
  necessarily apply to pulls performed through the TrueNAS Apps UI, and an Apps
  UI credential does not cover a shell `docker compose pull`.
- **Official docs:**
  https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry

### Alternative: build the image locally from source

Pulling from GHCR is the standard path, but building on the NAS still works.
The build needs the full `app/` source: `Dockerfile`, `.dockerignore`, package
files, `index.html`, `view.html`, the Vite/TS/Tailwind/PostCSS configs,
`components.json`, `src/`, `shared/`, `public/`, and `server/` (without
`node_modules` or `server/data`). Copy or clone the repository onto the NAS,
then from the repository root:

```bash
docker build -t migraine-tracker:local ./app
```

(equivalently, from `app/`: `docker build -t migraine-tracker:local .`). The
Dockerfile is Node 24 based and produces the same runtime layout. Then use
`image: migraine-tracker:local` in the Compose service instead of the GHCR
reference and remove `pull_policy: always`, because a local-only tag is not in
any registry and cannot be pulled.

Such an image exists only on that host: it is not published, scanned, or
tracked by CI/GHCR, and has no `latest`/`sha-` tags and no smoke test.

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

### Weather pressure-drop alerts (optional)

Weather is an optional feature, **disabled by default**; nothing is fetched and
no notification is scheduled until it is enabled in Settings with a saved city.

- **Setup:** Settings → Weather → search for a city, choose a result, set the
  pressure-drop threshold (default `5` hPa), enable the toggle, save. The city
  search text and the chosen coordinates are sent to Open-Meteo
  (`geocoding-api.open-meteo.com` / `api.open-meteo.com`). There is no API key,
  no new environment variable, and nothing to add to the Compose service.
  Attribution: [open-meteo.com](https://open-meteo.com/).
- **Scope:** only pressure drops are assessed. A warning means the hourly
  mean-sea-level pressure falls by at least the configured threshold between the
  current baseline and the following 24 hours. `5` hPa is a configurable
  starting point, not a validated clinical threshold. Temperature, humidity and
  current pressure are informational only and never trigger an alert. There is
  no medical prediction or risk score.
- **Notifications:** at most one ntfy reminder per pressure-drop episode. It
  obeys the personal reminder master switch, the "Weather pressure drops"
  per-type switch, and the configured waking hours, so it can be delayed or
  suppressed by them. The message contains the drop magnitude and target time
  only, not the saved city.
- **Failure behavior:** if an upstream refresh fails, the Home card keeps the
  last successful forecast (explicitly marked as possibly out of date) or shows
  a calm error message. A stale, loading, or errored forecast never sends an
  ntfy message; the pending episode waits for a successful refresh and expires
  when its target time has passed.
- **Privacy/backup:** only the saved city and threshold are settings (they are
  included in `/api/export` and nightly backups). Forecast and episode/delivery
  state stay internal and are excluded from exports and backups.
- **Upstream terms/privacy:** the free Open-Meteo API is non-commercial and
  rate-limited, and its data is provided under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Per
  [Open-Meteo's terms](https://open-meteo.com/en/terms), troubleshooting logs
  may contain the requested coordinates and are deleted after 90 days.
- Delivery keeps the existing at-least-once caveat: a crash between ntfy
  accepting the weather message and the app recording success can resend it.

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

### Health and alert/sync diagnostics

- `GET /api/health` returns only `{ ok: true, notifications: { reminders,
  attackAlerts } }` — booleans describing whether each environment topic is
  configured. It never returns ntfy URLs, tokens, failure reasons, or any other
  configuration detail.
- Settings shows the attack-alert configuration read-only ("Configured",
  "Not configured", or "Unavailable"). This reports configuration only: it is
  not a delivery guarantee, and an accepted send is not proof a phone displayed
  the notification.
- Frontend API requests time out after about 15 seconds. A stalled backend
  therefore fails the request and the change is shown as unsynced/failed instead
  of leaving the serialized writer queue hanging indefinitely.

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
backup anyway before replacing the image (a GHCR update, a locally built image,
or a rollback), especially the first time.

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

In the TrueNAS UI -> Apps -> Custom App, paste the Compose service from
`app/compose.yaml` (reproduced here; no build context is needed):

```yaml
services:
  migraine-tracker:
    image: ghcr.io/bradybrenot/migraine-tracker:latest
    pull_policy: always
    container_name: migraine-tracker
    restart: unless-stopped
    ports:
      - "8097:3000"
    volumes:
      - /mnt/fast_pool/app_data/migraine-tracker/data:/data
    environment:
      # Server-only ntfy delivery configuration. Leave any value empty/unset to
      # disable reminders; never put real credentials in this file or git.
      # NTFY_URL is the FULL topic publish URL (e.g. https://ntfy.example/topic).
      NTFY_URL: ${NTFY_URL:-}
      NTFY_TOKEN: ${NTFY_TOKEN:-}
      # Separate attack start/end alert topic (independent of reminders).
      NTFY_ATTACK_URL: ${NTFY_ATTACK_URL:-}
      NTFY_ATTACK_TOKEN: ${NTFY_ATTACK_TOKEN:-}
      PUBLIC_APP_URL: ${PUBLIC_APP_URL:-}
```

`pull_policy: always` makes a container recreate re-check the `latest` tag, so
an update is "pull and recreate", not "rebuild".

### Updating on the NAS

**CI never deploys to the NAS.** Every update is a manual pull-and-recreate:

- **TrueNAS Apps UI:** use the app's update/recreate action (the exact label
  varies by TrueNAS version) to pull the new `latest` image and recreate the
  container with the same YAML and dataset.
- **Shell-managed Compose:** from the directory holding the Compose file:

  ```bash
  docker compose pull
  docker compose up -d
  ```

Either way the container restarts against the same `/data` dataset and runs the
additive schema migrations at startup. Take the section-4 database backup before
any update that may change the schema.

### Rollback to a pinned image

Every completed CI publication — queued or not — pushes a
`sha-<full-40-character-commit>` tag for its own commit; the moving `latest` tag
is updated in addition only when that commit is the tip of `main` at publish
time. A rollback target therefore always exists for any run whose Publish job
completed.

The `sha-` tags are immutable in normal operation, but re-running the same
commit's publish job (for example a manual re-run of the workflow) rebuilds the
image from a floating Node base tag and can overwrite that tag's contents;
base-image digests are deliberately not pinned here.

1. Find the commit of a known-good run: `gh run list` and
   `gh run view <run-id>` show the run's commit SHA (also visible in the GitHub
   Actions web UI), and the same SHA is listed on the GHCR package's
   **Versions** page.
2. Pin the service to that tag — replace the image line, and optionally drop
   `pull_policy: always` while pinned, since later publishes never move a
   `sha-` tag:

   ```yaml
   services:
     migraine-tracker:
       image: ghcr.io/bradybrenot/migraine-tracker:sha-<commit>
       # pull_policy: always removed while pinned
   ```

3. Recreate the container (same update/recreate steps as above). Take the
   section-4 database backup before this image swap too.
4. Switch back to `:latest` (and restore `pull_policy: always`) and recreate
   once `main` is fixed.

Schema caveat: an image built **before** a migration refuses to start against a
database that a newer image already migrated (older builds reject a newer
schema). If the rollback crosses a migration, restore the section-4 backup taken
before that upgrade instead of just repointing the tag.

## 6. Access and security boundary

- Keep the app reachable only over Tailscale:
  `https://migraine.crustaceansoup.com` through the existing HTTPS reverse
  proxy/Tailscale setup (or `http://<truenas-tailscale-hostname>:8097` for
  local checks).
- The API has no authentication. The tailnet is the security boundary. Do not
  expose this container on a public interface or a public Cloudflare tunnel.
- HTTPS is required for mobile Chrome installation; use the real HTTPS hostname
  for the install acceptance check.

### Same-origin write guard

The server rejects a mutating request (anything other than `GET`/`HEAD`/`OPTIONS`)
with `403 {"error":"cross-origin request denied"}` when it carries an `Origin`
or `Referer` header whose `host:port` does not match the request's `Host`
header. Requests with neither header (curl, scripts, partner clients) are still
allowed, reads are never blocked, and the scheme is deliberately not compared
(TLS may terminate at the proxy). Malformed/opaque origins are denied.

If a reverse proxy rewrites the `Host` header, writes can return 403 while
reads and `GET` keep working. The proxy must preserve the original Host header.
For nginx the generic form is:

```nginx
proxy_set_header Host $host;
```

Other proxies differ, so check your proxy's documentation for the equivalent
setting instead of assuming it behaves the same way. Symptom: the app loads and
every save, erase, or import fails with 403 — verify Host preservation in the
proxy configuration. This guard is not authentication.

### Partner read-only view

Send the partner to `https://<host>/view` (the same host used for the app). It
shows Now, Calendar, Reports, and History with a visible **Read only** label.
The page fetches `GET /api/export` and refreshes automatically about every 20
seconds, and also when the tab becomes visible or the window regains focus.
Editing, adding/deleting, quick logging, refills, imports/exports, downloads,
and Settings are absent from this route.

Installing that page from the browser menu (Android Chrome **Install app** or
iOS Share -> **Add to Home Screen**) installs a separate read-only app named
**Migraine Partner**. Its manifest (`id`/`start_url` `/view`, scope `/view`)
always launches `/view`; the writer app installed from `/` is unchanged. The
partner app is online-only exactly like the writer (no service worker or
offline cache), so connectivity to the Tailscale host is still required.

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

- **In-app JSON restore** is in Settings → Data. The picker accepts both the
  browser's **Export backup (JSON)** file and the versioned envelopes written
  by `GET /api/export` and the nightly dumps, including older supported schema
  versions. A file written by a newer schema (or a malformed/unsupported
  payload) is rejected rather than partially restored.
- The preview shows per-type record counts and how many records already exist
  on this device. There are two explicit modes:
  - **Merge missing records** adds only records whose ID (day states: day) is
    not already present. It never overwrites or deletes existing records and
    never changes settings. This uses the existing additive `/api/import`.
  - **Replace everything** is a second confirmed destructive action. It
    removes all current records (and, on a connected server, every stored
    setting) and restores the backup's records plus the whitelisted
    non-secret settings: rules, dose defaults, planned doses, timezone,
    low-stock threshold and alert latch, and reminder preferences.
- `POST /api/restore` is the atomic server operation behind replace. It
  validates the entire payload before writing, then clears and re-inserts
  records/settings in a single SQLite transaction. The same transaction also
  CLEARS the internal reminder occurrence/delivery state — that state is never
  backup content and is never restored, only reset. Any error rolls the whole
  replacement back and nothing changes; success returns the canonical export
  envelope, which the browser adopts (it never optimistically erases local
  data first). Bulk import and restore request bodies are limited to 25 MiB, so
  a larger backup must be restored via the stopped-container SQLite file path
  in section 4.
- Duplicate IDs inside a replacement payload make replace fail atomically
  (merge keeps the first of each duplicate and skips the rest).
- Secret/environment configuration (for example `NTFY_URL`, `NTFY_TOKEN`, and
  `PUBLIC_APP_URL`) is never backup content and is never restored. Reminder
  delivery state is internal and is reset by a restore.
- `/api/import` remains an **additive** endpoint (`INSERT OR IGNORE`): it
  skips existing records, restores no settings, and does not touch internal
  reminder state. CSV import in Settings is unchanged and is not a JSON
  restore.
- To restore the primary database itself, use the stopped-container SQLite
  file restore in section 4. That remains the disaster-recovery path; in-app
  JSON restore is the option available while the app is running.

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
is a manual acceptance check; it is not performed from this repository. The
partner installs separately from `https://<host>/view` with its own icon and
name, and always opens the read-only view.

The app is **online-only**: no service worker, no offline cache, no Web Push,
and no background sync. Installing does not change that - loading, refreshing,
and sync all need connectivity to the Tailscale host.

## 10. Inspect CI runs and publications

CI is `.github/workflows/ci.yml` and runs on every push and pull request to
`main`, plus manual dispatch. With an authenticated `gh` CLI, a human or an
agent can inspect runs from any machine:

```bash
gh run list --workflow=ci.yml --limit 10
gh run view <run-id>
gh run view <run-id> --log
gh run watch
```

The same runs are in the repository's **Actions** tab on GitHub; the run's
commit SHA (shown by `gh run view` and in the UI) is the value used for the
`sha-` tag.

What the workflow does:

- **Verify** (all pushes and PRs; 30-minute timeout): Node 24, `npm ci` for the
  frontend and for `server/`, then `npm test`, `npm run lint`, `npm run build`,
  `npm run validate:pwa`, `npm run build:demo`, `npm run validate:demo`, a
  no-push `docker build` of `app/`,
  `docker compose -f compose.yaml config --quiet`,
  `node --check server/index.js`, `npm test --prefix server`, and
  `npm audit --omit=dev` for both dependency trees.
- **Publish image** (`main` pushes and manual dispatches of `main` only, after
  Verify; 30-minute timeout): builds `app/` for `linux/amd64` and loads it
  locally, then smoke-tests that loaded image (`--pull never`) in a disposable
  container with a throwaway volume and no ntfy configuration: `/api/health`
  must report `"ok":true`, `/` must serve the writer shell, and `/view` must
  serve the partner shell. Only then does it push to GHCR. Publications are
  serialized **and queued** (`concurrency: publish-ghcr`,
  `cancel-in-progress: false`, `queue: max`: up to 100 pending, and runs beyond
  that overflow are canceled), so a backlog is never dropped or replaced and
  every queued publication runs and pushes its own `sha-<full-commit>` tag
  (see section 5 for the one re-run caveat). `latest` is pushed **only** when
  this run's commit is still the tip of `main` at publish time, checked with an
  authenticated `gh api repos/.../commits/main` that fails closed: a superseded
  run (or a failed check) publishes only its `sha-` tag and emits a notice, so
  an older run can never move `latest` backward. The one remaining race is a
  merge landing between the guard and the push; the next run's guard corrects
  `latest`.
- **Deploy demo** (`main` pushes and manual dispatches of `main` only, after
  Verify; 15-minute timeout): builds the frontend-only demo with the Pages base
  path, validates the artifact, and deploys `app/dist-demo/` to GitHub Pages.
  It is a sibling of Publish (both need only Verify) with its own
  `pages` concurrency group and `github-pages` environment.

A green Publish run only means the image exists in GHCR; it does not mean the
NAS has it. Deployment stays manual (section 5).

## 11. Public demo (GitHub Pages)

The CI workflow also publishes a static, frontend-only demo at:

```
https://bradybrenot.github.io/migraine-tracker/
```

One-time setup: in the repository, open **Settings -> Pages** and set
**Source = GitHub Actions**. After that, the `pages` job builds and deploys on
every push (or manual dispatch) of `main` in `BradyBrenot/migraine-tracker`.
Pull requests and forks never deploy, and the job has only `contents: read`,
`pages: write`, and `id-token: write`.

The demo is the writer app with clearly fictional sample data preloaded. Every
interaction is held in memory, reloading restores the sample set, and nothing
is saved or sent anywhere: the build makes no backend/API requests and does not
read, write, or remove localStorage/sessionStorage. Weather forecasts and the
partner `/view` view need the backend, so weather is unavailable and `/view*`
redirects to the demo home. A permanent banner says the data is synthetic and
that changes are lost on reload; do not enter real health information.

The artifact goes to `app/dist-demo/` (production `app/dist/` and the Docker
image are unaffected). It uses the Pages base path for assets, the SPA router,
and the manifest, with `404.html` as the deep-link fallback. Run
`npm run build:demo` and `npm run validate:demo` locally to reproduce and check
the same artifact.

## Notes

- Image tags: `ghcr.io/bradybrenot/migraine-tracker:latest` tracks the tip of
  `main` — it moves only while the publishing run's commit is still the tip at
  publish time — so an image-update watcher such as WUD can track it if desired.
  Every publish also creates a `sha-<full-commit>` tag regardless, and those
  exist for pinning and rollback; they are immutable in normal operation, though
  re-running the same commit's publish job rebuilds from the floating Node base
  tag and can overwrite the tag's contents (base-image digests are not pinned).
  CI never touches the NAS: pulling and recreating the container is always a
  manual step.
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
