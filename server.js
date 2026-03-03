const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();

// Tell the browser bouncer: "Let Shopify in!"
app.use(cors({
  origin: '*' // Note: Using '*' for testing so it definitely connects. We can lock this down to 'gamingnectar.com' later.
}));

// Create the route that Shopify will call
app.get('/api/track', async (req, res) => {
  const trackingNumber = req.query.number;
  
  if (!trackingNumber) {
    return res.status(400).json({ error: 'Missing tracking number' });
  }

  console.log(`🤖 Starting scrape for: ${trackingNumber}`);

  try {
    // Launch the invisible robot browser
    const browser = await puppeteer.launch({ 
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox'] // Crucial for hosting on free servers
    });
    const page = await browser.newPage();
    
    // Go to Royal Mail and WAIT for the network to finish loading the JS
    const url = `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`;
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // Extract all the text from the fully rendered page
    const pageText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    // Check for our magic words
    if (pageText.includes("Delivered") || pageText.includes("We've got it")) {
      res.json({ tracking: trackingNumber, status: 'DELIVERED' });
    } else {
      res.json({ tracking: trackingNumber, status: 'IN_TRANSIT' });
    }

  } catch (error) {
    console.error("Scrape failed:", error);
    res.status(500).json({ error: 'Failed to scrape Royal Mail' });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Tracking API running on port ${PORT}`);
});
