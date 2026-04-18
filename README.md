# Moonmoon Destiny Tracker

A static GitHub Pages site plus a separate Node watcher that combines:

- Twitch API stream status
- OCR over a cropped screenshot of the Twitch page
- a fake Kalshi-style market card
- full "this is the one" psychosis energy

## What is in this folder?

- `index.html` — the whole website
- `tracker.json` — current tracker state consumed by the website
- `latest-crop.png` — most recent OCR crop preview
- `latest-frame.png` — most recent full-frame screenshot from the watcher
- `watcher/` — Node script that updates the tracker files
- `.github/workflows/update-tracker.yml` — optional scheduled GitHub Action

## How it works

1. The website polls `tracker.json` every 15 seconds.
2. The watcher calls Twitch API to see whether `moonmoon` is live.
3. If live, it opens the Twitch page in headless Chromium.
4. It screenshots the page, crops a configurable region, preprocesses it, and runs OCR.
5. It writes the result back into `tracker.json` and saves the latest crop preview image.

## Important caveat

OCR is the janky part.

You will almost certainly need to tune the crop box in `watcher/config.json` to match wherever the attempt counter appears on stream. If the stream layout changes, the crop will need to change too.

## Local setup

### 1) Install dependencies

```bash
cd watcher
npm install
npx playwright install chromium
```

### 2) Set Twitch credentials

Create a Twitch developer application and use the `Client ID` plus `Client Secret`.

Important: if you already exposed the secret in a screenshot or message, rotate it in the Twitch console before using it.

For this watcher, the Twitch app should be treated as a server-side app:

- `Client Type`: `Confidential`
- Redirect URL: `http://localhost` is fine for local setup
- Category does not matter for the current `client_credentials` flow

The watcher now supports a local env file. Copy `watcher/.env.example` to `watcher/.env` and fill in your values:

```ini
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret
```

You can still export variables manually if you prefer.

PowerShell:

```powershell
$env:TWITCH_CLIENT_ID="your_client_id"
$env:TWITCH_CLIENT_SECRET="your_client_secret"
```

macOS/Linux:

```bash
export TWITCH_CLIENT_ID=your_client_id
export TWITCH_CLIENT_SECRET=your_client_secret
```

### 3) Tune the OCR crop

Edit `watcher/config.json`.

The crop is expressed as percentages of the viewport screenshot:

```json
"crop": {
  "x": 4,
  "y": 8,
  "width": 20,
  "height": 9
}
```

### 4) Run once

```bash
cd watcher
npm run watch:once
```

### 5) Run continuously

```bash
cd watcher
npm run watch
```

## GitHub Pages deployment

### Site only

Push this folder to a GitHub repo and enable GitHub Pages for the branch/folder containing `index.html`.

### Site + scheduled updates

This repo includes a sample workflow at `.github/workflows/update-tracker.yml`.

Add these repo secrets:

- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`

Then enable Actions. The workflow runs on a schedule, updates `tracker.json` and the images, and commits the result back to the repo.

## Notes on Twitch embed

The site uses the current `location.hostname` as the Twitch `parent` parameter. That means the embed is expected to work after deployment on a real host such as GitHub Pages. Opening the file directly from disk may not work for the embed.

## Files the website expects

The front end reads:

- `tracker.json`
- `latest-crop.png`

If you rename them, update both `index.html` and `watcher/config.json`.
