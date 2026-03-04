const express = require('express');
const puppeteer = require('puppeteer-core');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function classifyFromText(rawText) {
  const text = (rawText || '').toLowerCase().replace(/['’]/g, '');

  if (
    text.includes('not recognised') ||
    text.includes('not recognized') ||
    text.includes("we can't confirm") ||
    text.includes('we cant confirm')
  ) return 'NOT_FOUND';

  if (text.includes('out for delivery') || text.includes('due to be delivered today')) return 'OUT_FOR_DELIVERY';

  if (text.includes('delivered on') || text.includes('delivered to')) return 'DELIVERED';

  if (text.includes("we've got it") || text.includes('weve got it') || text.includes('item received') || text.includes('warrington mc'))
    return 'WITH_COURIER';

  return 'UNKNOWN';
}

// Heuristic: find a likely tracking JSON response among all captured JSON responses
function pickBestTrackingJson(jsonResponses) {
  // Prefer JSON objects with "events"/"event"/"tracking"/"items"/"shipments" etc.
  const score = (obj) => {
    if (!obj || typeof obj !== 'object') return 0;
    const keys = Object.keys(obj).map(k => k.toLowerCase());
    let s = 0;

    const bump = (k, w) => { if (keys.includes(k)) s += w; };

    bump('events', 8);
    bump('event', 6);
    bump('tracking', 8);
    bump('track', 6);
    bump('items', 6);
    bump('item', 4);
    bump('shipments', 6);
    bump('shipment', 5);
    bump('summary', 5);
    bump('status', 4);
    bump('delivery', 4);
    bump('milestones', 6);
    bump('scans', 6);
    bump('history', 6);

    // Also bump if any nested arrays look like events
    try {
      const str = JSON.stringify(obj).toLowerCase();
      if (str.includes('delivered')) s += 4;
      if (str.includes('out for delivery')) s += 4;
      if (str.includes("we've got it") || str.includes('weve got it')) s += 3;
      if (str.includes('warrington')) s += 2;
    } catch {}

    return s;
  };

  let best = null;
  let bestScore = -1;

  for (const r of jsonResponses) {
    const s = score(r.json);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

function classifyFromJson(obj) {
  // We don’t know the exact schema, so we use flexible string searching.
  // Once you see the real payload, you can tighten this to exact fields.
  const str = JSON.stringify(obj || {}).toLowerCase().replace(/['’]/g, '');

  if (str.includes('not recognised') || str.includes('not recognized') || str.includes("we cant confirm") || str.includes("we can't confirm"))
    return 'NOT_FOUND';

  if (str.includes('out for delivery') || str.includes('due to be delivered today')) return 'OUT_FOR_DELIVERY';

  if (str.includes('delivered on') || str.includes('delivered to') || str.includes('"delivered"')) return 'DELIVERED';

  if (str.includes("weve got it") || str.includes("we've got it") || str.includes('item received') || str.includes('warrington mc'))
    return 'WITH_COURIER';

  return 'UNKNOWN';
}

app.get('/api/track', async (req, res) => {
  const trackingNumber = String(req.query.number || '').trim();
  const logs = [];

  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  logs.push(`🚀 Start: Tracking ${trackingNumber}`);

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&stealth=true`,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1200 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-GB,en;q=0.9' });

    // Capture candidate JSON responses
    const jsonResponses = [];
    page.on('response', async (resp) => {
      try {
        const url = resp.url();
        const ct = (resp.headers()['content-type'] || '').toLowerCase();

        // Only look at likely XHR/fetch JSON-ish responses
        if (!ct.includes('application/json') && !ct.includes('json')) return;

        // Avoid gigantic irrelevant blobs (still allow if it’s JSON)
        const json = await resp.json().catch(() => null);
        if (!json) return;

        jsonResponses.push({
          url,
          status: resp.status(),
          contentType: ct,
          json,
        });
      } catch {
        // ignore
      }
    });

    const baseUrl = 'https://www.royalmail.com/track-your-item#/';
    logs.push(`🌐 Loading: ${baseUrl}`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // ---- Cookies best-effort
    logs.push('🍪 Handling cookie banner...');
    try {
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const accept =
          document.querySelector('#truste-consent-button') ||
          document.querySelector('button#onetrust-accept-btn-handler') ||
          btns.find(b => /accept all/i.test((b.innerText || '').trim()));
        if (accept) {
          accept.click();
          return true;
        }
        return false;
      });

      if (clicked) {
        logs.push('✅ Cookie accept clicked.');
        await sleep(800);
      } else {
        logs.push('ℹ️ Cookie banner not found / not needed.');
      }
    } catch (e) {
      logs.push('ℹ️ Cookie handling skipped (non-fatal).');
    }

    // ---- Fill input + click Track
    logs.push('⌨️ Setting tracking number in #barcode-input...');
    await page.waitForSelector('#barcode-input', { timeout: 15000 });

    await page.$eval('#barcode-input', (el, value) => {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, trackingNumber);

    const inputVal = await page.$eval('#barcode-input', el => el.value);
    logs.push(`🔎 Input now: ${inputVal}`);

    logs.push('🖱️ Clicking "Track your delivery"...');
    const clickedTrack = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(x => /track your delivery/i.test((x.innerText || '').trim()))
        || document.querySelector('button[type="submit"]');
      if (b) { b.click(); return true; }
      return false;
    });

    if (!clickedTrack) throw new Error('Submit button not found');

    // ---- Wait for either:
    // 1) a promising JSON response, OR
    // 2) results-like text to appear
    logs.push('⏳ Waiting for tracking data (JSON or results text)...');

    const start = Date.now();
    let sawJson = false;

    while (Date.now() - start < 25000) {
      // If any JSON responses have arrived, we can stop early
      if (jsonResponses.length > 0) {
        sawJson = true;
        break;
      }

      // Otherwise check if page text looks like results
      const looksLikeResults = await page.evaluate(() => {
        const t = (document.body?.innerText || '').toLowerCase();
        return t.includes('delivered') ||
               t.includes('out for delivery') ||
               t.includes("we've got it") ||
               t.includes('weve got it') ||
               t.includes('item received') ||
               t.includes('tracking update') ||
               t.includes('not recognised') ||
               t.includes('not recognized') ||
               t.includes("we can't confirm") ||
               t.includes('we cant confirm');
      });

      if (looksLikeResults) break;
      await sleep(400);
    }

    if (sawJson) logs.push(`✅ Captured ${jsonResponses.length} JSON response(s).`);
    else logs.push('ℹ️ No JSON captured in time; will fall back to text scrape.');

    // ---- Decide status
    let currentStatus = 'UNKNOWN';
    let bestJson = null;

    if (jsonResponses.length) {
      bestJson = pickBestTrackingJson(jsonResponses);
      if (bestJson) {
        currentStatus = classifyFromJson(bestJson.json);
        logs.push(`🧩 Best JSON URL: ${bestJson.url}`);
      }
    }

    // Fallback to text if still unknown or no json
    const pageText = await page.evaluate(() => document.body?.innerText || '');
    if (!jsonResponses.length || currentStatus === 'UNKNOWN') {
      const fromText = classifyFromText(pageText);
      if (fromText !== 'UNKNOWN') currentStatus = fromText;
    }

    logs.push(`🏁 Final Status: ${currentStatus}`);

    await browser.close();

    return res.json({
      tracking: trackingNumber,
      status: currentStatus,
      logs,
      debug: {
        json_count: jsonResponses.length,
        best_json_url: bestJson?.url || null,
        best_json_top_keys: bestJson?.json && typeof bestJson.json === 'object'
          ? Object.keys(bestJson.json).slice(0, 25)
          : null,
      },
      debug_text: pageText.substring(0, 2000),
    });
  } catch (error) {
    logs.push(`🚨 ERROR: ${error.message}`);
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    return res.status(500).json({ error: 'Failed to scrape', logs });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API live on port ${PORT}`));
