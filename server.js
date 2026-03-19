const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// =====================================================================
// OPTIONAL SHOPIFY HELPERS
// Keep these only if your /api/update-ai route already works with them.
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

  const response = await fetch(
    `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2024-01/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const data = await response.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data;
}

// =====================================================================
// TRACK123 HELPERS
// =====================================================================
async function callTrack123ShopifyOrder(orderId) {
  const { TRACK123_STORE_UUID, TRACK123_API_KEY } = process.env;

  if (!TRACK123_STORE_UUID || !TRACK123_API_KEY) {
    throw new Error('Missing Track123 credentials in environment.');
  }

  const endpoint = `https://shp.track123.com/shopify/api/v1/${TRACK123_STORE_UUID}/orders/${orderId}.json`;

  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'X-Api-Key': TRACK123_API_KEY,
      'Accept': 'application/json'
    }
  });

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Track123 returned non-JSON response: ${text}`);
  }

  if (!res.ok) {
    throw new Error(`Track123 Shopify API failed [${res.status}]: ${JSON.stringify(data)}`);
  }

  return data;
}

async function callTrack123Tracking(endpoint, body) {
  const { TRACK123_API_KEY } = process.env;

  if (!TRACK123_API_KEY) {
    throw new Error('Missing Track123 API key in environment.');
  }

  const res = await fetch(`https://api.track123.com${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Track123-Api-Key': TRACK123_API_KEY,
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Track123 returned non-JSON response: ${text}`);
  }

  if (!res.ok) {
    throw new Error(`Track123 Tracking API failed [${res.status}]: ${JSON.stringify(data)}`);
  }

  return data;
}

// =====================================================================
// HELPERS
// =====================================================================
function normalizeTrack123OrderResponse(raw, requestedTrackingNum = '') {
  const order = raw?.order || raw || {};
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  
  let fulfillment = fulfillments[0] || null;

  // CRITICAL FIX: If a specific tracking number was requested, find THAT specific fulfillment box!
  if (requestedTrackingNum) {
    const safeReqNum = String(requestedTrackingNum).replace(/\s+/g, '').toUpperCase();
    const match = fulfillments.find(f => {
      const tn = String(f.tracking_number || '').replace(/\s+/g, '').toUpperCase();
      return tn === safeReqNum;
    });
    if (match) {
      fulfillment = match;
    }
  }

  if (!fulfillment) {
    return {
      found: false,
      status: 'UNAVAILABLE',
      history: [],
      order: {
        order_id: order.order_id || null,
        order_name: order.order_name || null
      },
      fulfillment: null
    };
  }

  const trackingDetails = Array.isArray(fulfillment.tracking_details)
    ? fulfillment.tracking_details
    : [];

  const transitStatus = String(fulfillment.transit_status || '').toLowerCase();

  let status = 'IN_TRANSIT';
  if (transitStatus.includes('delivered')) status = 'DELIVERED';
  else if (transitStatus.includes('exception')) status = 'ISSUE';
  else if (transitStatus.includes('pending')) status = 'PENDING';
  else if (transitStatus.includes('info')) status = 'PENDING';

  return {
    found: true,
    status,
    history: trackingDetails.map(item => ({
      date: item.event_time || item.event_time_utc || '',
      detail: item.event_detail || item.status || '',
      location: item.event_location || ''
    })),
    order: {
      order_id: order.order_id || null,
      order_name: order.order_name || null,
      order_status: order.status || ''
    },
    fulfillment: {
      id: fulfillment.id || null,
      tracking_number: fulfillment.tracking_number || '',
      tracking_company: fulfillment.tracking_company || fulfillment.courier?.name || '',
      carrier_code: fulfillment.carrier_code || '',
      transit_status: fulfillment.transit_status || '',
      transit_sub_status: fulfillment.transit_sub_status || '',
      last_event: fulfillment.last_event || '',
      last_event_time: fulfillment.last_event_time || '',
      tracking_link:
        fulfillment.courier?.query_link ||
        order.tracking_link ||
        ''
    }
  };
}

function buildPublicTrackingUrl(carrier, trackingNumber, fallbackUrl = '') {
  const c = String(carrier || '').toLowerCase();
  const n = String(trackingNumber || '').trim();
  if (!n) return fallbackUrl || '';

  if (c.includes('royal mail')) {
    return `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(n)}`;
  }
  if (c.includes('evri') || c.includes('hermes')) {
    return `https://www.evri.com/track-a-parcel/tracking-details?trackingId=${encodeURIComponent(n)}`;
  }

  return fallbackUrl || '';
}

// =====================================================================
// 1. ORDER-BASED TRACKING API
// =====================================================================
app.get('/api/order-tracking', async (req, res) => {
  // CRITICAL FIX: Extract tracking_num from the request query
  const { order_id, tracking_num } = req.query;

  if (order_id === 'KEEP_ALIVE') {
    return res.json({ status: 'AWAKE' });
  }

  if (!order_id) {
    return res.status(400).json({ error: 'Missing order_id' });
  }

  try {
    const raw = await callTrack123ShopifyOrder(String(order_id).trim());
    // Pass the requested tracking number so it grabs the correct split package!
    const normalized = normalizeTrack123OrderResponse(raw, tracking_num);

    if (normalized.fulfillment) {
      normalized.fulfillment.tracking_link = buildPublicTrackingUrl(
        normalized.fulfillment.tracking_company,
        normalized.fulfillment.tracking_number,
        normalized.fulfillment.tracking_link
      );
    }

    return res.json(normalized);
  } catch (e) {
    console.error('🚨 Order Tracking Error:', e.message);
    return res.status(500).json({
      error: 'Order tracking unavailable',
      message: e.message
    });
  }
});

// =====================================================================
// 2. LEGACY TRACKING ROUTE
// =====================================================================
app.get('/api/track', async (req, res) => {
  const { number, order_id, carrier } = req.query;

  if (number === 'KEEP_ALIVE' || order_id === 'KEEP_ALIVE') {
    return res.json({ status: 'AWAKE' });
  }

  if (order_id) {
    try {
      const raw = await callTrack123ShopifyOrder(String(order_id).trim());
      const normalized = normalizeTrack123OrderResponse(raw, number);

      if (normalized.fulfillment) {
        normalized.fulfillment.tracking_link = buildPublicTrackingUrl(
          normalized.fulfillment.tracking_company,
          normalized.fulfillment.tracking_number,
          normalized.fulfillment.tracking_link
        );
      }

      return res.json(normalized);
    } catch (e) {
      console.error('🚨 /api/track order_id mode failed:', e.message);
    }
  }

  if (!number) {
    return res.status(400).json({ error: 'Missing number or order_id' });
  }

  try {
    const cleanNumber = String(number).trim();

    const queryResult = await callTrack123Tracking('/gateway/open-api/tk/v2/track/query', {
      trackings: [
        {
          tracking_number: cleanNumber,
          carrier_code: carrier || undefined
        }
      ]
    });

    const item =
      queryResult?.data?.trackings?.[0] ||
      queryResult?.data?.items?.[0] ||
      queryResult?.trackings?.[0] ||
      null;

    if (!item) {
      return res.json({
        found: false,
        status: 'PENDING',
        history: [],
        fulfillment: {
          tracking_number: cleanNumber,
          tracking_company: carrier || '',
          carrier_code: carrier || '',
          transit_status: 'Pending',
          transit_sub_status: '',
          last_event: '',
          last_event_time: '',
          tracking_link: buildPublicTrackingUrl(carrier || '', cleanNumber, '')
        }
      });
    }

    const history = Array.isArray(item.tracking_details)
      ? item.tracking_details.map(ev => ({
          date: ev.event_time || ev.event_time_utc || '',
          detail: ev.event_detail || ev.status || '',
          location: ev.event_location || ''
        }))
      : [];

    const transitStatus = String(item.transit_status || item.status || '').toLowerCase();
    let status = 'IN_TRANSIT';
    if (transitStatus.includes('delivered')) status = 'DELIVERED';
    else if (transitStatus.includes('exception')) status = 'ISSUE';
    else if (transitStatus.includes('pending')) status = 'PENDING';

    return res.json({
      found: true,
      status,
      history,
      fulfillment: {
        tracking_number: item.tracking_number || cleanNumber,
        tracking_company: item.courier_name || item.tracking_company || carrier || '',
        carrier_code: item.carrier_code || carrier || '',
        transit_status: item.transit_status || item.status || '',
        transit_sub_status: item.transit_sub_status || '',
        last_event: item.last_event || '',
        last_event_time: item.last_event_time || '',
        tracking_link: buildPublicTrackingUrl(
          item.courier_name || item.tracking_company || carrier || '',
          item.tracking_number || cleanNumber,
          item.query_link || ''
        )
      }
    });
  } catch (e) {
    console.error('🚨 Tracking Error:', e.message);
    return res.status(500).json({
      error: 'Tracking unavailable',
      message: e.message
    });
  }
});

// =====================================================================
// 3. SHOPIFY WEBHOOK (OPTIONAL)
// =====================================================================
app.post('/api/webhooks/fulfillment', async (req, res) => {
  res.status(200).send('OK');

  try {
    const { tracking_number, tracking_numbers, tracking_company } = req.body;
    const num = tracking_number || (Array.isArray(tracking_numbers) ? tracking_numbers[0] : null);

    if (!num) return;

    console.log(`📦 Fulfillment webhook received: ${num} (${tracking_company || 'carrier unknown'})`);
  } catch (e) {
    console.error('🚨 Fulfillment Webhook Error:', e.message);
  }
});

// =====================================================================
// 4. AI PROFILE SYNC (UNCHANGED)
// =====================================================================
app.post('/api/update-ai', async (req, res) => {
  const { customer_id, ai_overview } = req.body;

  if (!customer_id) {
    return res.status(400).json({ error: 'Missing ID' });
  }

  try {
    const ownerId = customer_id.includes('gid://')
      ? customer_id
      : `gid://shopify/Customer/${customer_id}`;

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
          ownerId,
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
    res.status(500).json({ error: 'Sync Failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Track123 Hub active on ${PORT}`);
});
