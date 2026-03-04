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
    // Connect to Browserless with Stealth Mode turned ON
    const browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&stealth=true`
    });
    
    const page = await browser.newPage();
    
    // Go to Royal Mail and wait for the network to quiet down
    const url = `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`;
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // Hard 3-second pause to let the Royal Mail loading spinner finish
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Grab the exact text from the page
    const pageText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    // Strip out all apostrophes and make it lowercase
    const text = pageText.toLowerCase().replace(/['’]/g, "");
    let currentStatus = 'UNKNOWN';

    // The 3 Milestones (Updated to ignore cookie banner text)
    if (text.includes("delivered on") || text.includes("delivered to") || text.includes("delivered by") || text.includes("has been delivered")) {
      currentStatus = 'DELIVERED';
    } else if (text.includes("out for delivery") || text.includes("due to be delivered today")) {
      currentStatus = 'OUT_FOR_DELIVERY';
    } else if (text.includes("weve got it") || text.includes("in transit") || text.includes("accepted at") || text.includes("item received") || text.includes("despatched")) {
      currentStatus = 'WITH_COURIER';
    }

    res.json({ 
      tracking: trackingNumber, 
      status: currentStatus,
      debug_text: pageText.substring(0, 200) 
    });

  } catch (error) {
    console.error("Scrape failed:", error);
    res.status(500).json({ error: 'Failed to scrape Royal Mail' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Tracking API running on port ${PORT}`);
});
