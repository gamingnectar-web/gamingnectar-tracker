const express = require('express');
const puppeteer = require('puppeteer-core'); 
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = req.query.number;
  const logs = []; // 📝 Our breadcrumb trail
  
  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  logs.push(`🚀 Start: Tracking ${trackingNumber}`);
  let browser;

  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&stealth=true`
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    logs.push("🌐 Navigating to Royal Mail...");
    await page.goto('https://www.royalmail.com/track-your-item#/', { waitUntil: 'networkidle2', timeout: 30000 });

    // --- STAGE 1: COOKIE BANNER ---
    try {
      logs.push("🍪 Checking for cookie banner...");
      await page.waitForSelector('#truste-consent-button', { timeout: 5000 });
      await page.click('#truste-consent-button');
      logs.push("✅ Clicked 'Accept All' cookie button.");
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      logs.push("ℹ️ Cookie banner not found (skipping).");
    }

    // --- STAGE 2: FINDING INPUT ---
    logs.push("🔍 Looking for input field #barcode-input...");
    try {
      await page.waitForSelector('#barcode-input', { timeout: 10000 });
      logs.push("✅ Found #barcode-input.");
      
      // Clear anything already in there and type
      await page.click('#barcode-input', { clickCount: 3 }); 
      await page.keyboard.press('Backspace');
      await page.type('#barcode-input', trackingNumber, { delay: 100 });
      logs.push("⌨️ Typed tracking number successfully.");
    } catch (e) {
      logs.push("❌ FAILED to find #barcode-input. Site might be blocking us.");
      throw new Error("Input Box Not Found");
    }

    // --- STAGE 3: SUBMITTING ---
    logs.push("🖱️ Clicking Submit button...");
    await page.click('#submit');
    logs.push("✅ Clicked Submit.");

    // Wait for content update
    await new Promise(r => setTimeout(r, 8000));
    
    const pageText = await page.evaluate(() => document.body.innerText);
    const text = pageText.toLowerCase().replace(/['’]/g, "");
    let currentStatus = 'UNKNOWN';

    // Milestone Check
    if (text.includes("delivered on") || text.includes("delivered to")) {
      currentStatus = 'DELIVERED';
    } else if (text.includes("out for delivery") || text.includes("due to be delivered today")) {
      currentStatus = 'OUT_FOR_DELIVERY';
    } else if (text.includes("weve got it") || text.includes("item received") || text.includes("warrington")) {
      currentStatus = 'WITH_COURIER';
    }
    
    logs.push(`🏁 Finished. Status determined as: ${currentStatus}`);

    res.json({ 
      tracking: trackingNumber, 
      status: currentStatus,
      logs: logs, // 📝 See the breadcrumbs!
      debug_text: pageText.substring(0, 1500) 
    });

  } catch (error) {
    logs.push(`🚨 CRITICAL ERROR: ${error.message}`);
    res.status(500).json({ error: 'Failed to scrape', logs: logs });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Debugger API live on port ${PORT}`));
