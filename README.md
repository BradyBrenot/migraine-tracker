## What
It's a self-hosted migraine tracker. It tracks migraines. It has a very simple homepage with very simple, immediate, low-friction controls. No annoying animations or subscreens to work through to report an attack.

Host on anything that can run Docker.

There's no authentication here, you should hide this behind a VPN or something (Tailscale is nice)

## Live demo (GitHub Pages)

A frontend-only demo is published at
<https://bradybrenot.github.io/migraine-tracker/>

## Deployment

The slop bot has written DEPLOY.md. It's awful to read because AI writing is insufferable, but essentially

Docker Compose with contents:

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

### Weather info (pressure drop alerts)

Off by default, set up in Settings

### Backups

The database is backed up nightly to `data/backups/migraine-YYYY-MM-DD.json`, or can be manually exported from Settings. Can be imported in Settings.

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
