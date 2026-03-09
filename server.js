const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ==========================================
// 1. SHOPIFY WEBHOOK LISTENER
// ==========================================
app.post('/api/shopify-webhook', async (req, res) => {
  res.status(200).send('Webhook received');
  try {
    const fulfillment = req.body;
    if (!fulfillment.tracking_numbers || fulfillment.tracking_numbers.length === 0) return;
    
    const trackingNumber = fulfillment.tracking_numbers[0];
    const company = String(fulfillment.tracking_company || '').toLowerCase();

    let courierCode = null;
    if (company.includes('royal mail')) courierCode = 'royal-mail';
    else if (company.includes('evri') || company.includes('hermes')) courierCode = 'evri';
    else if (company.includes('dpd')) courierCode = 'dpd-uk';
    else if (company.includes('dhl')) courierCode = 'dhl';

    if (!courierCode) return;

    const apiKey = process.env.TRACKINGMORE_API_KEY;
    await fetch('https://api.trackingmore.com/v4/trackings/create', {
      method: 'POST',
      headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracking_number: trackingNumber, courier_code: courierCode })
    });
    console.log(`✅ Webhook: Registered ${trackingNumber}`);
  } catch (error) {
    console.error('🚨 Webhook error:', error.message);
  }
});

// ==========================================
// 2. RESTORED TRACKING ROUTE (Original Logic)
// ==========================================
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
    
    // Fallback: If not in TrackingMore, create it
    if (!data.data || data.data.length === 0) {
        let createRes = await fetch('https://api.trackingmore.com/v4/trackings/create', {
          method: 'POST',
          headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracking_number: trackingNumber, courier_code: courierCode })
        });
        data = await createRes.json();
    }

    let tmStatus = 'pending';
    let trackHistory = [];
    const item = (data.data && Array.isArray(data.data)) ? data.data[0] : data.data;

    if (item) {
        tmStatus = item.delivery_status || 'pending';
        const originHistory = item.origin_info?.trackinfo || [];
        const destHistory = item.destination_info?.trackinfo || [];
        const rootHistory = item.trackinfo || [];

        if (originHistory.length >= destHistory.length && originHistory.length >= rootHistory.length) trackHistory = originHistory;
        else if (destHistory.length >= originHistory.length && destHistory.length >= rootHistory.length) trackHistory = destHistory;
        else trackHistory = rootHistory;
    }

    const formattedHistory = trackHistory.map(event => ({
      date: event.checkpoint_date || event.Date || '', 
      detail: event.tracking_detail || event.StatusDescription || 'Update received',
      location: event.location || event.Details || ''
    }));

    let currentStatus = 'UNKNOWN';
    if (tmStatus === 'delivered') currentStatus = 'DELIVERED';
    else if (tmStatus === 'pickup' || tmStatus === 'outfordelivery') currentStatus = 'OUT_FOR_DELIVERY';
    else if (tmStatus === 'transit') currentStatus = 'WITH_COURIER';
    else if (tmStatus === 'notfound') currentStatus = 'NOT_FOUND';

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
// 3. AI PROFILE SYNC ROUTE
// ==========================================
app.post('/api/update-ai', async (req, res) => {
  const { customer_id, ai_overview } = req.body;
  const shopifyDomain = process.env.SHOPIFY_DOMAIN; 
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN; 

  const query = `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { id } userErrors { message } }
  }`;

  const variables = {
    metafields: [{ ownerId: `gid://shopify/Customer/${customer_id}`, namespace: "custom", key: "ai_overview", type: "json", value: ai_overview }]
  };

  try {
    const shopifyRes = await fetch(`https://${shopifyDomain}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query, variables })
    });
    const result = await shopifyRes.json();
    res.json({ success: true, details: result });
  } catch (error) {
    res.status(500).json({ error: 'Sync Failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API active on ${PORT}`));
