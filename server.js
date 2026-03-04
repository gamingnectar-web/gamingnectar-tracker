const express = require('express');
const puppeteer = require('puppeteer-core');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch { return ''; }
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ').trim();
}

function classifyFromText(text) {
  const t = normalize(text);

  if (
    t.includes('not recognised') ||
    t.includes('not recognized') ||
    t.includes("we cant confirm") ||
    t.includes("we can't confirm")
  ) return 'NOT_FOUND';

  if (t.includes('out for delivery') || t.includes('due to be delivered today')) return 'OUT_FOR_DELIVERY';

  if (t.includes('delivered on') || t.includes('delivered to')) return 'DELIVERED';

  if (t.includes('weve got it') || t.includes("we've got it") || t.includes('item received') || t.includes('warrington mc'))
    return 'WITH_COURIER';

  return 'UNKNOWN';
}

/**
 * Walks ANY JSON schema and tries to find "best evidence" text for a specific tracking number.
 * Strategy:
 * - Look for any node (object/array) whose JSON string contains the trackingNumber (strong signal)
 * - Within those nodes, collect strings that look like tracking statuses/events
 * - Pick the best string and classify from it
 */
function extractTrackingEvidence(json, trackingNumber) {
  const tn = normalize(trackingNumber);
  const evidenceStrings = [];
  let containsTrackingNumber = false;

  const seen = new Set();
  const stack = [{ value: json, path: '$' }];

  const isStatusy = (s) => {
    const t = normalize(s);
    return (
      t.includes('delivered') ||
      t.includes('out for delivery') ||
      t.includes('due to be delivered today') ||
      t.includes('weve got it') ||
      t.includes("we've got it") ||
      t.includes('item received') ||
      t.includes('posted') ||
      t.includes('accepted') ||
      t.includes('in transit') ||
      t.includes('processing') ||
      t.includes('ready for delivery') ||
      t.includes('attempted delivery') ||
      t.includes('delivery attempted') ||
      t.includes('unable to deliver') ||
      t.includes('not recognised') ||
      t.includes('not recognized') ||
      t.includes("we cant confirm") ||
      t.includes("we can't confirm")
    );
  };

  while (stack.length) {
    const { value, path } = stack.pop();
    if (!value) continue;

    if (typeof value === 'string') {
      // Collect status-like strings (we’ll filter by locality to tracking number below)
      if (isStatusy(value)) evidenceStrings.push({ path, text: value });
      continue;
    }

    if (typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);

    // If this subtree contains the tracking number, mark it and harvest strings more aggressively.
    const subtreeString = safeStringify(value);
    const subtreeNorm = normalize(subtreeString);
    const subtreeHasTN = tn.length > 0 && subtreeNorm.includes(tn);

    if (subtreeHasTN) {
      containsTrackingNumber = true;

      // If subtree contains TN, pull all strings in that subtree (not just “statusy”),
      // because some schemas store statuses as codes we still want to classify.
      const subStack = [{ v: value, p: path }];
      const subSeen = new Set();

      while (subStack.length) {
        const { v, p } = subStack.pop();
        if (!v) continue;

        if (typeof v === 'string') {
          // Save both status-like and shorter informative strings
          const txt = String(v);
          const n = normalize(txt);
          if (isStatusy(txt) || n.includes('delivered') || n.includes('out for delivery') || n.includes('weve got it')) {
            evidenceStrings.push({ path: p, text: txt });
          }
          continue;
        }

        if (typeof v !== 'object') continue;
        if (subSeen.has(v)) continue;
        subSeen.add(v);

        if (Array.isArray(v)) {
          v.forEach((item, idx) => subStack.push({ v: item, p: `${p}[${idx}]` }));
        } else {
          for (const [k, vv] of Object.entries(v)) {
            subStack.push({ v: vv, p: `${p}.${k}` });
          }
        }
      }
    }

    // Continue normal traversal
    if (Array.isArray(value)) {
      value.forEach((item, idx) => stack.push({ value: item, path: `${path}[${idx}]` }));
    } else {
      for (const [k, v] of Object.entries(value)) {
        stack.push({ value: v, path: `${path}.${k}` });
      }
    }
  }

  // Choose the “best” evidence string:
  // - Prefer strings with delivered/out for delivery/we've got it etc.
  // - Longer isn’t always better; prefer moderately sized messages
  const ranked = evidenceStrings
    .map((e) => {
      const t = normalize(e.text);
      let score = 0;

      if (t.includes('delivered on') || t.includes('delivered to')) score += 50;
      else if (t.includes('delivered')) score += 30;

      if (t.includes('out for delivery') || t.includes('due to be delivered today')) score += 35;
      if (t.includes('weve got it') || t.includes("we've got it") || t.includes('item received')) score += 20;

      if (t.includes('not recognised') || t.includes('not recognized') || t.includes("we cant confirm") || t.includes("we can't confirm")) score += 40;

      // prefer “message sized” strings (avoid giant app text blobs)
      const len = t.length;
      if (len > 20 && len < 240) score += 10;
      if (len >= 240) score -= 10;

      return { ...e, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0] || null;

  return {
    containsTrackingNumber,
    bestEvidenceText: best ? best.text : null,
    bestEvidencePath: best ? best.path : null,
    bestEvidenceScore: best ? best.score : null,
  };
}

function scoreJsonCandidate({ json, url }, trackingNumber) {
  const raw = normalize(safeStringify(json));
  const tn = normalize(trackingNumber);

  const topKeys = json && typeof json === 'object' ? Object.keys(json) : [];

  const hasTN = tn && raw.includes(tn);

  // Hard de-prioritize obvious config-only blobs (your exact case)
  const lowerKeys = topKeys.map(k => k.toLowerCase());
  const isConfigBlob =
    lowerKeys.length <= 4 &&
    lowerKeys.includes('appconfig') &&
    lowerKeys.includes('apptext');

  let score = 0;
  if (hasTN) score += 100;            // MUST-have signal
  if (url.includes('royalmail.com')) score += 3;
  if (url.includes('/spalp/rml_track_and_trace/json')) score += 5;

  if (isConfigBlob && !hasTN) score -= 80; // prevent false positives from UI text

  // Mild bumps for status words (ONLY meaningful if hasTN)
  if (hasTN) {
    if (raw.includes('delivered')) score += 10;
    if (raw.includes('out for delivery')) score += 10;
    if (raw.includes("weve got it") || raw.includes("we've got it")) score += 6;
  }

  return { score, hasTN, topKeys: topKeys.slice(0, 25), isConfigBlob };
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
      const b =
        btns.find(x => /track your delivery/i.test((x.innerText || '').trim())) ||
        document.querySelector('button[type="submit"]');
      if (b) { b.click(); return true; }
      return false;
    });
    if (!clickedTrack) throw new Error('Submit button not found');

    // Wait for JSON responses
    logs.push('⏳ Waiting for JSON responses...');
    const start = Date.now();
    while (Date.now() - start < 20000) {
      if (jsonResponses.length >= 2) break;
      await sleep(300);
    }
    logs.push(`✅ Captured ${jsonResponses.length} JSON response(s).`);

    // Score candidates
    const candidates = jsonResponses
      .map((r) => {
        const meta = scoreJsonCandidate(r, trackingNumber);
        return {
          url: r.url,
          http_status: r.status,
          top_keys: meta.topKeys,
          score: meta.score,
          has_tracking_number: meta.hasTN,
          is_config_blob: meta.isConfigBlob,
        };
      })
      .sort((a, b) => b.score - a.score);

    // Pick best, but ONLY trust if it contains tracking number
    const best = candidates[0] ? jsonResponses.find(r => r.url === candidates[0].url) : null;

    let status = 'UNKNOWN';
    let usedTrackingJson = false;
    let evidence = null;

    if (best) {
      const ev = extractTrackingEvidence(best.json, trackingNumber);
      evidence = ev;

      if (ev.containsTrackingNumber) {
        status = classifyFromText(ev.bestEvidenceText || safeStringify(best.json));
        usedTrackingJson = true;
        logs.push(`🧩 Using tracking JSON: ${best.url}`);
        logs.push(`🧠 Evidence path: ${ev.bestEvidencePath || 'n/a'}`);
      } else {
        // We refuse to guess from config/copy
        status = 'NO_TRACKING_DATA';
        logs.push(`⚠️ Best JSON did NOT contain the tracking number; refusing to guess from UI copy.`);
      }
    } else {
      status = 'NO_TRACKING_DATA';
      logs.push(`⚠️ No JSON candidates captured; no tracking data.`);
    }

    // For debugging only (don’t use this to classify unless you choose to)
    const pageText = await page.evaluate(() => document.body?.innerText || '');

    logs.push(`🏁 Final Status: ${status}`);

    await browser.close();

    return res.json({
      tracking: trackingNumber,
      status,
      logs,
      debug: {
        json_count: jsonResponses.length,
        used_tracking_json: usedTrackingJson,
        best_json_url: best?.url || null,
        evidence_contains_tracking_number: evidence?.containsTrackingNumber ?? null,
        evidence_best_path: evidence?.bestEvidencePath ?? null,
        evidence_best_text: evidence?.bestEvidenceText ? String(evidence.bestEvidenceText).slice(0, 300) : null,
        candidates: candidates.slice(0, 10),
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
