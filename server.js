const express = require('express');
const puppeteer = require('puppeteer-core'); 
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = req.query.number;
  
  // 💓 HEARTBEAT: Saves your 1000 credits by ignoring pings
  if (trackingNumber === 'KEEP_ALIVE') {
    return res.json({ status: 'AWAKE', message: 'Heartbeat received' });
  }

  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  console.log(`🤖 Nuclear Scrape for: ${trackingNumber}`);

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&stealth=true`
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // 1. Go to the Royal Mail search page
    await page.goto('https://www.royalmail.com/track-your-item#/', { waitUntil: 'networkidle2', timeout: 30000 });

    // 🛑 NUCLEAR STEP: Force-delete the cookie banner and its overlay from the page code
    await page.evaluate(() => {
      const selectors = ['#trustark-container', '.truste_overlay', '.truste_box_container', '#truste-consent-track', '#truste-consent-buttons'];
      selectors.forEach(s => {
        const el = document.querySelector(s);
        if (el) el.remove();
      });
      // Unlock the scroll/interaction on the body
      document.body.style.overflow = 'auto';
    });

    // 2. Find the input box by its exact internal name
    const inputSelector = 'input[name="trackNumber"]';
    await page.waitForSelector(inputSelector, { timeout: 10000 });
    await page.type(inputSelector, trackingNumber, { delay: 150 });

    // 3. Click the "Track your delivery" button
    await page.click('button.rm-button-primary');

    // 4. Wait for the status description to appear
    await new Promise(resolve => setTimeout(resolve, 8000));

    const pageText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    const text = pageText.toLowerCase().replace(/['’]/g, "");
    let currentStatus = 'UNKNOWN';

    // Milestone Check (Searching for "Weve got it" from your screenshot)
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
      debug_text: pageText.substring(0, 2000) 
    });

  } catch (error) {
    console.error("Scrape Error:", error.message);
    res.status(500).json({ error: 'Failed to scrape Royal Mail', detail: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Nuclear API live on port ${PORT}`));
