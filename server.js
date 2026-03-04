const express = require('express');
const puppeteer = require('puppeteer-core');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyFromText(raw) {
  const t = normalize(raw);

  if (
    t.includes('not recognised') ||
    t.includes('not recognized') ||
    t.includes("we cant confirm") ||
    t.includes("we can't confirm")
  ) return 'NOT_FOUND';

  if (t.includes('out for delivery') || t.includes('due to be delivered today')) return 'OUT_FOR_DELIVERY';

  if (t.includes('delivered on') || t.includes('delivered to')) return 'DELIVERED';

  if (
    t.includes('weve got it') ||
    t.includes("we've got it") ||
    t.includes('item received') ||
    t.includes('warrington mc')
  ) return 'WITH_COURIER';

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

    // Capture relevant requests (so we can debug even if waits time out)
    const observedRequests = [];
    page.on('request', (r) => {
      try {
        const url = r.url();
        if (!url.includes('royalmail.com')) return;
        observedRequests.push({
          url,
          method: r.method(),
          postData: r.postData() ? r.postData().slice(0, 1000) : null,
          resourceType: r.resourceType(),
        });
      } catch {}
    });

    const baseUrl = 'https://www.royalmail.com/track-your-item#/';
    logs.push(`🌐 Loading: ${baseUrl}`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Cookies best-effort
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

    // Ensure input exists
    await page.waitForSelector('#barcode-input', { timeout: 15000 });

    // Human-like typing
    logs.push('⌨️ Typing tracking number like a human...');
    await page.click('#barcode-input', { clickCount: 3 });
    // clear robustly
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');

    await page.type('#barcode-input', trackingNumber, { delay: 120 });

    const inputVal = await page.$eval('#barcode-input', el => el.value);
    logs.push(`🔎 Input now: ${inputVal}`);

    // Prepare to catch the *real* tracking request (must contain tracking number in body)
    const tnNorm = normalize(trackingNumber);

    const waitReq = page.waitForRequest((r) => {
      try {
        const url = r.url();
        if (!url.includes('royalmail.com')) return false;

        // likely XHR/fetch to tracking service
        const isLikely =
          url.includes('rml_track_and_trace') ||
          url.includes('track') ||
          url.includes('trace') ||
          url.includes('tracking');

        if (!isLikely) return false;

        const pd = r.postData();
        if (!pd) return false;

        return normalize(pd).includes(tnNorm);
      } catch {
        return false;
      }
    }, { timeout: 20000 });

    // Click the button
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

    // Wait for the matching request
    let trackingRequest;
    try {
      trackingRequest = await waitReq;
      logs.push(`✅ Found tracking request: ${trackingRequest.method()} ${trackingRequest.url()}`);
    } catch {
      logs.push('⚠️ Did not observe a tracking request containing the tracking number.');
      const pageText = await page.evaluate(() => document.body?.innerText || '');
      await browser.close();

      return res.json({
        tracking: trackingNumber,
        status: 'NO_TRACKING_REQUEST',
        logs,
        debug: {
          observedRoyalMailRequests: observedRequests.slice(-25),
        },
        debug_text: pageText.substring(0, 2000),
      });
    }

    // Wait for the response to THAT request URL (often enough; if multiple, we’ll pick the next one)
    const reqUrl = trackingRequest.url();
    const trackingResponse = await page.waitForResponse((resp) => {
      try {
        return resp.url() === reqUrl;
      } catch {
        return false;
      }
    }, { timeout: 20000 });

    const ct = (trackingResponse.headers()['content-type'] || '').toLowerCase();
    logs.push(`📦 Tracking response content-type: ${ct || 'unknown'}`);

    // Read response body as text; parse JSON if possible
    const bodyText = await trackingResponse.text().catch(() => '');
    let payload = null;
    try {
      payload = JSON.parse(bodyText);
      logs.push('✅ Tracking response parsed as JSON.');
    } catch {
      logs.push('ℹ️ Tracking response is not JSON; using raw text.');
    }

    // Classify strictly from the tracking response payload/text (not the landing page)
    const classifierInput = payload ? JSON.stringify(payload) : bodyText;
    const status = classifyFromText(classifierInput);

    logs.push(`🏁 Final Status: ${status}`);

    // Small additional debug: show whether payload/text contains the tracking number
    const containsTN = normalize(classifierInput).includes(tnNorm);

    await browser.close();

    return res.json({
      tracking: trackingNumber,
      status,
      logs,
      debug: {
        tracking_request: {
          url: reqUrl,
          method: trackingRequest.method(),
          postData_snippet: trackingRequest.postData()
            ? trackingRequest.postData().slice(0, 500)
            : null,
        },
        tracking_response: {
          url: trackingResponse.url(),
          http_status: trackingResponse.status(),
          content_type: ct || null,
          contains_tracking_number: containsTN,
          body_snippet: bodyText ? bodyText.slice(0, 1200) : null,
          top_keys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 40) : null,
        },
      },
    });
  } catch (error) {
    logs.push(`🚨 ERROR: ${error.message}`);
    if (browser) {
      try { await browser.close(); } catch {}
    }
    return res.status(500).json({ error: 'Failed to scrape', logs });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API live on port ${PORT}`));
