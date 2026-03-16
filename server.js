const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// =====================================================================
// 🛠️ AFTERSHIP HELPERS (STABLE UK TRACKING)
// =====================================================================
function getAfterShipSlug(trackingNumber, rawCarrier = '') {
  const norm = String(rawCarrier).toLowerCase().replace(/[^a-z]/g, '');
  const num = String(trackingNumber).toUpperCase();

  if (norm.includes('royalmail') || num.endsWith('GB')) return 'royal-mail';
  if (norm.includes('evri') || norm.includes('hermes')) return 'evri';
  if (norm.includes('dpd')) return 'dpd-uk';
  if (norm.includes('dhl')) return 'dhl';
  return null; // AfterShip will attempt auto-detect if null
}

async function callAfterShip(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'aftership-api-key': process.env.AFTERSHIP_API_KEY,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`https://api.aftership.com/v4/${endpoint}`, options);
  return res.json();
}

// =====================================================================
// 1. TRACKING API (FOR YOUR HUB)
// =====================================================================
app.get('/api/track', async (req, res) => {
  const { number, carrier } = req.query;
  if (number === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!number) return res.status(400).json({ error: 'Missing number' });

  try {
    const slug = getAfterShipSlug(number, carrier);

    // Step 1: Register the tracking (AfterShip handles the "handshake")
    await callAfterShip('trackings', 'POST', { 
      tracking: { tracking_number: number, slug: slug } 
    });

    // Step 2: Get the status
    const data = await callAfterShip(`trackings/${slug || 'auto-detect'}/${number}`);
    const track = data.data?.tracking;

    if (!track) return res.json({ status: 'PENDING', history: [] });

    return res.json({
      status: track.tag === 'Delivered' ? 'DELIVERED' : 'IN_TRANSIT',
      history: (track.checkpoints || []).map(cp => ({
        date: cp.checkpoint_time,
        detail: cp.message,
        location: cp.location || ''
      }))
    });
  } catch (e) {
    console.error('🚨 AfterShip Error:', e.message);
    res.status(500).json({ error: 'Tracking unavailable' });
  }
});

// =====================================================================
// 2. SHOPIFY WEBHOOK (AUTO-SYNC)
// =====================================================================
app.post('/api/webhooks/fulfillment', async (req, res) => {
  res.status(200).send('OK');
  try {
    const { tracking_number, tracking_numbers, tracking_company } = req.body;
    const num = tracking_number || (tracking_numbers ? tracking_numbers[0] : null);
    if (!num) return;

    const slug = getAfterShipSlug(num, tracking_company);
    await callAfterShip('trackings', 'POST', { 
      tracking: { tracking_number: num, slug: slug } 
    });
    console.log(`✅ AfterShip Registered: ${num}`);
  } catch (e) { console.error('🚨 Webhook Error:', e.message); }
});

// =====================================================================
// 3. AI PROFILE SYNC (MAINTAINED)
// =====================================================================
app.post('/api/update-ai', async (req, res) => {
  const { customer_id, ai_overview } = req.body;
  try {
    const ownerId = customer_id.includes('gid://') ? customer_id : `gid://shopify/Customer/${customer_id}`;
    const query = `mutation { metafieldsSet(metafields: [{ ownerId: "${ownerId}", namespace: "custom", key: "ai_overview", type: "multi_line_text_field", value: "${ai_overview.replace(/"/g, '\\"')}" }]) { metafields { id } } }`;
    
    // Shopify auth logic here (reuse your existing working token function)
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Sync failed' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 AfterShip Hub active on ${PORT}`));
