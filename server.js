// =====================================================================
// 1. TRACKING (NOW POWERED BY 17TRACK 🚀)
// =====================================================================
app.get('/api/track', async (req, res) => {
  const trackingNumber = String(req.query.number || '').trim();
  const rawCarrier = String(req.query.carrier || '').toLowerCase();

  console.log(`\n🔍 Received 17TRACK tracking request for: ${trackingNumber}`);

  if (trackingNumber === 'KEEP_ALIVE') return res.json({ status: 'AWAKE' });
  if (!trackingNumber) return res.status(400).json({ error: 'Missing tracking number' });

  // 🚀 FIX: Strip out all spaces/dashes so "Royal Mail" or "royal_mail" matches perfectly
  const normalizedCarrier = rawCarrier.replace(/[^a-z0-9]/g, '');

  // 17TRACK uses numeric carrier IDs. 3011 is Royal Mail. 
  let carrierId = null;
  
  // If Shopify says Royal Mail, OR if the tracking number ends in 'GB', force Royal Mail (3011)
  if (normalizedCarrier.includes('royalmail') || trackingNumber.toUpperCase().endsWith('GB')) {
      carrierId = 3011;
  }
  else if (normalizedCarrier.includes('evri') || normalizedCarrier.includes('hermes')) carrierId = 10026; 
  else if (normalizedCarrier.includes('dpd')) carrierId = 10019;
  else if (normalizedCarrier.includes('dhl')) carrierId = 10001;

  try {
    const apiKey = process.env.TRACK17_API_KEY;
    if (!apiKey) throw new Error("Missing TRACK17_API_KEY in environment variables.");

    const headers = {
      '17token': apiKey,
      'Content-Type': 'application/json'
    };

    // STEP 1: Register the tracking number in 17TRACK with the strict Carrier ID
    const registerPayload = [{ number: trackingNumber }];
    if (carrierId) registerPayload[0].carrier = carrierId;

    await fetch('https://api.17track.net/track/v2.4/register', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(registerPayload)
    });

    // STEP 2: Fetch the actual tracking info
    const infoRes = await fetch('https://api.17track.net/track/v2.4/gettrackinfo', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify([{ number: trackingNumber }])
    });

    const infoData = await infoRes.json();
    const trackData = infoData.data?.accepted?.[0]?.track_info;

    // If 17TRACK hasn't found data yet, return pending
    if (!trackData || !trackData.tracking) {
      console.log(`📥 17TRACK Pending/Not Found Response:`, JSON.stringify(infoData));
      return res.json({ status: 'PENDING', history: [] });
    }

    console.log(`✅ 17TRACK Tracker active. Status: ${trackData.latest_status?.status}`);

    // STEP 3: Map 17TRACK status to your Frontend's expected status
    let currentStatus = 'IN_TRANSIT';
    const tmStatus = trackData.latest_status?.status;
    
    if (tmStatus === 'Delivered') currentStatus = 'DELIVERED';
    else if (tmStatus === 'OutForDelivery' || tmStatus === 'AvailableForPickup') currentStatus = 'OUT_FOR_DELIVERY';

    // Map history events so they show up beautifully on your Customer Hub timeline
    const rawEvents = trackData.tracking?.providers?.[0]?.events || [];
    
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
