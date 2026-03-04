const express = require('express');
const puppeteer = require('puppeteer-core'); 
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = req.query.number;
  const logs = [];
  
  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  logs.push(`🚀 Start: Tracking ${trackingNumber}`);
  let browser;

  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&stealth=true`
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1200 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    logs.push("🌐 Landing on Royal Mail...");
    await page.goto('https://www.royalmail.com/track-your-item#/', { waitUntil: 'networkidle2', timeout: 30000 });

    // --- STAGE 1: THE COOKIE BOUNCER ---
    try {
      await page.waitForSelector('#truste-consent-button', { timeout: 5000 });
      await page.click('#truste-consent-button');
      logs.push("✅ Cookies cleared.");
      await new Promise(r => setTimeout(r, 2000)); 
    } catch (e) { logs.push("ℹ️ Cookie banner skipped."); }

    // --- STAGE 2: HUMAN EMULATION INPUT ---
    logs.push("⌨️ Finding and typing into #barcode-input...");
    try {
      await page.waitForSelector('#barcode-input', { timeout: 10000 });
      await page.focus('#barcode-input');
      // Type with a slight delay to trigger site's internal validation
      await page.type('#barcode-input', trackingNumber, { delay: 150 });
      logs.push("✅ Typing complete.");
      
      // Pressing 'Enter' is often more reliable than clicking the button
      logs.push("🖱️ Submitting form via Enter key...");
      await page.keyboard.press('Enter');
    } catch (e) {
      logs.push("❌ FAILED: Input box not found.");
      throw new Error("UI Blocked");
    }

    // --- STAGE 3: THE WAIT FOR DATA ---
    logs.push("⏳ Waiting for page to transition to results...");
    try {
      // We wait for the URL to contain 'tracking-results'
      await page.waitForFunction(
        (num) => window.location.href.includes(num) || document.body.innerText.includes('got it'),
        { timeout: 15000 },
        trackingNumber
      );
      logs.push("✅ Transition detected!");
    } catch (e) {
      logs.push("⚠️ Timeout waiting for transition. Checking whatever text we have...");
    }

    await new Promise(r => setTimeout(r, 2000));
    const pageText = await page.evaluate(() => document.body.innerText);
    const text = pageText.toLowerCase().replace(/['’]/g, "");
    let currentStatus = 'UNKNOWN';

    // Milestone Match
    if (text.includes("delivered on") || text.includes("delivered to")) {
      currentStatus = 'DELIVERED';
    } else if (text.includes("out for delivery") || text.includes("due to be delivered today")) {
      currentStatus = 'OUT_FOR_DELIVERY';
    } else if (text.includes("weve got it") || text.includes("item received") || text.includes("warrington mc")) {
      currentStatus = 'WITH_COURIER';
    }
    
    logs.push(`🏁 Final Status: ${currentStatus}`);
    await browser.close();

    res.json({ 
      tracking: trackingNumber, 
      status: currentStatus,
      logs: logs,
      debug_text: pageText.substring(0, 2000) 
    });

  } catch (error) {
    logs.push(`🚨 ERROR: ${error.message}`);
    if (browser) await browser.close();
    res.status(500).json({ error: 'Failed to scrape', logs: logs });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API live on port ${PORT}`));
