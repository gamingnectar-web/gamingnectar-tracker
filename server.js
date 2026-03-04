const express = require('express');
const puppeteer = require('puppeteer-core');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

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

    // ✅ Load base route first (more reliable than deep-linking directly into the hash route)
    const baseUrl = 'https://www.royalmail.com/track-your-item#/';
    const targetHash = `#/tracking-results/${encodeURIComponent(trackingNumber)}`;

    logs.push(`🌐 Loading base: ${baseUrl}`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // --- COOKIE CONSENT (best effort) ---
    logs.push('🍪 Handling cookie banner (best-effort)...');
    try {
      // Try several common consent selectors
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
        logs.push('✅ Cookie accept clicked.');
        await page.waitForTimeout(800);
      } else {
        // As a fallback: click by visible text
        const byTextClicked = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const b = btns.find(x => /accept all/i.test((x.innerText || '').trim()));
          if (b) { b.click(); return true; }
          return false;
        });
        if (byTextClicked) {
          logs.push('✅ Cookie accept clicked (by text).');
          await page.waitForTimeout(800);
        } else {
          logs.push('ℹ️ Cookie banner not found / not needed.');
        }
      }
    } catch (e) {
      logs.push('ℹ️ Cookie handling skipped (non-fatal).');
    }

    // ✅ Force SPA router to the results hash AFTER consent
    logs.push(`🧭 Routing SPA to: ${targetHash}`);
    await page.evaluate((hash) => {
      // Ensure we trigger router handling
      if (window.location.hash !== hash) {
        window.location.hash = hash;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
    }, targetHash);

    // Wait for either results content OR an explicit error OR the landing form to disappear
    logs.push('⏳ Waiting for results or error state...');
    try {
      await page.waitForFunction(() => {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const hasLandingForm = !!document.querySelector('#barcode-input');

        const looksLikeResults =
          bodyText.includes('delivered') ||
          bodyText.includes('out for delivery') ||
          bodyText.includes("we've got it") ||
          bodyText.includes('weve got it') ||
          bodyText.includes('item received') ||
          bodyText.includes('tracking update') ||
          bodyText.includes('latest update') ||
          bodyText.includes('status');

        const looksLikeExplicitError =
          bodyText.includes('not recognised') ||
          bodyText.includes('not recognized') ||
          bodyText.includes("we can't confirm") ||
          bodyText.includes('we cant confirm') ||
          bodyText.includes('something went wrong') ||
          bodyText.includes('try again later');

        // Success if results, or explicit error, or the landing form disappears
        return looksLikeResults || looksLikeExplicitError || !hasLandingForm;
      }, { timeout: 25000 });

      logs.push('✅ Page changed (results/error/form gone).');
    } catch (e) {
      logs.push('⚠️ Timeout waiting for results; scraping whatever is available...');
    }

    // Give the app a moment to finish rendering
    await page.waitForTimeout(1000);

    // --- SCRAPE + DEBUG STATE ---
    const state = await page.evaluate(() => {
      const pageText = document.body?.innerText || '';
      const hash = window.location.hash || '';
      const onLandingForm = !!document.querySelector('#barcode-input');
      return { pageText, hash, onLandingForm };
    });

    const pageText = state.pageText;
    const text = pageText.toLowerCase().replace(/['’]/g, '');
    let currentStatus = 'UNKNOWN';

    // IMPORTANT: Only classify INVALID_INPUT if we see an actual "please enter" style validation,
    // NOT just because the landing page contains "Your reference number".
    const looksLikeEnterPrompt =
      text.includes('please enter') ||
      text.includes('enter a tracking number') ||
      text.includes('enter a reference number');

    const looksLikeNotFound =
      text.includes('not recognised') ||
      text.includes('not recognized') ||
      text.includes("we can't confirm") ||
      text.includes('we cant confirm');

    const looksLikeDelivered =
      text.includes('delivered on') ||
      text.includes('delivered to') ||
      // "delivered" alone can appear in help pages; keep it but after the more specific checks above
      text.includes('delivered');

    const looksLikeOutForDelivery =
      text.includes('out for delivery') ||
      text.includes('due to be delivered today');

    const looksLikeWithCourier =
      text.includes("we've got it") ||
      text.includes('weve got it') ||
      text.includes('item received') ||
      text.includes('warrington mc');

    // If we're still on the landing form, treat it as BLOCKED/NOT_ROUTED instead of invalid input
    if (state.onLandingForm) {
      currentStatus = 'NOT_ROUTED';
    } else if (looksLikeEnterPrompt) {
      currentStatus = 'INVALID_INPUT';
    } else if (looksLikeNotFound) {
      currentStatus = 'NOT_FOUND';
    } else if (looksLikeOutForDelivery) {
      currentStatus = 'OUT_FOR_DELIVERY';
    } else if (looksLikeDelivered) {
      currentStatus = 'DELIVERED';
    } else if (looksLikeWithCourier) {
      currentStatus = 'WITH_COURIER';
    }

    logs.push(`🔎 Hash now: ${state.hash}`);
    logs.push(`🔎 On landing form: ${state.onLandingForm}`);
    logs.push(`🏁 Final Status: ${currentStatus}`);

    await browser.close();

    return res.json({
      tracking: trackingNumber,
      status: currentStatus,
      logs,
      debug: {
        hash: state.hash,
        onLandingForm: state.onLandingForm,
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
