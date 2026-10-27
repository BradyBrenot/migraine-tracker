## What
It's a self-hosted migraine tracker. It tracks migraines. It has a very simple homepage with very simple, immediate, low-friction controls. No annoying animations or subscreens to work through to report an attack.

Host on anything that can run Docker.

There's no authentication here, you should hide this behind a VPN or something (Tailscale is nice)

## Deployment

The slop bot has written DEPLOY.md. It's awful to read because AI writing is insufferable, but essentially

1. No clone or source copy needed: CI publishes a tested image to GitHub Container Registry (`ghcr.io`), so you just run it with Docker Compose.
2. Docker Compose with contents:

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

See DEPLOY.md for first-publish setup (including making the GHCR package public), updates, rollback to `sha-<commit>` tags, and building the image locally from source as the alternative.

## Live demo (GitHub Pages)

A frontend-only demo is published at
<https://bradybrenot.github.io/migraine-tracker/> by the same CI workflow.
It is the writer app with fictional sample data preloaded:

- every interaction (attacks, medications, day check-ins, settings, import,
  export, restore, erase) works **in memory only**;
- reloading restores the sample data — nothing is saved, and nothing is sent to
  a backend (the demo makes no API/network requests and does not read or write
  this site's local/session storage);
- the weather forecast and partner `/view` shell need the backend, so weather
  is unavailable and `/view*` redirects to the demo home;
- **do not enter real health information** — the banner is permanent and the
  demo is public.

One-time repository setup: **Settings -> Pages -> Source = GitHub Actions**.
Deployment is gated to pushes/manual dispatches of `main` in
`BradyBrenot/migraine-tracker`; pull requests and forks never deploy. The
normal Docker/GHCR image and production behavior are unchanged.

Environment variables are used for setting up ntfy and nothing else.

| Variable | Required | Meaning |
| --- | --- | --- |
| `NTFY_URL` | reminders | ntfy **topic publish URL**. For personal reminders. You can use the public one, in which case `https://ntfy.sh/<my-secret-topic>` |
| `NTFY_TOKEN` | no | Only if ntfy host requires a bearer token |
| `NTFY_ATTACK_URL` | for attack alerts | Similar to above, but this just alerts when you've marked an attack as starting. Intended for use by partners / caregivers. |
| `NTFY_ATTACK_TOKEN` | no | Token, as above. |
| `PUBLIC_APP_URL` | no | Public HTTPS app URL used for the notification click link, e.g. `https://migraine.example.net`|

There's no way to directly customize the medications. I could add that, though you could also just vibecode that up.

## Use

Mostly self-explanatory. As above, some things can maybe not be configured. You can record and modify additional historic data in the History tab.

### Partner view

At `https://migraine.example.net/view` you'll get a read-only "view mode", intended for use by partners / caregivers so they don't accidentally click any settings.

There is no auth, they can just access the main mode and mess with things. Anyone with network access can.

### PWA (install on mobile)

The main mode and partner view both support installing as an "app" on mobile. In Android Chrome for example, open the menu, swipe down and click on **Install**

### Weather pressure drops (optional)

Weather warnings are **off by default** and the app works normally without
them. In Settings, search for a city (search text and the chosen coordinates are
sent to [Open-Meteo](https://open-meteo.com/); no API key and no new environment
variables), pick a pressure-drop threshold (default 5 hPa), then enable the
toggle.

- Only **pressure drops** are assessed: a warning means pressure falls by at
  least the configured threshold within the next 24 hours from the current
  hourly baseline. The default 5 hPa is a configurable starting point, not a
  validated clinical cutoff.
- Current temperature, humidity and pressure are shown as neutral context and
  never trigger anything.
- Reminders send at most **one ntfy message per pressure-drop episode**, and
  only when the weather per-type switch, the personal reminder master switch,
  and waking hours all allow it. The message contains the drop magnitude and
  target time, not the saved city.
- The Home card shows the last successful forecast during a temporary upstream
  failure (marked stale) and a calm error message when there is none; stale or
  unknown data never sends a notification.
- This is not a medical prediction. Use it as one optional signal alongside how
  you actually feel; no threshold is universal.
- Forecast data comes from the free [Open-Meteo](https://open-meteo.com/) API,
  which is non-commercial and rate-limited; the data is provided under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Per
  [Open-Meteo's terms](https://open-meteo.com/en/terms), troubleshooting logs
  may contain the requested coordinates and are deleted after 90 days.
- Notification delivery keeps the existing at-least-once caveat: a crash between
  ntfy accepting a message and the app recording it can resend that message.

### Backups

The database is backed up nightly to `data/backups/migraine-YYYY-MM-DD.json`, or can be manually exported.

Presently this can only be restored using the `/api/import` endpoint. Need to improve this flow.

## Why vibecode

Because I have migraines and don't want to spend my off-hours coding and giving myself more of them right now. And hey look, a pretty usable and relatively robust app.

Also partly as an experiment, partly to learn, partly because web/mobile dev is not my forte.

Every bit of this (aside from this file, I'm not _that_ lazy) was vibecoded, so if the code reads like slop that's because it is.

## How vibecode

OpenCode + Kimi K3.1 Pro (Kimi.ai) + GLM 5.3 (Z.ai Coding Plan) + DeepSeek v4.1 Flash (DeepSeek Platform), set up hierarchically.

## Screenshots
<img width="882" height="768" alt="image" src="https://github.com/user-attachments/assets/69b2605e-4dee-4400-bffe-b2378ac55718" />

### Calendar
<img width="865" height="1232" alt="image" src="https://github.com/user-attachments/assets/bd2b51b7-50ab-450a-9fa5-d0bf097101e3" />

### Reports
<img width="849" height="1270" alt="image" src="https://github.com/user-attachments/assets/8eb35834-7146-41ad-9ad6-6c2948744ec4" />
