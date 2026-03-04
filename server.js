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
      // ⚠️ DONT FORGET TO PASTE YOUR ACTUAL API KEY HERE ⚠️
      browserWSEndpoint: `wss://chrome.browserless.io?token=2U5O4xleNcnBPTae50d62ee196bc350092b3c172fc66d1bdb`
    });
    
    const page = await browser.newPage();
    
    // Go to Royal Mail and wait for the network to quiet down
    const url = `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`;
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // 🛑 MAGIC FIX 1: Add a hard 3-second pause to let the Royal Mail loading spinner finish
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Grab the exact text from the page
    const pageText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    // 🛑 MAGIC FIX 2: Strip out all apostrophes so "We've" and "We’ve" both become "weve"
    const text = pageText.toLowerCase().replace(/['’]/g, "");
    let currentStatus = 'UNKNOWN';

    // Check our 3 Milestones (updated with exact words from your screenshot)
    if (text.includes("delivered")) {
      currentStatus = 'DELIVERED';
    } else if (text.includes("out for delivery") || text.includes("due to be delivered today")) {
      currentStatus = 'OUT_FOR_DELIVERY';
    } else if (text.includes("weve got it") || text.includes("in transit") || text.includes("accepted at") || text.includes("item received") || text.includes("despatched")) {
      currentStatus = 'WITH_COURIER';
    }

    res.json({ 
      tracking: trackingNumber, 
      status: currentStatus,
      // Sending the first 200 characters back just in case we ever need to debug again!
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
