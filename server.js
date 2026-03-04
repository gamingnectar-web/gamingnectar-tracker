const express = require('express');
const puppeteer = require('puppeteer-core'); 
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = req.query.number;
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  console.log(`🤖 Force-Submit Strategy for: ${trackingNumber}`);

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&stealth=true`
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // 1. Start at the clean search page
    await page.goto('https://www.royalmail.com/track-your-item#/', { waitUntil: 'networkidle2', timeout: 30000 });

    // 2. Click your specific TrustArc button ID to clear the overlay
    try {
      await page.waitForSelector('#truste-consent-button', { timeout: 5000 });
      await page.click('#truste-consent-button');
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (e) { console.log("Cookie banner already gone."); }

    // 3. Type the number into the first input and hit Enter
    await page.waitForSelector('input', { timeout: 10000 });
    await page.type('input', trackingNumber, { delay: 150 });
    await page.keyboard.press('Enter');

    // 4. Wait specifically for your status-description div to appear
    try {
      await page.waitForSelector('.status-description', { timeout: 12000 });
    } catch (e) { console.log("Still loading results..."); }

    const pageText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    const text = pageText.toLowerCase().replace(/['’]/g, "");
    let currentStatus = 'UNKNOWN';

    // Milestone Check - searching for your "Weve got it" phrase
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
