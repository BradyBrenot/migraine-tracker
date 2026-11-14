# Deploying Migraine Tracker to TrueNAS

One container runs the server, the SQLite database, the nightly JSON dumps, and
the reminder scheduler. The checked-in Compose service is `app/compose.yaml`;
CI publishes the image to GHCR (`.github/workflows/ci.yml` owns the build and
smoke-test details).

## 1. Dataset

Create `/mnt/fast_pool/app_data/migraine-tracker/data`. The database
(`migraine.db` plus `-wal`/`-shm`) and rotating nightly dumps under
`data/backups/` live there; mount that directory at `/data`.

## 2. Get the image onto the NAS

The standard deployment copies **no source** to the NAS and pulls:

```
ghcr.io/bradybrenot/migraine-tracker:latest
```

`latest` moves only while the publishing run's commit is still the tip of
`main`. Every completed publish also creates an immutable-in-normal-use
`sha-<full-commit>` tag for pinning and rollback.

### GHCR visibility

Make the package public **once** after the first publish (owner **Packages** ->
package -> **Package settings -> Danger Zone -> Change visibility -> Public**).
This exposes nothing new: the source repository is public, the image contains
no health data (records live in `/data`) and no ntfy credentials.

- **Visibility is one-way.** GitHub warns that a public package cannot be made
  private again; confirm the package before flipping it.
- A new package is private by default even for a public repository. If a later
  publish fails with a permission error, grant this repository write access
  under **Package settings -> Manage Actions access**.
- TrueNAS SCALE **25.10 / Goldeye** private-registry support in the Apps UI is
  unreliable for pulls and updates. Anonymous public pulls behave the same on
  every version, so public is the dependable path here.

### Alternative: keep the package private

Pulls then need a GitHub **classic** PAT with `read:packages` (fine-grained
PATs cannot carry package scopes) and a shell login:

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u <github-username> --password-stdin
```

That stores the credential in the user's `~/.docker/config.json` (or configured
helper); no secret goes into `compose.yaml`. The TrueNAS Apps UI registry
sign-in is **not** dependable on 25.10/Goldeye; on that version manage a private
package with shell-managed Compose and the login above. A shell login and an
Apps UI credential do not necessarily cover each other.

### Alternative: build locally from source

Copy or clone the repository and build from the repository root:

```bash
docker build -t migraine-tracker:local ./app
```

The build needs `app/`'s Dockerfile, `.dockerignore`, package files,
`index.html`, `view.html`, Vite/TS/Tailwind/PostCSS configs, `src/`, `shared/`,
`public/`, and `server/` (without `node_modules` or `server/data`). Use
`image: migraine-tracker:local` and remove `pull_policy: always`; a local tag is
not in a registry, is not published/scanned by CI, and needs its own smoke
check.

## 3. Reminders and alerts (environment only)

Never put these in app settings, the database, an export, or this repository.
Leave a URL unset/empty to disable that feature.

| Variable | Required | Meaning |
| --- | --- | --- |
| `NTFY_URL` | reminders | Full ntfy topic publish URL, e.g. `https://ntfy.example.net/migraine`. Must be `http(s)` and carry no credentials/query string. |
| `NTFY_TOKEN` | no | Bearer token for the reminder topic; sent only in `Authorization`. |
| `NTFY_ATTACK_URL` | attack alerts | Full publish URL for attack start/end alerts; use a topic separate from reminders, same validation. |
| `NTFY_ATTACK_TOKEN` | no | Separate bearer token for the attack topic; never shared with `NTFY_TOKEN`. |
| `PUBLIC_APP_URL` | no | Public HTTPS app URL for notification click links. Attack alerts link to `<PUBLIC_APP_URL>/view`; a malformed value only disables links. |

Set values in the TrueNAS Compose UI, an operator env file, or the shell
environment. Startup logs only whether each topic is disabled and the reason;
it never prints values.

- **One process.** A single scheduler runs on a one-minute interval. Do not run
  multiple replicas: it is not a horizontally scaled service.
- Reminders respect configured waking hours and the IANA timezone; daily
  check-in/exercise prompts may redeliver for about two hours, while persistent
  conditions (preventive due, low stock) wait for the next waking window.
- Delivery is at-least-once around a crash; a 2xx from ntfy only means ntfy
  accepted the publish request, not that a phone displayed it.
- Attack start/end alerts are event-driven and near-immediate best-effort. They
  ignore the personal master switch, per-type toggles, and waking hours. An
  event must be within 60 minutes past to 5 minutes future when written; older
  writes and backfills do not alert, and an undelivered alert is dropped 24
  hours after the event. Messages carry only event time/date and optional
  duration.
- `GET /api/health` returns `{ ok, notifications: { reminders, attackAlerts } }`
  booleans only — never URLs, tokens, or failure detail.

### Weather pressure drops (optional, off by default)

Enable in Settings with a saved city. The city search and coordinates go to
Open-Meteo (`geocoding-api.open-meteo.com`, `api.open-meteo.com`) with no API key
or environment variable. Only pressure drops are assessed: a warning means the
hourly mean-sea-level pressure falls by the configured threshold (default `5`
hPa, a starting point, not a clinical threshold) within the next 24 hours. At
most one notification is sent per episode; it obeys the reminder master switch,
weather toggle, and waking hours, and contains the drop magnitude and target
time — not the city. Only the city/threshold are settings (exported and backed
up); forecast cache and episode/delivery state are internal and excluded.
Failures keep the last forecast (marked stale) or show a calm error, and never
send a message. Open-Meteo data is CC BY 4.0 and non-commercial/rate-limited;
its terms allow troubleshooting logs with coordinates for 90 days.

## 4. Back up before any migration

Schema upgrades are additive (current build migrates older databases to v4
without rewriting rows), but take a stopped-container copy first, especially
before an image change or rollback:

```bash
set -eu
cd /mnt/fast_pool/app_data/migraine-tracker
docker stop migraine-tracker
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="backups/pre-migration-$stamp"
mkdir -p "$dest"

if [ ! -f data/migraine.db ]; then
  echo "ERROR: data/migraine.db not found; nothing to back up." >&2
  exit 1
fi
cp -a data/migraine.db "$dest/migraine.db"

copied_sidecars=""
for sidecar in data/migraine.db-wal data/migraine.db-shm; do
  if [ -f "$sidecar" ]; then
    cp -a "$sidecar" "$dest/"
    copied_sidecars="$copied_sidecars $sidecar"
  fi
done

if [ ! -s "$dest/migraine.db" ]; then
  echo "ERROR: $dest/migraine.db is missing or empty; aborting." >&2
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

Copy `migraine.db` **and** any `-wal`/`-shm` sidecars together while the
container is stopped; a database without its WAL can lose recent writes. A
zero-length WAL is valid. Keep the backup outside the live `data/` mount (or in
a timestamped folder Backrest also covers), and do not delete it until the app,
export, and nightly dump have been verified.

To restore SQLite: stop the container, remove the live
`migraine.db`/`-wal`/`-shm`, copy the backed-up files into `data/`, and start
again. A JSON dump is not a drop-in replacement for these files.

## 5. Compose service, updates, rollback

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
      NTFY_URL: ${NTFY_URL:-}
      NTFY_TOKEN: ${NTFY_TOKEN:-}
      NTFY_ATTACK_URL: ${NTFY_ATTACK_URL:-}
      NTFY_ATTACK_TOKEN: ${NTFY_ATTACK_TOKEN:-}
      PUBLIC_APP_URL: ${PUBLIC_APP_URL:-}
```

Paste this into TrueNAS **Apps -> Custom App**, or use shell Compose from the
directory holding the file. `pull_policy: always` makes a recreate re-check
`latest`, so an update is pull-and-recreate, not rebuild. CI never deploys to
the NAS. In the Apps UI, use the app's update/recreate action (the exact label
varies by TrueNAS version). For shell-managed Compose, run:

```bash
docker compose pull
docker compose up -d
```

Either path restarts against the same `/data` dataset and runs additive
migrations at startup. Take the section-4 backup first if the schema may change.

### Rollback

Pin the service to a `sha-<full-commit>` tag from a known-good publish and
recreate (drop `pull_policy: always` while pinned; a `sha-` tag does not move in
normal operation). Re-running that commit's publish job rebuilds from the
floating Node base tag and can overwrite the tag's contents; base-image digests
are deliberately not pinned.

Schema caveat: a build older than a migration refuses to start against a
database a newer image already migrated. If the rollback crosses a migration,
restore the section-4 backup taken before that upgrade instead of only
repointing the tag.

## 6. Access and security boundary

- Keep the app on Tailscale only (for example
  `https://migraine.crustaceansoup.com` through the existing HTTPS reverse
  proxy), or `http://<truenas-tailscale-hostname>:8097` for local checks.
- **The API has no authentication.** The tailnet is the boundary; never expose
  the container on a public interface or public tunnel.
- HTTPS is required for mobile Chrome installation checks.
- A mutating request with an `Origin`/`Referer` whose `host:port` differs from
  the request `Host` gets `403 cross-origin request denied`; reads are never
  blocked, requests without either header are allowed, and the scheme is not
  compared (TLS may terminate at the proxy). If a proxy rewrites `Host`, saves
  fail with 403 while reads work: preserve the original header, e.g.
  `proxy_set_header Host $host;` in nginx. This is not authentication.
- `/view` is a read-only partner page (`GET /api/export`, refreshed about every
  20 seconds and on focus/visibility) with a visible **Read only** label and no
  editing, refills, imports/exports, downloads, or Settings. It is
  accidental-edit protection only, **not** authorization.

## 7. Backups and restore expectations

Backrest should cover
`/mnt/fast_pool/app_data/migraine-tracker/data`, which holds:

1. `data/backups/migraine-YYYY-MM-DD.json` — a full export written once a day
   (checked hourly, written at startup if missing), keeping the newest 31.
2. The SQLite files themselves.

Internal reminder/attack delivery bookkeeping is excluded from exports and
nightly dumps; ntfy credentials are never included.

In-app **Settings -> Data** restore accepts browser exports and the versioned
envelopes from `GET /api/export` and nightly dumps. Newer-schema or malformed
payloads are rejected, never partially restored. Two explicit modes:

- **Merge missing records** adds only IDs (day states: days) not already
  present; never overwrites/deletes records or changes settings. Uses additive
  `/api/import` (`INSERT OR IGNORE`).
- **Replace everything** is a second confirmed destructive action. `POST
  /api/restore` validates the whole payload, then in one SQLite transaction
  clears and re-inserts records/settings, and clears internal delivery state.
  Any error rolls the entire replacement back; success returns the canonical
  export envelope, which the browser adopts (it never erases local data
  optimistically first). Duplicate IDs make replace fail atomically (merge
  keeps the first). Bulk import/restore bodies are limited to 25 MiB; larger
  backups need the stopped-container file restore in section 4.

Secret/environment configuration (ntfy URLs/tokens, `PUBLIC_APP_URL`) is never
backup content and is never restored. `/api/import` stays additive and does not
touch settings or reminder state. CSV import is not a JSON restore. The
stopped-container SQLite restore remains the disaster-recovery path.

## 8. First run and mobile install

On first contact, local browser data is pushed to an empty server; after that
the server is canonical and the browser is a cache. Set the timezone and
reminder preferences in Settings, then verify stock and calendar.

Open the HTTPS hostname on Android Chrome -> menu -> **Install app**, or iOS
Share -> **Add to Home Screen**. The app is online-only: no service worker,
offline cache, Web Push, or background sync. The partner installs separately
from `https://<host>/view` as **Migraine Partner**, with its own icon and name,
always opening the read-only view.

No deployment, real-data migration, or real notification is performed by this
checkout; treat all values above as placeholders.
