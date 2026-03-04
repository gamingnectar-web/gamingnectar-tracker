const express = require('express');
const puppeteer = require('puppeteer-core'); 
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = req.query.number;
  
  // 💓 HEARTBEAT: Keep Render awake without wasting Browserless credits
  if (trackingNumber === 'KEEP_ALIVE') {
    return res.json({ status: 'AWAKE', message: 'Heartbeat received' });
  }

  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  console.log(`🤖 Starting Final Scrape for: ${trackingNumber}`);

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&stealth=true`
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // 1. Go to the main tracking page
    await page.goto('https://www.royalmail.com/track-your-item#/', { waitUntil: 'networkidle2', timeout: 30000 });

    // 2. Click the specific TrustArc button ID to clear the cookie overlay
    try {
      await page.waitForSelector('#truste-consent-button', { timeout: 5000 });
      await page.click('#truste-consent-button');
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (e) { console.log("Cookie banner not found or already closed."); }

    // 3. TARGETED INPUT: Find the input specifically for tracking, not site search
    // We look for the input with 'trackNumber' in its name or ID
    const inputSelector = 'input[name*="trackNumber"], #trackNumber, input[placeholder*="reference"]';
    await page.waitForSelector(inputSelector, { timeout: 10000 });
    await page.click(inputSelector);
    await page.type(inputSelector, trackingNumber, { delay: 100 });

    // 4. PRESS ENTER
    await page.keyboard.press('Enter');

    // 5. WAIT for the status description div to appear
    try {
      await page.waitForSelector('.status-description', { timeout: 12000 });
    } catch (e) { console.log("Still waiting for results..."); }

    // 6. Final pause to let any animations settle
    await new Promise(resolve => setTimeout(resolve, 2000));

    const pageText = await page.evaluate(() => document.body.innerText);
    const text = pageText.toLowerCase().replace(/['’]/g, "");
    let currentStatus = 'UNKNOWN';

    // Milestone Detection
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
app.listen(PORT, () => console.log(`🚀 Final Tracking API live on port ${PORT}`));
