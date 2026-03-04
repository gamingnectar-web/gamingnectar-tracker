const express = require('express');
const puppeteer = require('puppeteer-core'); 
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = req.query.number;
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  console.log(`🤖 Starting Human-Emulator for: ${trackingNumber}`);

  try {
    const browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&stealth=true`
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');

    // 1. Go to the empty tracking page
    await page.goto('https://www.royalmail.com/track-your-item#/', { waitUntil: 'networkidle2' });

    // 2. Type the tracking number into the box (mimicking a human)
    await page.waitForSelector('input[name="trackNumber"]', { timeout: 10000 });
    await page.type('input[name="trackNumber"]', trackingNumber, { delay: 100 });

    // 3. Click the "Track your delivery" button
    await page.click('button.rm-button-primary');

    // 4. Wait for the actual results to appear
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const pageText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    const text = pageText.toLowerCase().replace(/['’]/g, "");
    let currentStatus = 'UNKNOWN';

    // Milestone Detection
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
      debug_text: pageText.substring(0, 2000) 
    });

  } catch (error) {
    console.error("Human-Emulator failed:", error);
    res.status(500).json({ error: 'Failed to scrape Royal Mail' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Human-Emulator API running on port ${PORT}`));
