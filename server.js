const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// --- 🛠️ HELPER: 17TRACK ID MAPPING (UK 2026 VERIFIED) ---
function getCarrierId(rawCarrier, trackingNumber) {
    const normalized = String(rawCarrier || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const num = String(trackingNumber || '').toUpperCase();

    // 100011 is the specific UK Royal Mail domestic ID
    if (normalized.includes('royalmail') || num.endsWith('GB')) return 100011; 
    
    // 100026 is the 2026 updated Evri/Hermes UK ID
    if (normalized.includes('evri') || normalized.includes('hermes')) return 100026;
    
    // 100019 is the DPD UK specific network
    if (normalized.includes('dpd')) return 100019;
    
    // 100001 is global DHL Express
    if (normalized.includes('dhl')) return 100001;
    
    return null; // Fallback to Auto-Detect
}

// =====================================================================
// 1. TRACKING API (FOR CUSTOMER HUB)
// =====================================================================
app.get('/api/track', async (req, res) => {
  const trackingNumber = String(req.query.number || '').trim();
  const carrierId = getCarrierId(req.query.carrier, trackingNumber);

  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing number' });

  try {
    const apiKey = process.env.TRACK17_API_KEY;
    const headers = { '17token': apiKey, 'Content-Type': 'application/json' };
    const payload = [{ number: trackingNumber, carrier: carrierId }];

    // STEP 1: Always register/retrack to ensure we aren't seeing cached "China Post" data
    await fetch('https://api.17track.net/track/v2.4/register', { method: 'POST', headers, body: JSON.stringify(payload) });
    
    // STEP 2: Fetch the data
    let infoRes = await fetch('https://api.17track.net/track/v2.4/gettrackinfo', { method: 'POST', headers, body: JSON.stringify(payload) });
    let infoData = await infoRes.json();
    let track = infoData.data?.accepted?.[0]?.track_info;

    // STEP 3: AGGRESSIVE RETRY (If 17TRACK is being slow or showing China Post [3011])
    if (!track || track.latest_status?.status === 'NotFound' || track.latest_status?.carrier_id === 3011) {
      console.log(`Force-refreshing ${trackingNumber} for Royal Mail...`);
      await fetch('https://api.17track.net/track/v2.4/retrack', { method: 'POST', headers, body: JSON.stringify(payload) });
      await new Promise(r => setTimeout(r, 2000)); // Wait for the courier's server to respond
      
      infoRes = await fetch('https://api.17track.net/track/v2.4/gettrackinfo', { method: 'POST', headers, body: JSON.stringify(payload) });
      infoData = await infoRes.json();
      track = infoData.data?.accepted?.[0]?.track_info;
    }

    if (!track || !track.tracking) return res.json({ status: 'PENDING', history: [] });

    // Map status to your Hub's UI
    let currentStatus = 'IN_TRANSIT';
    const status = track.latest_status?.status;
    if (status === 'Delivered') currentStatus = 'DELIVERED';
    else if (['OutForDelivery', 'AvailableForPickup'].includes(status)) currentStatus = 'OUT_FOR_DELIVERY';

    const rawEvents = track.tracking?.providers?.[0]?.events || [];
    
    return res.json({
      status: currentStatus,
      history: rawEvents.sort((a,b) => new Date(b.time_iso) - new Date(a.time_iso)).map(e => ({
        date: e.time_iso || e.time, 
        detail: e.description, 
        location: e.location || ''
      }))
    });

  } catch (error) {
    console.error(`🚨 Fatal Error:`, error.message);
    return res.status(500).json({ error: 'Internal Error' });
  }
});

// =====================================================================
// 2. SHOPIFY FULFILLMENT WEBHOOK (AUTO-SYNC)
// =====================================================================
app.post('/api/webhooks/fulfillment', async (req, res) => {
  res.status(200).send('OK');
  try {
    const f = req.body;
    const num = f.tracking_number || f.tracking_numbers?.[0];
    const carrierId = getCarrierId(f.tracking_company, num);
    if (!num) return;

    await fetch('https://api.17track.net/track/v2.4/register', {
      method: 'POST',
      headers: { '17token': process.env.TRACK17_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ number: num, carrier: carrierId }])
    });
    console.log(`✅ Auto-registered fulfillment ${num} (ID: ${carrierId})`);
  } catch (e) { console.error(`🚨 Webhook Error:`, e.message); }
});

// =====================================================================
// 3. 17TRACK DELIVERY WEBHOOK
// =====================================================================
app.post('/api/webhooks/17track-update', async (req, res) => {
  res.status(200).json({ code: 0, message: "success" });
  try {
    const track = req.body.track_info;
    if (track?.latest_status?.status === 'Delivered') {
      console.log(`🎊 Package ${track.tracking_number} delivered!`);
    }
  } catch (e) { console.error(e.message); }
});

// --- SERVER SETUP ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API active on ${PORT}`));
