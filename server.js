const express = require('express');
const puppeteer = require('puppeteer-core'); 
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = req.query.number;
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  console.log(`🤖 Targeting Royal Mail with Cookie-Bypass for: ${trackingNumber}`);

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&stealth=true`
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    const url = `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // 🛑 STEP 1: Click the "Accept All" Cookie Button
    try {
      await page.waitForSelector('#truste-consent-button', { timeout: 8000 });
      await page.click('#truste-consent-button');
      console.log("✅ Cookie banner dismissed.");
      // Short pause to let the banner animation finish
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (e) {
      console.log("⚠️ Cookie banner didn't appear or was already gone.");
    }

    // 🛑 STEP 2: Wait for the Status Description to appear
    try {
      await page.waitForSelector('.status-description', { timeout: 10000 });
      console.log("✅ Status info found on page.");
    } catch (e) {
      console.log("⚠️ Could not find .status-description selector.");
    }

    const pageText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    const text = pageText.toLowerCase().replace(/['’]/g, "");
    let currentStatus = 'UNKNOWN';

    // Milestone Check (includes your specific "weve got it" text)
    if (text.includes("delivered on") || text.includes("delivered to") || text.includes("has been delivered")) {
      currentStatus = 'DELIVERED';
    } else if (text.includes("out for delivery") || text.includes("due to be delivered today")) {
      currentStatus = 'OUT_FOR_DELIVERY';
    } else if (text.includes("weve got it") || text.includes("item received") || text.includes("accepted at") || text.includes("in transit") || text.includes("despatched") || text.includes("warrington")) {
      currentStatus = 'WITH_COURIER';
    }

    res.json({ 
      tracking: trackingNumber, 
      status: currentStatus,
      debug_text: pageText.substring(0, 3000) 
    });

  } catch (error) {
    console.error("Scrape Error:", error.message);
    res.status(500).json({ error: 'Failed to scrape Royal Mail', detail: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Final API live on port ${PORT}`));
