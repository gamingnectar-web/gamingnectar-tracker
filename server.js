const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/track', async (req, res) => {
  const trackingNumber = String(req.query.number || '').trim();
  
  // 💓 HEARTBEAT: Still here to keep Render awake!
  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  try {
    // We will set this secret key in Render in the next step
    const apiKey = process.env.TRACKINGMORE_API_KEY;

    // 1. Try to GET the tracking data if it already exists in your TrackingMore account
    let getResponse = await fetch(`https://api.trackingmore.com/v4/trackings?tracking_numbers=${trackingNumber}`, {
      method: 'GET',
      headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json' }
    });
    
    let getData = await getResponse.json();
    let trackingData = getData.data && getData.data.length > 0 ? getData.data[0] : null;

    // 2. If it doesn't exist yet, CREATE it (TrackingMore fetches live data upon creation)
    if (!trackingData) {
      let createResponse = await fetch('https://api.trackingmore.com/v4/trackings/create', {
        method: 'POST',
        headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracking_number: trackingNumber, courier_code: "royal-mail" })
      });
      let createData = await createResponse.json();
      
      if (createData.meta.code === 200) {
        trackingData = createData.data;
      } else if (createData.meta.code === 4101) {
        // 4101 means it already exists, fallback to transit
         trackingData = { delivery_status: 'transit' }; 
      } else {
         return res.status(400).json({ error: 'TrackingMore API Error', details: createData.meta.message });
      }
    }

    // 3. Map TrackingMore's official status to your custom Shopify Hub status
    let currentStatus = 'UNKNOWN';
    const tmStatus = trackingData.delivery_status;

    // TrackingMore uses 'pickup' to mean 'Out for Delivery' and 'transit' for 'With Courier'
    if (tmStatus === 'delivered') {
      currentStatus = 'DELIVERED';
    } else if (tmStatus === 'pickup' || tmStatus === 'outfordelivery') {
      currentStatus = 'OUT_FOR_DELIVERY';
    } else if (tmStatus === 'transit') {
      currentStatus = 'WITH_COURIER';
    } else if (tmStatus === 'notfound') {
      currentStatus = 'NOT_FOUND';
    }

    // 4. Send the clean data to your Shopify store instantly
    return res.json({
      tracking: trackingNumber,
      status: currentStatus,
      raw_status: tmStatus // Included for debugging
    });

  } catch (error) {
    console.error("API Error:", error.message);
    return res.status(500).json({ error: 'Failed to communicate with TrackingMore' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 TrackingMore API live on port ${PORT}`));
