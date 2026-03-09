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

  // Exchanges the Client ID and Secret for a temporary 24-hour access token
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

// 1. TRACKING (Restored to exact previous working logic)
app.get('/api/track', async (req, res) => {
  const trackingNumber = String(req.query.number || '').trim();
  const rawCarrier = String(req.query.carrier || '').toLowerCase();
  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  let courierCode = 'royal-mail';
  if (rawCarrier.includes('evri') || rawCarrier.includes('hermes')) courierCode = 'evri';
  else if (rawCarrier.includes('dpd')) courierCode = 'dpd-uk';
  else if (rawCarrier.includes('dhl')) courierCode = 'dhl';

  try {
    const apiKey = process.env.TRACKINGMORE_API_KEY;
    let getResponse = await fetch(`https://api.trackingmore.com/v4/trackings/get?tracking_numbers=${trackingNumber}`, {
      method: 'GET',
      headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json' }
    });
    
    let data = await getResponse.json();
    
    if (!data.data || data.data.length === 0) {
        await fetch('https://api.trackingmore.com/v4/trackings/create', {
          method: 'POST',
          headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracking_number: trackingNumber, courier_code: courierCode })
        });
        return res.json({ status: 'PENDING', history: [] });
    }

    let tmStatus = data.data[0].delivery_status || 'pending';
    let trackHistory = data.data[0].origin_info?.trackinfo || data.data[0].trackinfo || [];

    // Map to frontend labels
    let currentStatus = 'IN_TRANSIT';
    if (tmStatus === 'delivered') currentStatus = 'DELIVERED';
    else if (['pickup', 'outfordelivery'].includes(tmStatus)) currentStatus = 'OUT_FOR_DELIVERY';

    return res.json({
      status: currentStatus,
      history: trackHistory.map(event => ({
        date: event.checkpoint_date || event.Date || '', 
        detail: event.tracking_detail || event.StatusDescription || 'Update received',
        location: event.location || event.Details || ''
      }))
    });
  } catch (error) {
    return res.status(500).json({ error: 'Internal Error' });
  }
});

// 2. AI SYNC (Shopify 2026 OAuth Compatible)
app.post('/api/update-ai', async (req, res) => {
  const { customer_id, ai_overview } = req.body;
  const shopifyDomain = process.env.SHOPIFY_DOMAIN; 
  
  try {
    // 1. Fetch the temporary 24-hour key dynamically!
    const accessToken = await getShopifyToken();

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
    
    let shopifyRes = await fetch(`https://${shopifyDomain}/admin/api/2024-01/graphql.json`, {
      method: 'POST', 
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query, variables })
    });
    
    let responseData = await shopifyRes.json();
    
    // 🚀 CRITICAL: Catch silent Shopify rejections
    if (responseData.data?.metafieldsSet?.userErrors?.length > 0) {
        console.error("🚨 SHOPIFY REJECTED THE UPDATE:", JSON.stringify(responseData.data.metafieldsSet.userErrors));
        return res.status(400).json({ error: responseData.data.metafieldsSet.userErrors });
    }

    if (responseData.errors) {
        console.error("🚨 GRAPHQL SYNTAX ERROR:", JSON.stringify(responseData.errors));
        return res.status(400).json({ error: responseData.errors });
    }

    console.log(`✅ Successfully updated AI profile for customer ${customer_id}`);
    res.json({ success: true });
    
  } catch (error) { 
    console.error("🚨 SERVER CRASH:", error.message);
    res.status(500).json({ error: 'Sync Failed', details: error.message }); 
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API active on ${PORT}`));
