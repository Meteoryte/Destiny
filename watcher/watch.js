#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

const rootDir = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const once = args.has('--once');
const configPathArgIndex = process.argv.indexOf('--config');
const configPath = configPathArgIndex !== -1
  ? path.resolve(process.cwd(), process.argv[configPathArgIndex + 1])
  : path.resolve(__dirname, 'config.json');

function parseEnvFile(content) {
  const values = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;

    let [, key, value] = match;
    value = value.trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

async function loadLocalEnv() {
  const envCandidates = [
    path.resolve(__dirname, '.env'),
    path.resolve(rootDir, '.env'),
  ];

  for (const envPath of envCandidates) {
    try {
      const raw = await fs.readFile(envPath, 'utf8');
      const parsed = parseEnvFile(raw);
      for (const [key, value] of Object.entries(parsed)) {
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
      return envPath;
    } catch {}
  }

  return null;
}

async function readConfig() {
  const raw = await fs.readFile(configPath, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(filePath, obj) {
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function nowIso() {
  return new Date().toISOString();
}

function withStartAt(pageUrl, startAt) {
  if (!startAt) {
    return pageUrl;
  }

  try {
    const url = new URL(pageUrl);
    url.searchParams.set('t', startAt);
    return url.toString();
  } catch {
    return pageUrl;
  }
}

function getOcrScanMode(config) {
  return config.ocr?.scanMode === 'full_frame' ? 'full_frame' : 'crop';
}

function getTestVod(config) {
  if (!config.testVod?.enabled) {
    return null;
  }

  return {
    sourceMode: 'vod_test',
    pageUrl: withStartAt(
      config.testVod.pageUrl || config.pageUrl || `https://www.twitch.tv/${config.channelName}`,
      config.testVod.startAt
    ),
    title: config.testVod.title || `${config.channelName} VOD test`,
    gameName: config.testVod.gameName || 'Unknown',
    viewerCount: Number(config.testVod.viewerCount || 0),
    startedAt: config.testVod.startedAt || null,
  };
}

function parseAttempt(text) {
  const normalized = String(text || '').replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  const candidates = [];

  const attemptMatch = normalized.match(/attempt\s*#?\s*(\d{1,5})/i);
  if (attemptMatch) candidates.push(Number(attemptMatch[1]));

  const hashMatch = normalized.match(/#\s*(\d{1,5})/);
  if (hashMatch) candidates.push(Number(hashMatch[1]));

  const plainNumbers = [...normalized.matchAll(/\b(\d{1,5})\b/g)].map((m) => Number(m[1]));
  candidates.push(...plainNumbers);

  const filtered = candidates.filter((n) => Number.isFinite(n) && n >= 1 && n <= 100000);
  return filtered.length ? filtered[0] : null;
}

async function getAppAccessToken(clientId, clientSecret) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw new Error(`token request failed: HTTP ${res.status}`);
  }

  return res.json();
}

async function twitchGet(url, token, clientId) {
  const res = await fetch(url, {
    headers: {
      'Client-Id': clientId,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`twitch api failed: HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

async function getStreamSnapshot(config) {
  const testVod = getTestVod(config);
  if (testVod) {
    return {
      user: {
        login: config.channelName,
        display_name: config.channelName,
      },
      stream: null,
      ...testVod,
    };
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are required');
  }

  const tokenData = await getAppAccessToken(clientId, clientSecret);
  const token = tokenData.access_token;
  const login = config.channelName;

  const userData = await twitchGet(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, token, clientId);
  const user = userData.data?.[0] || null;
  const streamData = await twitchGet(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(login)}`, token, clientId);
  const stream = streamData.data?.[0] || null;

  return {
    user,
    stream,
  };
}

async function captureAndOcr(config, options = {}) {
  if (!config.ocr?.enabled) {
    return {
      attempt: null,
      confidence: 0,
      rawText: '',
      cropSaved: false,
    };
  }

  const screenshotPath = path.resolve(rootDir, config.output.screenshotPath || 'latest-frame.png');
  const cropPath = path.resolve(rootDir, config.output.cropPath || 'latest-crop.png');
  const viewport = config.viewport || { width: 1600, height: 900 };
  const pageUrl = options.pageUrl || config.pageUrl || `https://www.twitch.tv/${config.channelName}`;
  const scanMode = getOcrScanMode(config);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(config.ocr.settleMs ?? 12000);

    for (const selector of config.ocr.dismissSelectors || []) {
      const el = await page.$(selector);
      if (el) {
        try {
          await el.click({ timeout: 2000 });
          await page.waitForTimeout(1000);
        } catch {}
      }
    }

    const captureSelectors = config.ocr.captureSelectors || ['video', '[data-a-target="video-player"]', '.video-player'];
    let capturedElement = false;

    for (const selector of captureSelectors) {
      const candidate = page.locator(selector).first();
      if (await candidate.count().catch(() => 0)) {
        try {
          await candidate.screenshot({ path: screenshotPath });
          capturedElement = true;
          break;
        } catch {}
      }
    }

    if (!capturedElement) {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }

    const meta = await sharp(screenshotPath).metadata();
    let ocrSourcePath = screenshotPath;

    if (scanMode === 'full_frame') {
      await sharp(screenshotPath).png().toFile(cropPath);
    } else {
      let image = sharp(screenshotPath);
      const crop = config.ocr.crop;
      const left = Math.round((crop.x / 100) * meta.width);
      const top = Math.round((crop.y / 100) * meta.height);
      const width = Math.max(1, Math.round((crop.width / 100) * meta.width));
      const height = Math.max(1, Math.round((crop.height / 100) * meta.height));

      image = image.extract({
        left: clamp(left, 0, meta.width - 1),
        top: clamp(top, 0, meta.height - 1),
        width: clamp(width, 1, meta.width - clamp(left, 0, meta.width - 1)),
        height: clamp(height, 1, meta.height - clamp(top, 0, meta.height - 1)),
      });

      image = image
        .grayscale()
        .normalize()
        .resize({
          width: Math.max(width * (config.ocr.scale || 2), width),
          kernel: 'nearest',
        });

      if (typeof config.ocr.threshold === 'number') {
        image = image.threshold(config.ocr.threshold);
      }

      await image.png().toFile(cropPath);
      ocrSourcePath = cropPath;
    }

    const worker = await createWorker('eng');
    try {
      const workerParams = {
        tessedit_pageseg_mode: String(config.ocr.psm ?? (scanMode === 'full_frame' ? 11 : 7)),
      };

      if (scanMode === 'full_frame') {
        workerParams.preserve_interword_spaces = '1';
      } else {
        workerParams.tessedit_char_whitelist = config.ocr.whitelist || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#:- ';
      }

      await worker.setParameters(workerParams);
      const result = await worker.recognize(ocrSourcePath);
      const rawText = result.data.text || '';
      const confidence = Number(result.data.confidence || 0);
      const attempt = parseAttempt(rawText);
      return {
        attempt,
        confidence,
        rawText: rawText.trim(),
        cropSaved: true,
        scanMode,
      };
    } finally {
      await worker.terminate();
    }
  } finally {
    await browser.close();
  }
}

function buildTracker({ config, snapshot, ocr, previous }) {
  const stream = snapshot.stream;
  const sourceMode = snapshot.sourceMode || 'live';
  const isVodTest = sourceMode === 'vod_test';
  const live = isVodTest ? false : Boolean(stream);
  const attempt = (live || isVodTest) ? (ocr.attempt ?? null) : null;
  const previousLiveTitle = previous?.source_mode === 'live' && !/vod test/i.test(previous?.title || '')
    ? previous?.title
    : null;
  const previousLiveGame = previousLiveTitle ? previous?.game_name : null;

  return {
    channel: config.channelName,
    page_url: snapshot.pageUrl || config.pageUrl,
    source_mode: sourceMode,
    live,
    title: isVodTest
      ? (snapshot.title || previous?.title || `${config.channelName} VOD test`)
      : (stream?.title || previousLiveTitle || `${config.channelName} offline`),
    game_name: isVodTest
      ? (snapshot.gameName || previous?.game_name || 'Unknown')
      : (stream?.game_name || previousLiveGame || 'Unknown'),
    viewer_count: isVodTest ? snapshot.viewerCount || 0 : stream?.viewer_count || 0,
    started_at: isVodTest ? snapshot.startedAt || null : stream?.started_at || null,
    attempt,
    ocr_confidence: Number(ocr.confidence || 0),
    ocr_text: ocr.rawText || '',
    ocr_scope: ocr.scanMode || getOcrScanMode(config),
    last_update: nowIso(),
    watcher_status: isVodTest ? 'vod test mode' : (live ? 'stream live' : 'stream offline'),
    screenshot_path: config.output.screenshotPath || 'latest-frame.png',
    crop_path: config.output.cropPath || 'latest-crop.png',
    notes: isVodTest
      ? (ocr.attempt ? 'vod test mode; ocr read succeeded' : 'vod test mode; OCR did not parse an attempt number')
      : (live
        ? (ocr.attempt ? 'ocr read succeeded' : 'stream live, but OCR did not parse an attempt number')
        : 'stream offline; OCR skipped or retained previous value'),
    delta: config.site?.delta ?? 6.3,
    chance: config.site?.chance ?? 0,
    volume: config.site?.volume ?? 8073206,
  };
}

function buildApiErrorTracker({ config, previous, errorMessage }) {
  const previousLiveTitle = previous?.source_mode === 'live' && !/vod test/i.test(previous?.title || '')
    ? previous?.title
    : null;
  const previousLiveGame = previousLiveTitle ? previous?.game_name : null;

  return {
    channel: config.channelName,
    page_url: config.pageUrl || previous?.page_url || `https://www.twitch.tv/${config.channelName}`,
    source_mode: 'live',
    live: false,
    title: previousLiveTitle || `${config.channelName} unavailable`,
    game_name: previousLiveGame || 'Unknown',
    viewer_count: 0,
    started_at: null,
    attempt: null,
    ocr_confidence: 0,
    ocr_text: '',
    ocr_scope: getOcrScanMode(config),
    last_update: nowIso(),
    watcher_status: `api error: ${errorMessage}`,
    screenshot_path: config.output.screenshotPath || 'latest-frame.png',
    crop_path: config.output.cropPath || 'latest-crop.png',
    notes: 'Twitch API failed before OCR could run',
    delta: config.site?.delta ?? 6.3,
    chance: config.site?.chance ?? 0,
    volume: config.site?.volume ?? 8073206,
  };
}

async function readPreviousTracker(outputPath) {
  try {
    const raw = await fs.readFile(outputPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function runOnce() {
  const config = await readConfig();
  const trackerPath = path.resolve(rootDir, config.output.trackerPath || 'tracker.json');
  const previous = await readPreviousTracker(trackerPath);

  let snapshot;
  try {
    snapshot = await getStreamSnapshot(config);
  } catch (err) {
    const fallback = buildApiErrorTracker({ config, previous, errorMessage: err.message });
    await writeJson(trackerPath, fallback);
    throw err;
  }

  let ocr = { attempt: null, confidence: 0, rawText: '', cropSaved: false };
  if (snapshot.stream || snapshot.sourceMode === 'vod_test') {
    try {
      ocr = await captureAndOcr(config, { pageUrl: snapshot.pageUrl });
    } catch (err) {
      ocr = { attempt: null, confidence: 0, rawText: '', cropSaved: false };
      const tracker = buildTracker({ config, snapshot, ocr, previous });
      tracker.watcher_status = `ocr error: ${err.message}`;
      tracker.notes = snapshot.sourceMode === 'vod_test'
        ? 'vod test mode enabled, but OCR failed'
        : 'stream live, API worked, OCR failed';
      await writeJson(trackerPath, tracker);
      throw err;
    }
  }

  const tracker = buildTracker({ config, snapshot, ocr, previous });
  await writeJson(trackerPath, tracker);
  console.log(`[${tracker.last_update}] live=${tracker.live} attempt=${tracker.attempt ?? 'n/a'} confidence=${tracker.ocr_confidence.toFixed(2)}`);
}

async function main() {
  await loadLocalEnv();
  const config = await readConfig();
  const interval = config.pollIntervalMs || 60000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runOnce();
    } catch (err) {
      console.error(err.message);
    } finally {
      busy = false;
    }
  };

  await tick();
  if (!once) {
    setInterval(tick, interval);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
