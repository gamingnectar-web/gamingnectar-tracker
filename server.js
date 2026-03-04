const express = require('express');
const puppeteer = require('puppeteer-core');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = String(req.query.number || '').trim();
  const logs = [];

  // 💓 HEARTBEAT: Prevents Cron-job.org from using Browserless credits
  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  logs.push(`🚀 Start: Tracking ${trackingNumber}`);
  let browser;

  try {
    // ✅ Direct SPA Results Route
    const resultsUrl = `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(trackingNumber)}`;

    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&stealth=true`,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1200 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-GB,en;q=0.9' });

    logs.push(`🌐 Navigating directly to: ${resultsUrl}`);
    await page.goto(resultsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // --- STAGE 1: MULTI-SELECTOR COOKIE CLEARING ---
    logs.push('🍪 Checking cookie banner...');
    try {
      const cookieSelectors = [
        '#truste-consent-button',
        'button#onetrust-accept-btn-handler',
        'button[aria-label="Accept all cookies"]',
        'button[title="Accept All Cookies"]',
      ];

      let clicked = false;
      for (const sel of cookieSelectors) {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click().catch(() => {});
          clicked = true;
          break;
        }
      }

      if (clicked) {
        logs.push('✅ Cookies cleared.');
        await new Promise(r => setTimeout(r, 1200));
      } else {
        logs.push('ℹ️ Cookie banner not found.');
      }
    } catch (e) {
      logs.push('ℹ️ Cookie step skipped.');
    }

    // --- STAGE 2: WAIT FOR SPA RENDER ---
    logs.push('⏳ Waiting for results...');
    try {
      await page.waitForFunction(() => {
        const t = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();
        
        // Success Signals
        if (
          t.includes('delivered') ||
          t.includes('out for delivery') ||
          t.includes("we've got it") ||
          t.includes('weve got it') ||
          t.includes('item received') ||
          t.includes('warrington') ||
          t.includes('tracking update')
        ) return true;

        // Error Signals
        if (
          t.includes('enter a tracking number') ||
          t.includes('sorry') ||
          t.includes("we can't") ||
          t.includes('not recognised')
        ) return true;

        return false;
      }, { timeout: 25000 });

      logs.push('✅ Page content detected.');
    } catch (e) {
      logs.push('⚠️ Timeout waiting for results.');
    }

    await new Promise(r => setTimeout(r, 1200));

    // --- STAGE 3: SCRAPE & DETECT ---
    const pageText = await page.evaluate(() => document.body.innerText || '');
    const text = pageText.toLowerCase().replace(/['’]/g, '');
    let currentStatus = 'UNKNOWN';

    if (text.includes('your reference number') || text.includes('enter a tracking number')) {
      currentStatus = 'INVALID_INPUT';
    } else if (text.includes('not recognised') || text.includes('not recognized')) {
      currentStatus = 'NOT_FOUND';
    } else if (text.includes('delivered on') || text.includes('delivered to')) {
      currentStatus = 'DELIVERED';
    } else if (text.includes('out for delivery') || text.includes('due to be delivered today')) {
      currentStatus = 'OUT_FOR_DELIVERY';
    } else if (text.includes('weve got it') || text.includes('item received') || text.includes('warrington')) {
      currentStatus = 'WITH_COURIER';
    }

    logs.push(`🏁 Final Status: ${currentStatus}`);
    await browser.close();

    return res.json({
      tracking: trackingNumber,
      status: currentStatus,
      logs,
      debug_text: pageText.substring(0, 2000),
    });
  } catch (error) {
    logs.push(`🚨 ERROR: ${error.message}`);
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: 'Failed to scrape', logs });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API live on port ${PORT}`));
