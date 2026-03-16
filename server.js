const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// --- 🚀 SHOPIFY AUTO-AUTHENTICATOR ---
async function getShopifyToken() {
  const shopifyDomain = process.env.SHOPIFY_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing Shopify Credentials in Environment.");
  }

  const response = await fetch(`https://${shopifyDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  const data = await response.json();
  if (data.access_token) return data.access_token;
  throw new Error("Shopify Token generation failed.");
}

// --- 🛠️ HELPER: SHOPIFY GRAPHQL CALLER ---
async function shopifyGraphQL(query, variables = {}) {
  const shopifyDomain = process.env.SHOPIFY_DOMAIN;
  const accessToken = await getShopifyToken();
  const response = await fetch(`https://${shopifyDomain}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query, variables })
  });
  const data = await response.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data;
}

// =====================================================================
// 1. TRACKING API (FOR CUSTOMER HUB ON-DEMAND)
// =====================================================================
app.get('/api/track', async (req, res) => {
  const trackingNumber = String(req.query.number || '').trim();
  const rawCarrier = String(req.query.carrier || '').toLowerCase();

  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  // Carrier normalization for 17TRACK IDs
  const normalizedCarrier = rawCarrier.replace(/[^a-z0-9]/g, '');
  let carrierId = null;

  if (normalizedCarrier.includes('royalmail') || trackingNumber.toUpperCase().endsWith('GB')) carrierId = 3011;
  else if (normalizedCarrier.includes('evri') || normalizedCarrier.includes('hermes')) carrierId = 10026;
  else if (normalizedCarrier.includes('dpd')) carrierId = 10019;
  else if (normalizedCarrier.includes('dhl')) carrierId = 10001;

  try {
    const apiKey = process.env.TRACK17_API_KEY;
    const headers = { '17token': apiKey, 'Content-Type': 'application/json' };
    const trackingPayload = [{ number: trackingNumber }];
    if (carrierId) trackingPayload[0].carrier = carrierId;

    // Register Number
    await fetch('https://api.17track.net/track/v2.4/register', {
      method: 'POST', headers, body: JSON.stringify(trackingPayload)
    });

    // Get Info (Strictly passing carrierId to avoid China Post defaults)
    const infoRes = await fetch('https://api.17track.net/track/v2.4/gettrackinfo', {
      method: 'POST', headers, body: JSON.stringify(trackingPayload)
    });

    const infoData = await infoRes.json();
    const trackData = infoData.data?.accepted?.[0]?.track_info;

    if (!trackData || !trackData.tracking) return res.json({ status: 'PENDING', history: [] });

    let currentStatus = 'IN_TRANSIT';
    const tmStatus = trackData.latest_status?.status;
    if (tmStatus === 'Delivered') currentStatus = 'DELIVERED';
    else if (tmStatus === 'OutForDelivery' || tmStatus === 'AvailableForPickup') currentStatus = 'OUT_FOR_DELIVERY';

    const rawEvents = trackData.tracking?.providers?.[0]?.events || [];
    rawEvents.sort((a, b) => new Date(b.time_iso || b.time) - new Date(a.time_iso || a.time));

    const formattedHistory = rawEvents.map(event => ({
      date: event.time_iso || event.time || '',
      detail: event.description || 'Update received',
      location: event.location || ''
    }));

    return res.json({ status: currentStatus, history: formattedHistory });
  } catch (error) {
    console.error(`🚨 Track API Error:`, error.message);
    return res.status(500).json({ error: 'Internal Error' });
  }
});

// =====================================================================
// 2. SHOPIFY FULFILLMENT WEBHOOK (AUTO-SYNC TO 17TRACK)
// =====================================================================
app.post('/api/webhooks/fulfillment', async (req, res) => {
  res.status(200).send('OK'); 

  try {
    const fulfillment = req.body;
    const trackingNumber = fulfillment.tracking_number || (fulfillment.tracking_numbers && fulfillment.tracking_numbers[0]);
    const rawCarrier = fulfillment.tracking_company || '';

    if (!trackingNumber) return;

    console.log(`\n🚀 Shopify Fulfillment Webhook! Processing ${trackingNumber}...`);

    const normalizedCarrier = rawCarrier.toLowerCase().replace(/[^a-z0-9]/g, '');
    let carrierId = null;

    if (normalizedCarrier.includes('royalmail') || trackingNumber.toUpperCase().endsWith('GB')) carrierId = 3011;
    else if (normalizedCarrier.includes('evri') || normalizedCarrier.includes('hermes')) carrierId = 10026;
    else if (normalizedCarrier.includes('dpd')) carrierId = 10019;
    else if (normalizedCarrier.includes('dhl')) carrierId = 10001;

    const apiKey = process.env.TRACK17_API_KEY;
    const trackingPayload = [{ number: trackingNumber }];
    if (carrierId) trackingPayload[0].carrier = carrierId;

    await fetch('https://api.17track.net/track/v2.4/register', {
      method: 'POST',
      headers: { '17token': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(trackingPayload)
    });

    console.log(`✅ Successfully auto-registered ${trackingNumber} in 17TRACK!`);
  } catch (error) {
    console.error(`🚨 Webhook Error:`, error.message);
  }
});

// =====================================================================
// 3. AI PROFILE SYNC
// =====================================================================
app.post('/api/update-ai', async (req, res) => {
  const { customer_id, ai_overview } = req.body;
  try {
    const query = `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`;
    const variables = {
      metafields: [{
        ownerId: `gid://shopify/Customer/${customer_id}`,
        namespace: "custom", key: "ai_overview",
        type: "multi_line_text_field", value: ai_overview
      }]
    };
    await shopifyGraphQL(query, variables);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'AI Sync Failed' });
  }
});

// =====================================================================
// SERVER STARTUP
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API active on ${PORT}`));
