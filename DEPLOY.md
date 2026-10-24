# Deploying Migraine Tracker to TrueNAS

App conventions per homelab setup: Custom App (Docker Compose) on SCALE Goldeye,
dataset on `fast_pool`, Tailscale-only exposure, Backrest covers the dataset.

## 1. Create the dataset

Dataset: `/mnt/fast_pool/app_data/migraine-tracker` with a `data/` subdirectory
(the SQLite DB lives there).

## 2. Get the app source onto the NAS

Copy the `app/` directory (this project) to:

```
/mnt/fast_pool/app_data/migraine-tracker/app
```

Required contents: `Dockerfile`, `compose.yaml`, `.dockerignore`, `package.json`,
`package-lock.json`, `index.html`, `vite.config.ts`, `tsconfig*.json`,
`tailwind.config.js`, `postcss.config.js`, `src/`, `server/` (without `node_modules`
or `server/data`).

(e.g. via SMB share, or `scp -r app/ truenas:/mnt/fast_pool/app_data/migraine-tracker/app`)

## 3. Create the Custom App

In the TrueNAS UI → Apps → Custom App, use `compose.yaml`:

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
```

If the UI's compose editor doesn't accept `build:` with a path, build once from the
NAS shell instead and reference the image:

```bash
cd /mnt/fast_pool/app_data/migraine-tracker/app
docker build -t migraine-tracker:latest .
```

then use `image: migraine-tracker:latest` in place of `build:`.

## 4. Access

- Tailscale-only: `http://<truenas-tailscale-hostname>:8097`
- No auth — the tailnet is the boundary (consistent with the Pocket-ID decision).

## 5. Backups

Two layers, both inside the Backrest-covered dataset
(`/mnt/fast_pool/app_data/migraine-tracker/data`):

1. **Nightly JSON dump** — the server writes a full export to
   `data/backups/migraine-YYYY-MM-DD.json` once a day (checked hourly, written
   at startup if missing), keeping the newest 31 daily files. These are plain
   JSON you can restore from by hand or via the app's import path.
2. **The SQLite file itself** (`migraine.db` + WAL) — the primary store.

Just make sure `/mnt/fast_pool/app_data/migraine-tracker/data` is in the
Backrest scope; both layers are then covered on Backrest's normal schedule.

## 6. First run

Open the app. If you had data in the browser (imported Migraine Buddy CSV, etc.),
it's pushed to the server automatically on first contact — you'll see a
"synced N attacks" toast. From then on the server is canonical and the browser
is just a cache.

## Notes

- Image tags: this is our own image; rebuild with `docker build` on updates
  (WUD will not track it, which is correct — it's not a registry image).
- Possible later addition: ntfy reminders when Emgality/Botox doses come due.
