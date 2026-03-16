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

  if (!shopifyDomain || !clientId || !clientSecret) {
    throw new Error('Missing Shopify credentials in environment.');
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

  throw new Error(`Shopify token generation failed: ${JSON.stringify(data)}`);
}

// --- 🛠️ HELPER: SHOPIFY GRAPHQL CALLER ---
async function shopifyGraphQL(query, variables = {}) {
  const shopifyDomain = process.env.SHOPIFY_DOMAIN;
  const accessToken = await getShopifyToken();

  const response = await fetch(`https://${shopifyDomain}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json();

  if (data.errors) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data;
}

// =====================================================================
// 17TRACK CARRIER HELPERS
// =====================================================================
//
// Source of truth:
// https://res.17track.net/asset/carrier/info/apicarrier.all.csv
//
// Verified current examples from 17TRACK official carrier list:
// Royal Mail  = 11033
// Parcelforce = 11031
// DHL Express = 100001
// UPS         = 100398
// FedEx       = 100003
// DPD         = 100010
// EVRi        = 100331
//
// If carrier is unknown, omit `carrier` and let 17TRACK auto-detect.

const TRACK17_CARRIER_CODES = {
  ROYAL_MAIL: 11033,
  PARCELFORCE: 11031,
  DHL_EXPRESS: 100001,
  UPS: 100398,
  FEDEX: 100003,
  DPD: 100010,
  EVRI: 100331
};

function normalizeCarrierName(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function detect17TrackCarrierId(rawCarrier = '') {
  const normalizedCarrier = normalizeCarrierName(rawCarrier);

  // Royal Mail / Parcelforce
  if (normalizedCarrier.includes('royalmail')) {
    return TRACK17_CARRIER_CODES.ROYAL_MAIL;
  }

  if (normalizedCarrier.includes('parcelforce')) {
    return TRACK17_CARRIER_CODES.PARCELFORCE;
  }

  // EVRi / Hermes
  if (normalizedCarrier.includes('evri') || normalizedCarrier.includes('hermes')) {
    return TRACK17_CARRIER_CODES.EVRI;
  }

  // DPD
  if (normalizedCarrier === 'dpd' || normalizedCarrier.includes('dpdlocal')) {
    return TRACK17_CARRIER_CODES.DPD;
  }

  // DHL
  if (
    normalizedCarrier === 'dhl' ||
    normalizedCarrier.includes('dhlexpress') ||
    normalizedCarrier.includes('dhlparcel')
  ) {
    return TRACK17_CARRIER_CODES.DHL_EXPRESS;
  }

  // UPS
  if (
    normalizedCarrier === 'ups' ||
    normalizedCarrier.includes('unitedparcel') ||
    normalizedCarrier.includes('unitedparcelservice')
  ) {
    return TRACK17_CARRIER_CODES.UPS;
  }

  // FedEx
  if (
    normalizedCarrier.includes('fedex') ||
    normalizedCarrier.includes('federalexpress')
  ) {
    return TRACK17_CARRIER_CODES.FEDEX;
  }

  // Unknown: let 17TRACK auto-detect
  return null;
}

function build17TrackPayload(trackingNumber, rawCarrier = '') {
  const cleanNumber = String(trackingNumber || '').trim();

  if (!cleanNumber) {
    throw new Error('Missing tracking number');
  }

  const payload = [{ number: cleanNumber }];
  const carrierId = detect17TrackCarrierId(rawCarrier);

  if (carrierId) {
    payload[0].carrier = carrierId;
  }

  return payload;
}

async function registerWith17Track(trackingPayload) {
  const apiKey = process.env.TRACK17_API_KEY;

  if (!apiKey) {
    throw new Error('Missing TRACK17_API_KEY in environment.');
  }

  const response = await fetch('https://api.17track.net/track/v2.4/register', {
    method: 'POST',
    headers: {
      '17token': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(trackingPayload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`17TRACK register HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function get17TrackInfo(trackingPayload) {
  const apiKey = process.env.TRACK17_API_KEY;

  if (!apiKey) {
    throw new Error('Missing TRACK17_API_KEY in environment.');
  }

  const response = await fetch('https://api.17track.net/track/v2.4/gettrackinfo', {
    method: 'POST',
    headers: {
      '17token': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(trackingPayload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`17TRACK gettrackinfo HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

// =====================================================================
// 1. TRACKING API (FOR CUSTOMER HUB ON-DEMAND)
// =====================================================================
app.get('/api/track', async (req, res) => {
  const trackingNumber = String(req.query.number || '').trim();
  const rawCarrier = String(req.query.carrier || '');

  if (trackingNumber === 'KEEP_ALIVE') {
    return res.json({ status: 'AWAKE' });
  }

  if (!trackingNumber) {
    return res.status(400).json({ error: 'Missing tracking number' });
  }

  try {
    const trackingPayload = build17TrackPayload(trackingNumber, rawCarrier);

    // Register first
    const registerData = await registerWith17Track(trackingPayload);

    // Optional debug logging
    console.log('17TRACK register response:', JSON.stringify(registerData));

    // Then fetch info
    const infoData = await get17TrackInfo(trackingPayload);
    console.log('17TRACK track info response:', JSON.stringify(infoData));

    const accepted = infoData.data?.accepted?.[0];
    const trackData = accepted?.track_info;

    if (!trackData || !trackData.tracking) {
      return res.json({
        status: 'PENDING',
        history: []
      });
    }

    let currentStatus = 'IN_TRANSIT';
    const tmStatus = trackData.latest_status?.status;

    if (tmStatus === 'Delivered') {
      currentStatus = 'DELIVERED';
    } else if (tmStatus === 'OutForDelivery' || tmStatus === 'AvailableForPickup') {
      currentStatus = 'OUT_FOR_DELIVERY';
    }

    const rawEvents = trackData.tracking?.providers?.[0]?.events || [];
    rawEvents.sort(
      (a, b) => new Date(b.time_iso || b.time || 0) - new Date(a.time_iso || a.time || 0)
    );

    const formattedHistory = rawEvents.map((event) => ({
      date: event.time_iso || event.time || '',
      detail: event.description || 'Update received',
      location: event.location || ''
    }));

    return res.json({
      status: currentStatus,
      history: formattedHistory
    });
  } catch (error) {
    console.error('🚨 Track API Error:', error.message);
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

    const trackingNumber =
      fulfillment.tracking_number ||
      (Array.isArray(fulfillment.tracking_numbers) ? fulfillment.tracking_numbers[0] : '');

    const rawCarrier =
      fulfillment.tracking_company ||
      fulfillment.shipping_company ||
      '';

    if (!trackingNumber) return;

    console.log(`🚀 Shopify Fulfillment Webhook: processing ${trackingNumber}`);
    console.log(`Carrier from Shopify: ${rawCarrier || '(none provided)'}`);

    const trackingPayload = build17TrackPayload(trackingNumber, rawCarrier);

    await registerWith17Track(trackingPayload);

    console.log(`✅ Successfully auto-registered ${trackingNumber} in 17TRACK`);
  } catch (error) {
    console.error('🚨 Webhook Error:', error.message);
  }
});

// =====================================================================
// 3. AI PROFILE SYNC
// =====================================================================
app.post('/api/update-ai', async (req, res) => {
  const { customer_id, ai_overview } = req.body;

  try {
    const query = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      metafields: [
        {
          ownerId: `gid://shopify/Customer/${customer_id}`,
          namespace: 'custom',
          key: 'ai_overview',
          type: 'multi_line_text_field',
          value: ai_overview
        }
      ]
    };

    await shopifyGraphQL(query, variables);
    res.json({ success: true });
  } catch (error) {
    console.error('🚨 AI Sync Failed:', error.message);
    res.status(500).json({ error: 'AI Sync Failed' });
  }
});

// =====================================================================
// SERVER STARTUP
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API active on ${PORT}`));
