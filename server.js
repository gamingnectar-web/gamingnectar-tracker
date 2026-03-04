const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = String(req.query.number || '').trim();
  
  // 💓 HEARTBEAT: Keeps Render awake
  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  try {
    const apiKey = process.env.TRACKINGMORE_API_KEY;
    
    if (!apiKey) {
      return res.status(500).json({ error: 'API key missing from Render environment' });
    }

    // 1. Try to GET the tracking data if it already exists
    let getResponse = await fetch(`https://api.trackingmore.com/v4/trackings/get?tracking_numbers=${trackingNumber}`, {
      method: 'GET',
      headers: {
        'Tracking-Api-Key': apiKey,
        'Content-Type': 'application/json'
      }
    });
    
    let data = await getResponse.json();
    
    // 2. If it doesn't exist in your account yet, CREATE it
    if (!data.data || data.data.length === 0) {
        let createResponse = await fetch('https://api.trackingmore.com/v4/trackings/create', {
          method: 'POST',
          headers: {
            'Tracking-Api-Key': apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ tracking_number: trackingNumber, courier_code: "royal-mail" })
        });
        data = await createResponse.json();
    }

    // 3. Extract TrackingMore's status
    let tmStatus = 'pending';
    if (data.data && Array.isArray(data.data) && data.data.length > 0) {
        tmStatus = data.data[0].delivery_status;
    } else if (data.data && data.data.delivery_status) {
        tmStatus = data.data.delivery_status;
    }

    // 4. Map it to your custom Shopify Hub status
    let currentStatus = 'UNKNOWN';
    if (tmStatus === 'delivered') currentStatus = 'DELIVERED';
    else if (tmStatus === 'pickup' || tmStatus === 'outfordelivery') currentStatus = 'OUT_FOR_DELIVERY';
    else if (tmStatus === 'transit') currentStatus = 'WITH_COURIER';
    else if (tmStatus === 'notfound') currentStatus = 'NOT_FOUND';

    // 5. Send it back to Shopify instantly
    return res.json({
      tracking: trackingNumber,
      status: currentStatus,
      raw_status: tmStatus
    });

  } catch (error) {
    return res.status(500).json({ error: 'API Error', details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 TrackingMore API live on port ${PORT}`));
