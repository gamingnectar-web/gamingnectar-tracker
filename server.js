const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// =====================================================================
// SHOPIFY HELPERS
// =====================================================================
async function getShopifyToken() {
  const { SHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;
  if (!SHOPIFY_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error('Missing Shopify credentials in environment.');
  }

  const response = await fetch(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET
    })
  });

  const data = await response.json();
  if (data.access_token) return data.access_token;
  throw new Error(`Shopify token generation failed: ${JSON.stringify(data)}`);
}

async function shopifyGraphQL(query, variables = {}) {
  const accessToken = await getShopifyToken();
  const response = await fetch(`https://${process.env.SHOPIFY_DOMAIN}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data;
}

// =====================================================================
// 17TRACK HELPERS (USING YOUR VERIFIED CODES)
// =====================================================================
const TRACK17_CARRIER_CODES = {
  ROYAL_MAIL: 11033,
  EVRI: 100331,
  DPD: 100010,
  DHL_EXPRESS: 100001,
  UPS: 100398,
  FEDEX: 100003,
  PARCELFORCE: 11031
};

function build17TrackPayload(trackingNumber, rawCarrier = '') {
  const cleanNumber = String(trackingNumber || '').trim();
  const normalized = String(rawCarrier).toLowerCase().replace(/[^a-z0-9]/g, '');
  
  const payload = { number: cleanNumber };
  let carrierId = null;

  // Matching Logic
  if (normalized.includes('royalmail') || cleanNumber.toUpperCase().endsWith('GB')) {
    carrierId = TRACK17_CARRIER_CODES.ROYAL_MAIL;
  } else if (normalized.includes('evri') || normalized.includes('hermes')) {
    carrierId = TRACK17_CARRIER_CODES.EVRI;
  } else if (normalized.includes('dpd')) {
    carrierId = TRACK17_CARRIER_CODES.DPD;
  } else if (normalized.includes('dhl')) {
    carrierId = TRACK17_CARRIER_CODES.DHL_EXPRESS;
  } else if (normalized.includes('parcelforce')) {
    carrierId = TRACK17_CARRIER_CODES.PARCELFORCE;
  } else if (normalized.includes('ups')) {
    carrierId = TRACK17_CARRIER_CODES.UPS;
  } else if (normalized.includes('fedex')) {
    carrierId = TRACK17_CARRIER_CODES.FEDEX;
  }

  if (carrierId) payload.carrier = carrierId;
  return [payload];
}

async function call17Track(endpoint, payload) {
  const response = await fetch(`https://api.17track.net/track/v2.4/${endpoint}`, {
    method: 'POST',
    headers: { '17token': process.env.TRACK17_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return response.json();
}

// =====================================================================
// 1. TRACKING API (FOR CUSTOMER HUB)
// =====================================================================
app.get('/api/track', async (req, res) => {
  const { number, carrier } = req.query;
  if (number === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!number) return res.status(400).json({ error: 'Missing tracking number' });

  try {
    const payload = build17TrackPayload(number, carrier);
    
    // 1. Register/Refresh instantly
    await call17Track('register', payload);

    // 2. Fetch Info
    let info = await call17Track('gettrackinfo', payload);
    let track = info.data?.accepted?.[0]?.track_info;

    // 🚀 AGGRESSIVE CHECK: If not found or pending, force a re-track and wait 1.5s
    if (!track || track.latest_status?.status === 'NotFound' || !track.tracking) {
      console.log(`Checking now for ${number}...`);
      await call17Track('retrack', payload);
      await new Promise(r => setTimeout(r, 1500)); 
      info = await call17Track('gettrackinfo', payload);
      track = info.data?.accepted?.[0]?.track_info;
    }

    if (!track || !track.tracking) return res.json({ status: 'PENDING', history: [] });

    // Map Statuses
    let currentStatus = 'IN_TRANSIT';
    const s = track.latest_status?.status;
    if (s === 'Delivered') currentStatus = 'DELIVERED';
    else if (['OutForDelivery', 'AvailableForPickup'].includes(s)) currentStatus = 'OUT_FOR_DELIVERY';

    const history = (track.tracking?.providers?.[0]?.events || [])
      .sort((a, b) => new Date(b.time_iso || b.time) - new Date(a.time_iso || a.time))
      .map(e => ({
        date: e.time_iso || e.time || '',
        detail: e.description || 'Update received',
        location: e.location || ''
      }));

    return res.json({ status: currentStatus, history });
  } catch (error) {
    console.error('🚨 Track API Error:', error.message);
    res.status(500).json({ error: 'Internal Error' });
  }
});

// =====================================================================
// 2. SHOPIFY WEBHOOK (AUTO-SYNC)
// =====================================================================
app.post('/api/webhooks/fulfillment', async (req, res) => {
  res.status(200).send('OK');
  try {
    const { tracking_number, tracking_numbers, tracking_company } = req.body;
    const number = tracking_number || (tracking_numbers ? tracking_numbers[0] : null);
    if (!number) return;

    const payload = build17TrackPayload(number, tracking_company);
    await call17Track('register', payload);
    console.log(`✅ Auto-registered ${number}`);
  } catch (error) {
    console.error('🚨 Webhook Error:', error.message);
  }
});

// =====================================================================
// 3. AI PROFILE SYNC
// =====================================================================
app.post('/api/update-ai', async (req, res) => {
  const { customer_id, ai_overview } = req.body;
  if (!customer_id) return res.status(400).json({ error: 'Missing ID' });

  try {
    const ownerId = customer_id.includes('gid://') ? customer_id : `gid://shopify/Customer/${customer_id}`;
    const query = `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`;
    const variables = { metafields: [{ ownerId, namespace: 'custom', key: 'ai_overview', type: 'multi_line_text_field', value: ai_overview }] };

    await shopifyGraphQL(query, variables);
    res.json({ success: true });
  } catch (error) {
    console.error('🚨 AI Sync Failed:', error.message);
    res.status(500).json({ error: 'Sync Failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API active on ${PORT}`));
