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
    headers: { 
      'Content-Type': 'application/json', 
      'X-Shopify-Access-Token': accessToken 
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await response.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data;
}

// =====================================================================
// 🛠️ AFTERSHIP HELPERS (LATEST 2026-01 API)
// =====================================================================
function getAfterShipSlug(trackingNumber, rawCarrier = '') {
  const norm = String(rawCarrier).toLowerCase().replace(/[^a-z]/g, '');
  const num = String(trackingNumber).toUpperCase();

  if (norm.includes('royalmail') || num.endsWith('GB')) return 'royal-mail';
  if (norm.includes('evri') || norm.includes('hermes')) return 'evri';
  if (norm.includes('dpd')) return 'dpd-uk';
  if (norm.includes('dhl')) return 'dhl';
  return 'royal-mail'; 
}

async function callAfterShip(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'as-api-key': process.env.AFTERSHIP_API_KEY,
      'Content-Type': 'application/json'
    }
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }

  // 🚀 THE FIX: We are now using the absolute newest 2026-01 endpoint
  const res = await fetch(`https://api.aftership.com/tracking/2026-01/${endpoint}`, options);
  const data = await res.json();
  
  // 🚨 Built-in Error Logger
  if (!res.ok || data.meta?.code >= 400) {
      console.log(`🚨 AfterShip API Error [${method} ${endpoint}]:`, JSON.stringify(data));
  }
  
  return data;
}

// =====================================================================
// 1. TRACKING API (FOR YOUR HUB)
// =====================================================================
app.get('/api/track', async (req, res) => {
  const { number, carrier } = req.query;
  if (number === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!number) return res.status(400).json({ error: 'Missing number' });

  try {
    const cleanNumber = String(number).trim();
    const slug = getAfterShipSlug(cleanNumber, carrier);

    // Step 1: Register the tracking (Flat body required by 2026 API)
    await callAfterShip('trackings', 'POST', { 
      tracking_number: cleanNumber, 
      slug: slug 
    });

    // Step 2: Get the status (Search by tracking number to guarantee we find it)
    const data = await callAfterShip(`trackings?tracking_numbers=${cleanNumber}`);
    
    // The new 2026 search returns an array of trackings
    const track = data.data?.trackings?.[0];

    // If AfterShip is still syncing it in the background, return PENDING
    if (!track) return res.json({ status: 'PENDING', history: [] });

    return res.json({
      status: track.tag === 'Delivered' ? 'DELIVERED' : 'IN_TRANSIT',
      history: (track.checkpoints || []).map(cp => ({
        date: cp.checkpoint_time,
        detail: cp.message,
        location: cp.location || ''
      })).reverse() // Ensures newest updates are usually at the top
    });
  } catch (e) {
    console.error('🚨 Hub Error:', e.message);
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
    let num = tracking_number || (tracking_numbers ? tracking_numbers[0] : null);
    if (!num) return;
    
    num = String(num).trim();
    const slug = getAfterShipSlug(num, tracking_company);
    
    const result = await callAfterShip('trackings', 'POST', { 
      tracking_number: num, 
      slug: slug 
    });
    
    // Log success, or ignore if it already exists (Code 4003)
    if (result.meta?.code === 201 || result.meta?.code === 200 || result.meta?.code === 4003) {
        console.log(`✅ Auto-Registered AfterShip: ${num}`);
    }
  } catch (e) { 
      console.error('🚨 Webhook Error:', e.message); 
  }
});

// =====================================================================
// 3. AI PROFILE SYNC (MAINTAINED)
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
app.listen(PORT, () => console.log(`🚀 AfterShip Hub active on ${PORT}`));
