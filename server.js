const express = require('express');
const puppeteer = require('puppeteer-core'); 
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = req.query.number;
  const logs = [];
  
  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  logs.push(`🚀 Start: Tracking ${trackingNumber}`);
  let browser;

  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&stealth=true`
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1200 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // 1. Initial Landing
    logs.push("🌐 Navigating to Royal Mail Landing...");
    await page.goto('https://www.royalmail.com/track-your-item#/', { waitUntil: 'networkidle2', timeout: 30000 });

    // 2. Cookie Stage
    try {
      logs.push("🍪 Clearing cookie banner...");
      await page.waitForSelector('#truste-consent-button', { timeout: 5000 });
      await page.click('#truste-consent-button');
      logs.push("✅ Cookies accepted.");
      // Small pause to let the overlay disappear
      await new Promise(r => setTimeout(r, 1500)); 
    } catch (e) {
      logs.push("ℹ️ Cookie banner skipped.");
    }

    // 3. Redirection Stage
    logs.push(`⚡ Jumping to Results URL: .../${trackingNumber}`);
    const resultsUrl = `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`;
    await page.goto(resultsUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // 4. VERIFICATION STAGE: Check if results container exists
    logs.push("🔍 Verifying page transition...");
    const hasResultsContainer = await page.evaluate(() => {
      return !!document.querySelector('.status-description') || !!document.querySelector('.tracking-history');
    });

    if (hasResultsContainer) {
      logs.push("✅ VERIFIED: Landing on results page detected.");
    } else {
      logs.push("⚠️ WARNING: Results container not found. Page might be stuck or blocked.");
      // Fallback: If not found, try typing it manually just once
      logs.push("⌨️ Attempting manual input fallback...");
      try {
        await page.waitForSelector('#barcode-input', { timeout: 5000 });
        await page.type('#barcode-input', trackingNumber);
        await page.click('#submit');
        logs.push("✅ Fallback submit clicked.");
        await new Promise(r => setTimeout(r, 5000));
      } catch(err) {
        logs.push("❌ Fallback input also failed.");
      }
    }

    // 5. Final Extraction
    const pageText = await page.evaluate(() => document.body.innerText);
    const text = pageText.toLowerCase().replace(/['’]/g, "");
    let currentStatus = 'UNKNOWN';

    // Keywords from your screenshot
    if (text.includes("delivered on") || text.includes("delivered to")) {
      currentStatus = 'DELIVERED';
    } else if (text.includes("out for delivery") || text.includes("due to be delivered today")) {
      currentStatus = 'OUT_FOR_DELIVERY';
    } else if (text.includes("weve got it") || text.includes("item received") || text.includes("warrington mc")) {
      currentStatus = 'WITH_COURIER';
    }
    
    logs.push(`🏁 Final Status: ${currentStatus}`);
    await browser.close();

    res.json({ 
      tracking: trackingNumber, 
      status: currentStatus,
      logs: logs,
      debug_text: pageText.substring(0, 2000) 
    });

  } catch (error) {
    logs.push(`🚨 ERROR: ${error.message}`);
    if (browser) await browser.close();
    res.status(500).json({ error: 'Failed to scrape', logs: logs });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API live on port ${PORT}`));
