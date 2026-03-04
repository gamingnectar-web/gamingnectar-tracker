const express = require('express');
const puppeteer = require('puppeteer-core'); 
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = req.query.number;
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  console.log(`🤖 Dialing Browserless to scrape: ${trackingNumber}`);

  try {
    const browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&stealth=true`
    });
    
    const page = await browser.newPage();
    const url = `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`;
    
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // 🛑 X-RAY VISION FIX: Wait specifically for the tracking info to load behind the banner
    try {
      await page.waitForFunction(
        () => document.body.innerText.includes('Tracking number'),
        { timeout: 10000 }
      );
    } catch (e) {
      console.log("Timeout waiting for 'Tracking number' text. Page might be slow.");
    }

    // Give it 1 extra second just to be safe
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const pageText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    const text = pageText.toLowerCase().replace(/['’]/g, "");
    let currentStatus = 'UNKNOWN';

    // Improved keyword detection
    if (text.includes("delivered on") || text.includes("delivered to") || text.includes("has been delivered")) {
      currentStatus = 'DELIVERED';
    } else if (text.includes("out for delivery") || text.includes("due to be delivered today")) {
      currentStatus = 'OUT_FOR_DELIVERY';
    } else if (text.includes("weve got it") || text.includes("item received") || text.includes("accepted at") || text.includes("in transit") || text.includes("despatched")) {
      currentStatus = 'WITH_COURIER';
    }

    res.json({ 
      tracking: trackingNumber, 
      status: currentStatus,
      // Increased to 1000 characters so we can see past the cookie banner in logs
      debug_text: pageText.substring(0, 1000) 
    });

  } catch (error) {
    console.error("Scrape failed:", error);
    res.status(500).json({ error: 'Failed to scrape Royal Mail' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Tracking API running on port ${PORT}`));
