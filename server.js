const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json()); // Allows Render to parse Shopify's JSON webhooks

// ==========================================
// 1. SHOPIFY WEBHOOK LISTENER (Triggered on Fulfillment)
// ==========================================
app.post('/api/shopify-webhook', async (req, res) => {
  // Always reply to Shopify immediately so they know we got it
  res.status(200).send('Webhook received');

  try {
    const fulfillment = req.body;
    
    // Check if there is actually a tracking number attached
    if (!fulfillment.tracking_numbers || fulfillment.tracking_numbers.length === 0) {
      return console.log("Webhook ignored: No tracking numbers found.");
    }
    
    const trackingNumber = fulfillment.tracking_numbers[0];
    const company = String(fulfillment.tracking_company || '').toLowerCase();

    // Map the Shopify courier name to TrackingMore's official courier code
    let courierCode = null;
    if (company.includes('royal mail')) courierCode = 'royal-mail';
    else if (company.includes('evri') || company.includes('hermes')) courierCode = 'evri';
    else if (company.includes('dpd')) courierCode = 'dpd-uk';
    else if (company.includes('dhl')) courierCode = 'dhl';

    if (!courierCode) {
      return console.log(`Webhook ignored: Courier '${company}' not currently mapped.`);
    }

    const apiKey = process.env.TRACKINGMORE_API_KEY;
    if (!apiKey) return console.error("Webhook failed: Missing API Key");

    // Register the shipment with TrackingMore instantly
    let createResponse = await fetch('https://api.trackingmore.com/v4/trackings/create', {
      method: 'POST',
      headers: {
        'Tracking-Api-Key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ tracking_number: trackingNumber, courier_code: courierCode })
    });

    let createData = await createResponse.json();
    console.log(`✅ Webhook Success: Registered ${trackingNumber} (${courierCode}) with TrackingMore!`);

  } catch (error) {
    console.error('🚨 Webhook processing error:', error.message);
  }
});

// ==========================================
// 2. CUSTOMER HUB TRACKING ROUTE (Triggered by Customer)
// ==========================================
app.get('/api/track', async (req, res) => {
  const trackingNumber = String(req.query.number || '').trim();
  const rawCarrier = String(req.query.carrier || '').toLowerCase(); // Read the carrier from Shopify
  
  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  // Map the Shopify carrier to TrackingMore's format for the frontend API check
  let courierCode = 'royal-mail'; // Default fallback
  if (rawCarrier.includes('evri') || rawCarrier.includes('hermes')) courierCode = 'evri';
  else if (rawCarrier.includes('dpd')) courierCode = 'dpd-uk';
  else if (rawCarrier.includes('dhl')) courierCode = 'dhl';

  try {
    const apiKey = process.env.TRACKINGMORE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key missing from Render environment' });

    // Try to GET the tracking data
    let getResponse = await fetch(`https://api.trackingmore.com/v4/trackings/get?tracking_numbers=${trackingNumber}`, {
      method: 'GET',
      headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json' }
    });
    
    let data = await getResponse.json();
    
    // If it doesn't exist (e.g. webhook failed or missed), CREATE it as a fallback dynamically
    if (!data.data || data.data.length === 0) {
        let createResponse = await fetch('https://api.trackingmore.com/v4/trackings/create', {
          method: 'POST',
          headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracking_number: trackingNumber, courier_code: courierCode })
        });
        data = await createResponse.json();
    }

    // Extract Status AND Smart History Timeline
    let tmStatus = 'pending';
    let trackHistory = [];

    const item = (data.data && Array.isArray(data.data)) ? data.data[0] : data.data;

    if (item) {
        tmStatus = item.delivery_status || 'pending';
        
        // TrackingMore splits data. We grab all possible arrays and keep the longest one!
        const originHistory = item.origin_info?.trackinfo || [];
        const destHistory = item.destination_info?.trackinfo || [];
        const rootHistory = item.trackinfo || [];

        if (originHistory.length >= destHistory.length && originHistory.length >= rootHistory.length) {
            trackHistory = originHistory;
        } else if (destHistory.length >= originHistory.length && destHistory.length >= rootHistory.length) {
            trackHistory = destHistory;
        } else {
            trackHistory = rootHistory;
        }
    }

    // Clean up the history array for Shopify
    const formattedHistory = trackHistory.map(event => ({
      date: event.checkpoint_date || event.Date || '', 
      detail: event.tracking_detail || event.StatusDescription || 'Update received',
      location: event.location || event.Details || ''
    }));

    // Map to your custom Hub status
    let currentStatus = 'UNKNOWN';
    if (tmStatus === 'delivered') currentStatus = 'DELIVERED';
    else if (tmStatus === 'pickup' || tmStatus === 'outfordelivery') currentStatus = 'OUT_FOR_DELIVERY';
    else if (tmStatus === 'transit') currentStatus = 'WITH_COURIER';
    else if (tmStatus === 'notfound') currentStatus = 'NOT_FOUND';

    // Send it all back to the Shopify frontend
    return res.json({
      tracking: trackingNumber,
      status: currentStatus,
      raw_status: tmStatus,
      history: formattedHistory
    });

  } catch (error) {
    return res.status(500).json({ error: 'API Error', details: error.message });
  }
});


// ==========================================
// 3. 🚀 AI PROFILE SYNC ROUTE (Triggered by Customer Hub)
// ==========================================
app.post('/api/update-ai', async (req, res) => {
  const { customer_id, ai_overview } = req.body;

  if (!customer_id || !ai_overview) {
    return res.status(400).json({ error: 'Missing customer_id or ai_overview' });
  }

  // Pull credentials from your Render Environment Variables
  const shopifyDomain = process.env.SHOPIFY_DOMAIN; 
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN; 

  if (!shopifyDomain || !accessToken) {
    return res.status(500).json({ error: 'Shopify credentials missing from Render environment' });
  }

  // Shopify GraphQL Mutation to cleanly overwrite/create the metafield
  const query = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: `gid://shopify/Customer/${customer_id}`,
        namespace: "custom",
        key: "ai_overview",
        type: "json",
        value: ai_overview // This receives the stringified JSON from your storefront
      }
    ]
  };

  try {
    const shopifyRes = await fetch(`https://${shopifyDomain}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({ query, variables })
    });

    const data = await shopifyRes.json();
    
    // Catch any Shopify-specific data errors
    if (data.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error('🚨 Shopify Metafield Errors:', data.data.metafieldsSet.userErrors);
      return res.status(400).json({ error: data.data.metafieldsSet.userErrors });
    }

    console.log(`✅ AI Profile successfully synced to Shopify for Customer ${customer_id}!`);
    res.json({ success: true, message: "AI Profile successfully synced to Shopify!" });

  } catch (error) {
    console.error('🚨 Server error updating metafield:', error.message);
    res.status(500).json({ error: 'Failed to sync with Shopify' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API live on port ${PORT}`));
