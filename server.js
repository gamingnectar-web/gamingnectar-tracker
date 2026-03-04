const express = require('express');
const puppeteer = require('puppeteer-core'); 
const cors = require('cors');

const app = express();

app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = req.query.number;
  
  if (!trackingNumber) {
    return res.status(400).json({ error: 'Missing tracking number' });
  }

  console.log(`🤖 Dialing Browserless to scrape: ${trackingNumber}`);

  try {
    // Connect to Browserless remote server
    const browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=YOUR_BROWSERLESS_API_KEY_HERE`
    });
    
    const page = await browser.newPage();
    
    // Go to Royal Mail and wait for it to load
    const url = `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`;
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // Grab the text
    const pageText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    const text = pageText.toLowerCase();
    let currentStatus = 'UNKNOWN';

    // Check our 3 Milestones
    if (text.includes("delivered")) {
      currentStatus = 'DELIVERED';
    } else if (text.includes("out for delivery") || text.includes("due to be delivered today")) {
      currentStatus = 'OUT_FOR_DELIVERY';
    } else if (text.includes("we've got it") || text.includes("in transit") || text.includes("accepted at")) {
      currentStatus = 'WITH_COURIER';
    }

    res.json({ tracking: trackingNumber, status: currentStatus });

  } catch (error) {
    console.error("Scrape failed:", error);
    res.status(500).json({ error: 'Failed to scrape Royal Mail' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Tracking API running on port ${PORT}`);
});
