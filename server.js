const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// --- 🚀 NEW SHOPIFY 2026 AUTO-AUTHENTICATOR ---
async function getShopifyToken() {
  const shopifyDomain = process.env.SHOPIFY_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
      throw new Error("Missing Client ID or Secret in Render Environment.");
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
  if (data.access_token) {
    return data.access_token; 
  } else {
    throw new Error("Token generation failed: " + JSON.stringify(data));
  }
}

// --- 🛠️ HELPER: UNIVERSAL SHOPIFY GRAPHQL CALLER ---
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
    if (data.errors) throw new Error(JSON.stringify(data.errors));
    return data;
}

// =====================================================================
// 1. TRACKING (NOW POWERED BY 17TRACK 🚀)
// =====================================================================
app.get('/api/track', async (req, res) => {
  const trackingNumber = String(req.query.number || '').trim();
  const rawCarrier = String(req.query.carrier || '').toLowerCase();

  console.log(`\n🔍 Received 17TRACK tracking request for: ${trackingNumber}`);

  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  const normalizedCarrier = rawCarrier.replace(/[^a-z0-9]/g, '');

  let carrierId = null;
  if (normalizedCarrier.includes('royalmail') || trackingNumber.toUpperCase().endsWith('GB')) carrierId = 3011;
  else if (normalizedCarrier.includes('evri') || normalizedCarrier.includes('hermes')) carrierId = 10026; 
  else if (normalizedCarrier.includes('dpd')) carrierId = 10019;
  else if (normalizedCarrier.includes('dhl')) carrierId = 10001;

  try {
    const apiKey = process.env.TRACK17_API_KEY;
    if (!apiKey) throw new Error("Missing TRACK17_API_KEY in environment variables.");

    const headers = { '17token': apiKey, 'Content-Type': 'application/json' };

    // STEP 1: Tell 17TRACK that Royal Mail is the FINAL destination carrier
    const registerPayload = [{ number: trackingNumber }];
    if (carrierId) {
        registerPayload[0].carrier = carrierId;
        registerPayload[0].final_carrier = carrierId; // Forces Royal Mail as destination
    }

    await fetch('https://api.17track.net/track/v2.4/register', {
      method: 'POST', headers: headers, body: JSON.stringify(registerPayload)
    });

    // STEP 2: Fetch the actual tracking info
    const infoRes = await fetch('https://api.17track.net/track/v2.4/gettrackinfo', {
      method: 'POST', headers: headers, body: JSON.stringify([{ number: trackingNumber }])
    });

    const infoData = await infoRes.json();
    const trackData = infoData.data?.accepted?.[0]?.track_info;

    if (!trackData || !trackData.tracking) {
      return res.json({ status: 'PENDING', history: [] });
    }

    // STEP 3: Map 17TRACK status
    let currentStatus = 'IN_TRANSIT';
    const tmStatus = trackData.latest_status?.status;
    
    if (tmStatus === 'Delivered') currentStatus = 'DELIVERED';
    else if (tmStatus === 'OutForDelivery' || tmStatus === 'AvailableForPickup') currentStatus = 'OUT_FOR_DELIVERY';

    // 🚀 FIX: Merge events from ALL carriers (Origin + Final Destination)
    let rawEvents = [];
    if (trackData.tracking?.providers) {
        trackData.tracking.providers.forEach(provider => {
            if (provider.events) rawEvents = rawEvents.concat(provider.events);
        });
    }
    
    // Sort events by time (newest first)
    rawEvents.sort((a, b) => new Date(b.time_iso || b.time) - new Date(a.time_iso || a.time));

    const formattedHistory = rawEvents.map(event => ({
      date: event.time_iso || event.time || '', 
      detail: event.description || 'Update received',
      location: event.location || ''
    }));

    return res.json({ status: currentStatus, history: formattedHistory });

  } catch (error) {
    console.error(`🚨 Fatal Error in /api/track:`, error.message);
    return res.status(500).json({ error: 'Internal Error' });
  }
});

// =====================================================================
// 2. AI SYNC 
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
        namespace: "custom", 
        key: "ai_overview", 
        type: "multi_line_text_field", 
        value: ai_overview 
      }] 
    };
    
    let responseData = await shopifyGraphQL(query, variables);
    
    if (responseData.data?.metafieldsSet?.userErrors?.length > 0) {
        console.error("🚨 SHOPIFY REJECTED THE UPDATE:", JSON.stringify(responseData.data.metafieldsSet.userErrors));
        return res.status(400).json({ error: responseData.data.metafieldsSet.userErrors });
    }

    console.log(`✅ Successfully updated AI profile for customer ${customer_id}`);
    res.json({ success: true });
    
  } catch (error) { 
    console.error("🚨 SERVER CRASH:", error.message);
    res.status(500).json({ error: 'Sync Failed', details: error.message }); 
  }
});

// =====================================================================
// SERVER STARTUP
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API active on ${PORT}`));
