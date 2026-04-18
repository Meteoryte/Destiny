# Moonmoon Destiny Tracker — Full Documentation

> **Repo:** https://github.com/Meteoryte/Destiny
> **Live site:** https://meteoryte.github.io/Destiny/

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [File Map](#file-map)
3. [How Everything Connects](#how-everything-connects)
4. [The Watcher (Backend)](#the-watcher-backend)
5. [The Website (Frontend)](#the-website-frontend)
6. [GitHub Actions Workflow](#github-actions-workflow)
7. [Configuration Reference](#configuration-reference)
8. [Twitch API Setup](#twitch-api-setup)
9. [OCR Tuning Guide](#ocr-tuning-guide)
10. [Troubleshooting](#troubleshooting)
11. [Common Adjustments](#common-adjustments)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    GitHub Actions                        │
│          (runs every 10 min via cron)                    │
│                                                         │
│  1. Checkout repo                                       │
│  2. npm install + playwright install                    │
│  3. Run watcher/watch.js --once                         │
│  4. Commit updated tracker.json + images                │
│  5. Push back to main branch                            │
└─────────────────────┬────────────────────────────────────┘
                      │ commits new data
                      ▼
┌──────────────────────────────────────────────────────────┐
│              GitHub Repository (main branch)             │
│                                                         │
│  tracker.json ← updated by watcher                      │
│  latest-frame.png ← full screenshot                     │
│  latest-crop.png ← OCR crop preview                     │
│  index.html ← the full website                          │
└─────────────────────┬────────────────────────────────────┘
                      │ served by GitHub Pages
                      ▼
┌──────────────────────────────────────────────────────────┐
│            User's Browser                                │
│                                                         │
│  index.html loads → fetches tracker.json every 15s      │
│  Updates attempt #, live status, OCR text, market sim   │
└──────────────────────────────────────────────────────────┘
```

**Key idea:** The watcher runs server-side in GitHub Actions (not locally). It writes `tracker.json` back to the repo. The static site hosted on GitHub Pages reads that JSON on a polling loop and renders the UI.

---

## File Map

```
moonmoon_tracker_site/          ← REPO ROOT
├── .github/
│   └── workflows/
│       └── update-tracker.yml  ← GitHub Actions cron job (every 10 min)
├── .gitignore                  ← excludes .env and node_modules
├── README.md                   ← basic setup instructions
├── DOCS.md                     ← THIS FILE — full documentation
├── index.html                  ← the entire website (HTML + CSS + JS, single file)
├── tracker.json                ← current watcher output (auto-updated by Actions)
├── last_vod.json               ← archived VOD snapshot for the "Last VOD" tab
├── latest-frame.png            ← most recent full-frame screenshot from watcher
├── latest-crop.png             ← most recent OCR crop/processed image
├── attempt-frame.png           ← reference screenshot
├── timestamp-player.png        ← reference screenshot
└── watcher/
    ├── .env.example            ← template for Twitch credentials
    ├── .env                    ← YOUR credentials (git-ignored, local only)
    ├── config.json             ← watcher configuration (OCR, polling, crop, etc.)
    ├── watch.js                ← the Node.js watcher script
    ├── package.json            ← npm scripts and dependencies
    ├── package-lock.json       ← lockfile
    └── eng.traineddata         ← Tesseract English language model
```

---

## How Everything Connects

### Data flow (every 10 minutes):

1. **GitHub Actions** triggers `update-tracker.yml`
2. The workflow installs Node 20 + Playwright + dependencies
3. Runs `node watcher/watch.js --once`
4. The watcher:
   - Calls **Twitch Helix API** to check if `moonmoon` is live
   - If live: opens headless Chromium, navigates to the stream page
   - Waits for it to settle (12 seconds by default)
   - Dismisses overlays (Start Watching, Accept buttons)
   - Screenshots the video player element
   - Runs **Tesseract OCR** on the screenshot to find the attempt number
   - Parses text like `ATTEMPT #468` from the OCR output
5. Writes results to `tracker.json`
6. GitHub Actions commits and pushes the changes

### Frontend polling (every 15 seconds):

1. `index.html` fetches `tracker.json?t=<timestamp>` (cache-busted)
2. Merges data into the page state
3. Re-renders all UI sections (hero stats, tracker panel, market sim, etc.)

---

## The Watcher (Backend)

### File: `watcher/watch.js`

**Dependencies:** `playwright`, `sharp`, `tesseract.js`

### Key Functions

| Function | What it does |
|----------|-------------|
| `main()` | Entry point. Loads `.env`, reads config, runs tick loop or single run |
| `runOnce()` | One complete cycle: API check → screenshot → OCR → write tracker.json |
| `loadLocalEnv()` | Reads `.env` from watcher dir or parent dir, sets `process.env` vars |
| `readConfig()` | Reads `watcher/config.json` |
| `getStreamSnapshot(config)` | Calls Twitch API for stream status. Returns user + stream data |
| `getAppAccessToken()` | Gets OAuth token using client credentials flow |
| `captureAndOcr(config)` | Launches headless browser, screenshots, crops, runs Tesseract |
| `parseAttempt(text)` | Extracts attempt number from OCR text (e.g., `"ATTEMPT #468"` → `468`) |
| `buildTracker()` | Assembles the final `tracker.json` object from all collected data |
| `buildApiErrorTracker()` | Fallback tracker when Twitch API fails |
| `getTestVod(config)` | Returns VOD test config if `testVod.enabled` is true |

### OCR Scan Modes

| Mode | Behavior |
|------|----------|
| `full_frame` | Scans the entire video player screenshot. **Currently active.** |
| `crop` | Crops a specific rectangle from the screenshot before OCR |

### Attempt Parsing Logic (`parseAttempt`)

The parser handles janky OCR by:
1. Replacing common OCR errors: `O` → `0`, `I/l/|` → `1`
2. Looking for patterns in priority order:
   - `attempt #468` or `attempt 468`
   - `#468`
   - Any standalone number between 1 and 100,000
3. Returns the first valid candidate

### Error Handling

- **Twitch API fails:** Writes a fallback tracker with `watcher_status: "api error: ..."` and retains previous title/game
- **OCR fails:** Writes tracker with `watcher_status: "ocr error: ..."`, stream data still preserved
- **Stream offline:** Skips OCR entirely, writes `live: false`

---

## The Website (Frontend)

### File: `index.html` (single-file app, 2053 lines)

Everything is in one file: HTML structure (lines 1–821), CSS (lines 8–393), JavaScript (lines 823–2050).

### Page Sections

| Section | ID | Description |
|---------|----|-------------|
| Navigation | `.nav` | Sticky top bar with section links |
| Hero | — | Attempt #, stream status, OCR confidence, AI water counter, Twitch embed |
| Live Tracker | `#tracker` | Market card with chance %, delta, SVG chart, volume + info grid with all watcher data |
| Exchange | `#exchange` | Paper trading: YES/NO contracts + Mooncoin desk + trade blotter |
| Lore | `#lore` | Three pillar cards about the phone/destiny/Oba Doba bit |
| Copypasta | `#copypasta` | AI psychosis copypasta generator with 3 styles + copy button |
| Destiny | `#destiny` | Final quote section |
| Footer | `.footer` | "Pulse the timeline" button |

### Key JavaScript Systems

#### 1. Tracker Polling
```
loadTracker() → fetches tracker.json every 15 seconds
loadArchivedVodSnapshot() → fetches last_vod.json every 30 seconds
```

#### 2. Twitch Embed Switcher
- **Live tab:** embeds `player.twitch.tv` with `channel=moonmoon`
- **VOD tab:** embeds a specific VOD video ID with timestamp
- Uses `location.hostname` as the Twitch `parent` parameter (required by Twitch)
- VOD URL is remembered in `localStorage` across page loads

#### 3. Paper Trading Exchange (browser-local, `localStorage`)
- **YES/NO contracts:** Kalshi-style prediction market
- **Mooncoin:** Fictional alt-coin desk
- Market chance is seeded from actual OCR data + simulated volatility
- Prices tick every 3.5 seconds (`MARKET_TICK_MS`)
- All positions, history, and activity saved to `localStorage` key `moonmoon-paper-exchange-v1`
- Chart renders up to 420 historical points as a smooth SVG bezier path
- Range buttons: 6H, 1D, 1W, 1M, ALL

#### 4. Market Simulation (`simulateMarketTick`)
- Runs every 3.5 seconds client-side
- Anchors to a "base chance" derived from attempt number + OCR confidence
- Adds random volatility, mean reversion, and position bias
- Updates both chance chart and Mooncoin price
- Randomly generates sweep activity items for the trade blotter

#### 5. AI Water Counter
- Starts at 98,772,441 bottles
- Increments by a random amount every 1.2 seconds
- Persisted in `localStorage` key `moonmoon-ai-water-v1`

#### 6. Display Snapshots
- The site remembers the last known "live" and "vod" snapshots in `localStorage`
- When switching tabs (Live vs VOD), it pulls the appropriate snapshot
- This means the VOD tab retains its last-known data even if the current tracker state is live

### localStorage Keys

| Key | Purpose |
|-----|---------|
| `moonmoon-paper-exchange-v1` | Paper trading state (cash, shares, history, activity) |
| `moonmoon-last-vod-url-v1` | Last known VOD URL for the embed tab |
| `moonmoon-live-snapshot-v1` | Cached live tracker snapshot for tab switching |
| `moonmoon-vod-snapshot-v1` | Cached VOD tracker snapshot for tab switching |
| `moonmoon-ai-water-v1` | AI water bottle counter state |

---

## GitHub Actions Workflow

### File: `.github/workflows/update-tracker.yml`

```yaml
schedule: '*/10 * * * *'    # every 10 minutes
workflow_dispatch:           # manual trigger also available
```

### What it does:

1. **Checkout** — clones the repo
2. **Setup Node 20** — via `actions/setup-node@v4`
3. **Install dependencies** — `npm install` + `npx playwright install --with-deps chromium`
4. **Run watcher** — `node watcher/watch.js --once` with env secrets
5. **Commit & push** — auto-commits `tracker.json`, `latest-crop.png`, `latest-frame.png`

### Required Repo Secrets

Set these at `https://github.com/Meteoryte/Destiny/settings/secrets/actions`:

| Secret | Value |
|--------|-------|
| `TWITCH_CLIENT_ID` | Your Twitch app Client ID |
| `TWITCH_CLIENT_SECRET` | Your Twitch app Client Secret |

### Manual Trigger

Go to Actions tab → "Update tracker" → "Run workflow" → select `main` branch → Run.

---

## Configuration Reference

### File: `watcher/config.json`

```jsonc
{
  "channelName": "moonmoon",           // Twitch username to watch
  "pageUrl": "https://www.twitch.tv/moonmoon",  // Page to open for OCR

  "testVod": {                          // VOD test mode (for debugging)
    "enabled": false,                   // set true to test with a VOD instead of live
    "pageUrl": "https://www.twitch.tv/videos/2750608960",
    "startAt": "2h36m53s",              // jump to this timestamp
    "title": "...",
    "gameName": "Ready or Not",
    "viewerCount": 0
  },

  "pollIntervalMs": 60000,             // loop interval when running continuously (ms)

  "viewport": {                         // headless browser viewport size
    "width": 1600,
    "height": 900
  },

  "ocr": {
    "enabled": true,                    // master OCR toggle
    "settleMs": 12000,                  // wait time (ms) after page load before screenshot
    "scanMode": "full_frame",           // "full_frame" or "crop"
    "scale": 2,                         // upscale factor for crop preprocessing
    "threshold": 165,                   // binarization threshold (0-255)
    "psm": 11,                          // Tesseract page segmentation mode
    "whitelist": "A-Z a-z 0-9 # : - ", // character whitelist for crop mode
    "captureSelectors": [               // CSS selectors to try for video element
      "video",
      "[data-a-target='video-player']",
      ".video-player"
    ],
    "crop": {                           // crop region as % of viewport (only used in crop mode)
      "x": 27,
      "y": 63,
      "width": 36,
      "height": 9
    },
    "dismissSelectors": [               // buttons to click to dismiss overlays
      "button:has-text('Start Watching')",
      "button:has-text('Accept')",
      "button[data-a-target='player-overlay-click-handler']"
    ]
  },

  "output": {
    "trackerPath": "tracker.json",      // output JSON path (relative to site root)
    "screenshotPath": "latest-frame.png",
    "cropPath": "latest-crop.png"
  },

  "site": {                             // static values passed through to the frontend
    "chance": 0,
    "delta": 6.3,
    "volume": 8073206
  }
}
```

---

## Twitch API Setup

The watcher uses the **Client Credentials** OAuth flow (server-to-server, no user login needed).

### How to create a Twitch app:

1. Go to https://dev.twitch.tv/console/apps
2. Click "Register Your Application"
3. **Name:** anything (e.g., "Destiny Tracker")
4. **OAuth Redirect URL:** `http://localhost`
5. **Category:** anything
6. **Client Type:** `Confidential`
7. Click "Create"
8. Copy the **Client ID** and generate a **Client Secret**

### Where credentials are used:

| Context | Location |
|---------|----------|
| Local development | `watcher/.env` file |
| GitHub Actions | Repo secrets (`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`) |

### API calls made by the watcher:

1. `POST https://id.twitch.tv/oauth2/token` — get access token
2. `GET https://api.twitch.tv/helix/users?login=moonmoon` — get user info
3. `GET https://api.twitch.tv/helix/streams?user_login=moonmoon` — check if live

---

## OCR Tuning Guide

### Current setup: Full Frame mode

The watcher screenshots the entire video player and runs OCR across the whole image. Tesseract looks for text like `ATTEMPT #468` anywhere in the frame.

### When OCR fails or reads wrong:

**Symptom:** `attempt: null` in tracker.json even when on stream
**Possible causes:**
- The attempt text isn't visible on screen at that moment
- The text is too small, overlapped, or stylized for Tesseract
- The page didn't fully load (increase `settleMs`)
- Twitch showed an overlay that wasn't dismissed

### Switching to Crop mode:

If full_frame is too noisy, switch to targeted crop:

1. Edit `watcher/config.json`:
   ```json
   "scanMode": "crop"
   ```
2. Adjust the `crop` box to target where the attempt counter appears:
   ```json
   "crop": {
     "x": 27,      // % from left edge
     "y": 63,      // % from top edge
     "width": 36,  // % of total width
     "height": 9   // % of total height
   }
   ```
3. Run once locally: `node watcher/watch.js --once`
4. Check `latest-crop.png` to see what Tesseract is reading
5. Adjust crop values until the attempt text is cleanly captured

### Tuning parameters:

| Parameter | Effect | When to change |
|-----------|--------|----------------|
| `settleMs` | How long to wait after page load | Increase if page loads slowly (12000 = 12s) |
| `threshold` | Binarization cutoff (0-255) | Lower = more text detected, higher = cleaner but may miss faint text |
| `scale` | Upscale factor for preprocessing | Higher = better OCR on small text, but slower |
| `psm` | Tesseract page segmentation mode | `7` = single text line (crop), `11` = sparse text (full_frame) |
| `dismissSelectors` | Overlay buttons to auto-click | Add new selectors if Twitch adds new overlays |

### Debug workflow:

1. Run `node watcher/watch.js --once`
2. Open `latest-frame.png` — is the stream visible?
3. Open `latest-crop.png` — is the attempt text captured?
4. Check `tracker.json` → `ocr_text` — what did Tesseract read?
5. Check `ocr_confidence` — above 50 is decent, above 70 is good

---

## Troubleshooting

### GitHub Actions fails with "TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are required"

**Fix:** Add repo secrets at https://github.com/Meteoryte/Destiny/settings/secrets/actions

### GitHub Actions fails with Playwright error

**Fix:** The workflow already runs `npx playwright install --with-deps chromium`. If it still fails, check the Actions log for missing system dependencies.

### tracker.json shows `"live": false` even when moonmoon is streaming

**Possible causes:**
- The Twitch API token expired or credentials are wrong
- The channel name is misspelled in config.json
- The Actions workflow hasn't run yet (check Actions tab for last run time)

### OCR reads the wrong number

**Fix:** Switch from `full_frame` to `crop` mode and target just the attempt counter area. See [OCR Tuning Guide](#ocr-tuning-guide).

### The website shows stale data

The site polls `tracker.json` every 15 seconds. But GitHub Actions only runs every 10 minutes, so data can be up to ~10 minutes old. This is a GitHub Actions limitation.

### Twitch embed doesn't work locally

The embed requires a valid `parent` hostname. Opening `index.html` from `file://` won't work. Either:
- Deploy to GitHub Pages (which provides a real hostname)
- Use a local server: `npx serve .` in the site root

### Paper trading data is wrong/stuck

All paper trading state lives in the browser's `localStorage`. To reset:
- Click "Reset the ledger" button on the site
- Or clear localStorage manually: `localStorage.removeItem('moonmoon-paper-exchange-v1')`

---

## Common Adjustments

### Change the Twitch channel

1. Edit `watcher/config.json`:
   ```json
   "channelName": "new_channel_name",
   "pageUrl": "https://www.twitch.tv/new_channel_name"
   ```
2. Commit and push

### Change how often the watcher runs

Edit `.github/workflows/update-tracker.yml`:
```yaml
schedule:
  - cron: '*/5 * * * *'   # every 5 minutes (uses more Actions minutes)
```

**Note:** GitHub Actions free tier gives 2,000 minutes/month. At 10-min intervals, the watcher uses ~4,320 minutes/month. At 5-min intervals, it doubles. Consider keeping it at 10 or even 15-min intervals.

### Change what the watcher outputs

Edit `watcher/config.json` → `output` section. The tracker JSON path, screenshot path, and crop path can all be renamed. If you rename them, also update:
- The `git add` line in `update-tracker.yml`
- The `fetch()` URL in `index.html` (line ~1931 for tracker, line ~1947 for VOD)

### Add a new dismiss selector

If Twitch adds a new popup/overlay that blocks the video:
```json
"dismissSelectors": [
  "button:has-text('Start Watching')",
  "button:has-text('Accept')",
  "button[data-a-target='player-overlay-click-handler']",
  "button:has-text('New Button Text')"
]
```

### Disable OCR entirely

```json
"ocr": {
  "enabled": false
}
```

The watcher will still check stream status via the API but won't screenshot or run OCR.

### Test with a VOD instead of live stream

```json
"testVod": {
  "enabled": true,
  "pageUrl": "https://www.twitch.tv/videos/VIDEO_ID",
  "startAt": "1h30m0s",
  "title": "Test title",
  "gameName": "Game Name",
  "viewerCount": 0
}
```

This makes the watcher navigate to the VOD URL instead of checking the live API. Useful for testing OCR crop positioning.

---

## tracker.json Schema

The watcher outputs this JSON, which the frontend reads:

```jsonc
{
  "channel": "moonmoon",                    // Twitch username
  "page_url": "https://www.twitch.tv/moonmoon",  // URL opened for OCR
  "source_mode": "live",                    // "live" or "vod_test"
  "live": true,                             // is stream currently live?
  "title": "solo hard | ...",               // stream title
  "game_name": "Ready or Not",             // current game category
  "viewer_count": 12345,                    // current viewer count
  "started_at": "2026-04-18T...",           // stream start time (ISO)
  "attempt": 468,                           // parsed attempt number (null if not found)
  "ocr_confidence": 72.5,                  // Tesseract confidence (0-100)
  "ocr_text": "A NEW AMERICA ATTEMPT #468", // raw OCR text output
  "ocr_scope": "full_frame",               // scan mode used
  "last_update": "2026-04-18T07:54:14Z",   // when this was written
  "watcher_status": "stream live",          // human-readable status
  "screenshot_path": "latest-frame.png",    // relative path to screenshot
  "crop_path": "latest-crop.png",           // relative path to crop
  "notes": "ocr read succeeded",           // diagnostic notes
  "delta": 6.3,                             // passthrough from config.site
  "chance": 0,                              // passthrough from config.site
  "volume": 8073206                         // passthrough from config.site
}
```
