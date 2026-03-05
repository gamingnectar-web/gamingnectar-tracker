const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = String(req.query.number || '').trim();
  
  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  try {
    const apiKey = process.env.TRACKINGMORE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key missing' });

    let getResponse = await fetch(`https://api.trackingmore.com/v4/trackings/get?tracking_numbers=${trackingNumber}`, {
      method: 'GET',
      headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json' }
    });
    
    let data = await getResponse.json();
    
    if (!data.data || data.data.length === 0) {
        let createResponse = await fetch('https://api.trackingmore.com/v4/trackings/create', {
          method: 'POST',
          headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracking_number: trackingNumber, courier_code: "royal-mail" })
        });
        data = await createResponse.json();
    }

    let tmStatus = 'pending';
    let trackHistory = []; // 📦 NEW: Array to hold the timeline

    if (data.data && Array.isArray(data.data) && data.data.length > 0) {
        tmStatus = data.data[0].delivery_status;
        trackHistory = data.data[0].trackinfo || data.data[0].origin_info?.trackinfo || [];
    } else if (data.data && data.data.delivery_status) {
        tmStatus = data.data.delivery_status;
        trackHistory = data.data.trackinfo || data.data.origin_info?.trackinfo || [];
    }

    // 📦 NEW: Clean up the history data for Shopify
    const formattedHistory = trackHistory.map(event => ({
      date: event.checkpoint_date || '',
      detail: event.tracking_detail || 'Update received',
      location: event.location || ''
    }));

    let currentStatus = 'UNKNOWN';
    if (tmStatus === 'delivered') currentStatus = 'DELIVERED';
    else if (tmStatus === 'pickup' || tmStatus === 'outfordelivery') currentStatus = 'OUT_FOR_DELIVERY';
    else if (tmStatus === 'transit') currentStatus = 'WITH_COURIER';
    else if (tmStatus === 'notfound') currentStatus = 'NOT_FOUND';

    // 📦 NEW: Send the history back to Shopify
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API live on port ${PORT}`));
