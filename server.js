const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// 1. UNIFIED TRACKING ROUTE
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
    
    let getResponse = await fetch(`https://gamingnectar-tracker.onrender.com/api/track?number=${trackingNumber}&carrier=${courierCode}`, {
        headers: { 'Tracking-Api-Key': apiKey }
    });
    
    // Direct TrackingMore fetch
    let tmResponse = await fetch(`https://api.trackingmore.com/v4/trackings/get?tracking_numbers=${trackingNumber}`, {
      method: 'GET',
      headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json' }
    });
    
    let data = await tmResponse.json();
    
    if (!data.data || data.data.length === 0) {
        await fetch('https://api.trackingmore.com/v4/trackings/create', {
          method: 'POST',
          headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracking_number: trackingNumber, courier_code: courierCode })
        });
        return res.json({ status: 'PENDING', history: [] });
    }

    const item = data.data[0];
    const rawHistory = item.origin_info?.trackinfo || item.trackinfo || [];
    
    // Map internal status to Hub labels
    let hubStatus = 'IN_TRANSIT';
    if (item.delivery_status === 'delivered') hubStatus = 'DELIVERED';
    else if (['pickup', 'outfordelivery'].includes(item.delivery_status)) hubStatus = 'OUT_FOR_DELIVERY';

    const history = rawHistory.map(event => ({
      date: event.checkpoint_date || event.Date || '', 
      detail: event.tracking_detail || event.StatusDescription || 'Update received',
      location: event.location || event.Details || ''
    }));

    return res.json({ status: hubStatus, history: history });

  } catch (error) {
    return res.status(500).json({ error: 'Sync Error' });
  }
});

// 2. AI PROFILE SYNC
app.post('/api/update-ai', async (req, res) => {
  const { customer_id, ai_overview } = req.body;
  const query = `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { id } userErrors { message } }
  }`;
  const variables = {
    metafields: [{ ownerId: `gid://shopify/Customer/${customer_id}`, namespace: "custom", key: "ai_overview", type: "json", value: ai_overview }]
  };
  try {
    await fetch(`https://${process.env.SHOPIFY_DOMAIN}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN },
      body: JSON.stringify({ query, variables })
    });
    res.json({ success: true });
  } catch (e) { res.status(500).send("Fail"); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
