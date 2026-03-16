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
// 1. TRACKING (NOW POWERED BY EASYPOST 🚀)
// =====================================================================
app.get('/api/track', async (req, res) => {
  const trackingNumber = String(req.query.number || '').trim();
  const rawCarrier = String(req.query.carrier || '').toLowerCase();

  console.log(`\n🔍 Received EasyPost tracking request for: ${trackingNumber}`);

  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  // Map to EasyPost specific Carrier strings
  let courierCode = 'RoyalMail';
  if (rawCarrier.includes('evri') || rawCarrier.includes('hermes')) courierCode = 'Evri';
  else if (rawCarrier.includes('dpd')) courierCode = 'DPDUK';
  else if (rawCarrier.includes('dhl')) courierCode = 'DHL';

  try {
    const apiKey = process.env.EASYPOST_API_KEY;
    if (!apiKey) throw new Error("Missing EASYPOST_API_KEY in environment variables.");

    // EasyPost uses Basic Auth with the API key as the username
    const authHeader = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
    
    // EasyPost is smart: If this tracker already exists, it returns the existing one 
    // WITHOUT charging your quota again. 
    let createRes = await fetch('https://api.easypost.com/v2/trackers', {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tracker: { tracking_code: trackingNumber, carrier: courierCode }
      })
    });
    
    let trackerData = await createRes.json();
    
    // Fallback: If EasyPost rejects our explicit carrier, try letting it auto-detect
    if (trackerData.error && trackerData.error.message.includes('carrier')) {
        console.log(`🔄 Retrying with EasyPost auto-detect for carrier...`);
        let retryRes = await fetch('https://api.easypost.com/v2/trackers', {
          method: 'POST',
          headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracker: { tracking_code: trackingNumber } })
        });
        trackerData = await retryRes.json();
    }

    if (!trackerData.id) {
        console.log(`📥 EasyPost Error/Pending Response:`, JSON.stringify(trackerData));
        return res.json({ status: 'PENDING', history: [], debug: trackerData });
    }

    console.log(`✅ Tracker active in EasyPost. Status: ${trackerData.status}`);

    // Map EasyPost status to your Frontend's expected status
    let currentStatus = 'IN_TRANSIT';
    if (trackerData.status === 'delivered') currentStatus = 'DELIVERED';
    else if (['out_for_delivery', 'available_for_pickup'].includes(trackerData.status)) currentStatus = 'OUT_FOR_DELIVERY';

    let trackHistory = trackerData.tracking_details || [];

    // Map history to match your frontend timeline and reverse it so newest is first
    const formattedHistory = trackHistory.map(event => {
      let locParts = [];
      if (event.tracking_location?.city) locParts.push(event.tracking_location.city);
      if (event.tracking_location?.state) locParts.push(event.tracking_location.state);
      if (event.tracking_location?.country) locParts.push(event.tracking_location.country);

      return {
        date: event.datetime || '', 
        detail: event.message || event.status || 'Update received',
        location: locParts.join(', ')
      };
    }).reverse();

    return res.json({ status: currentStatus, history: formattedHistory });

  } catch (error) {
    console.error(`🚨 Fatal Error in /api/track:`, error.message);
    return res.status(500).json({ error: 'Internal Error' });
  }
});

// 2. AI SYNC 
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
// 📦 COMMENTED OUT: SUPPLY CHAIN, INVENTORY LOGIC & WEBHOOKS
// =====================================================================

/*
async function updateProductStatus(productId, newTag) { ... }
async function generateDiscountCode(poNumber) { ... }

// 3. SUPPLY BACKEND WEBHOOK
app.post('/api/webhooks/supply-update', async (req, res) => { ... });

// 4. DELIVERY WEBHOOK (Previously TrackingMore)
app.post('/api/webhooks/trackingmore-update', async (req, res) => { ... });

const processedPOs = new Set();
async function pollShopifyPOs() { ... }
// setInterval(pollShopifyPOs, 15 * 60 * 1000);
// setTimeout(pollShopifyPOs, 5000);
*/

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API active on ${PORT}`));
