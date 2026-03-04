const express = require('express');
const puppeteer = require('puppeteer-core');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJsonStringify(obj) {
  try { return JSON.stringify(obj); } catch { return ''; }
}

function deepScan(obj) {
  // Collect some signals from an unknown JSON schema
  const out = {
    hasEventsArray: false,
    hasHistory: false,
    hasMilestones: false,
    hasStatusKey: false,
    stringHits: {
      delivered: 0,
      outForDelivery: 0,
      gotIt: 0,
      notRecognised: 0
    }
  };

  const seen = new Set();
  const stack = [obj];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (Array.isArray(cur)) {
      // Heuristic: arrays of objects that include date/time/location/status often represent events
      if (cur.length && cur.some(x => x && typeof x === 'object')) {
        // weak signal, refined by key checks below
      }
      for (const v of cur) stack.push(v);
      continue;
    }

    for (const [k, v] of Object.entries(cur)) {
      const lk = String(k).toLowerCase();

      if (lk === 'events' && Array.isArray(v)) out.hasEventsArray = true;
      if (lk.includes('event') && Array.isArray(v)) out.hasEventsArray = true;
      if (lk.includes('history')) out.hasHistory = true;
      if (lk.includes('milestone')) out.hasMilestones = true;
      if (lk === 'status' || lk.includes('currentstatus') || lk.includes('trackingstatus')) out.hasStatusKey = true;

      if (typeof v === 'string') {
        const t = v.toLowerCase().replace(/['’]/g, '');
        if (t.includes('delivered')) out.stringHits.delivered++;
        if (t.includes('out for delivery') || t.includes('due to be delivered today')) out.stringHits.outForDelivery++;
        if (t.includes("weve got it") || t.includes("we've got it") || t.includes('item received')) out.stringHits.gotIt++;
        if (t.includes('not recognised') || t.includes('not recognized') || t.includes("we can't confirm") || t.includes('we cant confirm')) out.stringHits.notRecognised++;
      } else if (v && typeof v === 'object') {
        stack.push(v);
      }
    }
  }

  return out;
}

function classifyFromTrackingPayload(payload) {
  // Use both deep scan + global string scan
  const raw = safeJsonStringify(payload).toLowerCase().replace(/['’]/g, '');

  // Explicit failure
  if (
    raw.includes('not recognised') ||
    raw.includes('not recognized') ||
    raw.includes("we cant confirm") ||
    raw.includes("we can't confirm")
  ) return 'NOT_FOUND';

  // Strong positives
  if (raw.includes('out for delivery') || raw.includes('due to be delivered today')) return 'OUT_FOR_DELIVERY';
  if (raw.includes('delivered on') || raw.includes('delivered to') || raw.includes('"delivered"')) return 'DELIVERED';
  if (raw.includes("weve got it") || raw.includes("we've got it") || raw.includes('item received') || raw.includes('warrington mc'))
    return 'WITH_COURIER';

  // Fallback to deep scan signals if wording varies
  const scan = deepScan(payload);
  if (scan.stringHits.delivered > 0) return 'DELIVERED';
  if (scan.stringHits.outForDelivery > 0) return 'OUT_FOR_DELIVERY';
  if (scan.stringHits.gotIt > 0) return 'WITH_COURIER';
  if (scan.stringHits.notRecognised > 0) return 'NOT_FOUND';

  return 'UNKNOWN';
}

function scoreJsonCandidate({ json, url }, trackingNumber) {
  const topKeys = json && typeof json === 'object' ? Object.keys(json) : [];
  const raw = safeJsonStringify(json).toLowerCase();
  const tn = trackingNumber.toLowerCase();

  const scan = deepScan(json);

  let score = 0;

  // Biggest signal: payload contains the tracking number
  if (raw.includes(tn)) score += 50;

  // Prefer payloads that look like actual tracking content (events/milestones/history)
  if (scan.hasEventsArray) score += 25;
  if (scan.hasHistory) score += 15;
  if (scan.hasMilestones) score += 15;
  if (scan.hasStatusKey) score += 10;

  // De-prioritize obvious config blobs
  const lowerKeys = topKeys.map(k => k.toLowerCase());
  const looksLikeConfigOnly =
    lowerKeys.length <= 4 &&
    lowerKeys.includes('appconfig') &&
    lowerKeys.includes('apptext');

  if (looksLikeConfigOnly) score -= 40;

  // Small bump for “signal words” but not too much (config can contain them)
  score += Math.min(10, scan.stringHits.delivered);
  score += Math.min(10, scan.stringHits.outForDelivery);
  score += Math.min(6, scan.stringHits.gotIt);
  score += Math.min(6, scan.stringHits.notRecognised);

  // Prefer the known Royal Mail JSON endpoint slightly, but not if it’s config-only
  if (url.includes('/spalp/rml_track_and_trace/json')) score += 5;

  return { score, scan, topKeys };
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

    // Capture JSON responses
    const jsonResponses = [];
    page.on('response', async (resp) => {
      try {
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (!ct.includes('json')) return;

        const json = await resp.json().catch(() => null);
        if (!json) return;

        jsonResponses.push({
          url: resp.url(),
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

    // Cookies (best effort)
    logs.push('🍪 Handling cookie banner...');
    try {
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const accept =
          document.querySelector('#truste-consent-button') ||
          document.querySelector('button#onetrust-accept-btn-handler') ||
          btns.find(b => /accept all/i.test((b.innerText || '').trim()));
        if (accept) { accept.click(); return true; }
        return false;
      });
      if (clicked) {
        logs.push('✅ Cookie accept clicked.');
        await sleep(800);
      } else {
        logs.push('ℹ️ Cookie banner not found / not needed.');
      }
    } catch {
      logs.push('ℹ️ Cookie handling skipped (non-fatal).');
    }

    // Fill input + click
    logs.push('⌨️ Setting tracking number in #barcode-input...');
    await page.waitForSelector('#barcode-input', { timeout: 15000 });

    await page.$eval('#barcode-input', (el, value) => {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
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

    // Wait a bit for JSON calls to complete
    logs.push('⏳ Waiting for JSON responses...');
    const start = Date.now();
    while (Date.now() - start < 20000) {
      if (jsonResponses.length >= 2) break; // usually enough to score
      await sleep(300);
    }
    logs.push(`✅ Captured ${jsonResponses.length} JSON response(s).`);

    // Pick best candidate based on trackingNumber + schema signals
    let best = null;
    let bestMeta = null;
    const candidates = jsonResponses.map(r => {
      const meta = scoreJsonCandidate(r, trackingNumber);
      return {
        url: r.url,
        http_status: r.status,
        top_keys: meta.topKeys.slice(0, 25),
        score: meta.score,
        signals: meta.scan,
      };
    }).sort((a, b) => b.score - a.score);

    if (jsonResponses.length) {
      const top = candidates[0];
      best = jsonResponses.find(r => r.url === top.url) || null;
      bestMeta = top || null;
    }

    let currentStatus = 'UNKNOWN';
    let trackingPayloadUsed = false;

    if (best && bestMeta && bestMeta.score >= 20) {
      // Only trust it if it scores well enough (avoids config-only false positives)
      currentStatus = classifyFromTrackingPayload(best.json);
      trackingPayloadUsed = true;
      logs.push(`🧩 Using JSON candidate: ${best.url}`);
      logs.push(`🧠 Candidate score: ${bestMeta.score}`);
    } else {
      logs.push('⚠️ No high-confidence tracking JSON found; falling back to page text (less reliable).');
      const pageText = await page.evaluate(() => document.body?.innerText || '');
      currentStatus = (pageText ? 'UNKNOWN' : 'UNKNOWN'); // keep unknown; you can add a text classifier if you want
    }

    // Include some UI text for debugging, but don’t use it as primary truth
    const pageText = await page.evaluate(() => document.body?.innerText || '');

    logs.push(`🏁 Final Status: ${currentStatus}`);

    await browser.close();

    return res.json({
      tracking: trackingNumber,
      status: currentStatus,
      logs,
      debug: {
        json_count: jsonResponses.length,
        used_tracking_payload: trackingPayloadUsed,
        best_json_url: best?.url || null,
        best_score: bestMeta?.score ?? null,
        best_json_top_keys: bestMeta?.top_keys || null,
        candidates: candidates.slice(0, 7), // top 7 for inspection
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
