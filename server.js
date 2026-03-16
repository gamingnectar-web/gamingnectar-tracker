const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// =====================================================================
// SHOPIFY HELPERS
// =====================================================================
async function getShopifyToken() {
  const { SHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;

  if (!SHOPIFY_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error('Missing Shopify credentials in environment.');
  }

  const response = await fetch(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET
    })
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(`Shopify token generation failed: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

async function shopifyGraphQL(query, variables = {}) {
  const accessToken = await getShopifyToken();

  const response = await fetch(`https://${process.env.SHOPIFY_DOMAIN}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json();

  if (!response.ok || data.errors) {
    throw new Error(JSON.stringify(data.errors || data));
  }

  return data;
}

// =====================================================================
// AFTERSHIP HELPERS
// =====================================================================
function normalizeCarrier(rawCarrier = '') {
  return String(rawCarrier).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getSafeAfterShipSlug(rawCarrier = '') {
  const norm = normalizeCarrier(rawCarrier);

  // Only map carriers you are confident are OK for your account.
  if (norm.includes('evri') || norm.includes('hermes')) return 'evri';
  if (norm.includes('dpd')) return 'dpd-uk';
  if (norm.includes('dhl')) return 'dhl';

  // IMPORTANT:
  // Do NOT auto-map Royal Mail here.
  // Royal Mail is "Nice to connect" in AfterShip docs, so forcing it can fail
  // if your AfterShip account does not have the required courier connection.
  return null;
}

async function callAfterShip(endpoint, method = 'GET', body = null) {
  if (!process.env.AFTERSHIP_API_KEY) {
    throw new Error('Missing AFTERSHIP_API_KEY in environment.');
  }

  const options = {
    method,
    headers: {
      'as-api-key': process.env.AFTERSHIP_API_KEY,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`https://api.aftership.com/tracking/2026-01/${endpoint}`, options);

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`AfterShip returned non-JSON response for ${method} ${endpoint}`);
  }

  if (!res.ok || (data.meta && data.meta.code >= 400)) {
    console.log(`🚨 AfterShip API Error [${method} ${endpoint}]:`, JSON.stringify(data));
  }

  return data;
}

async function detectAfterShipSlug(trackingNumber) {
  const result = await callAfterShip('couriers/detect', 'POST', {
    tracking_number: trackingNumber
  });

  const detected = result?.data?.couriers?.[0]?.slug || null;

  if (detected) {
    console.log(`🔎 Detected courier for ${trackingNumber}: ${detected}`);
  } else {
    console.log(`⚠️ No courier detected for ${trackingNumber}`);
  }

  return detected;
}

async function createAfterShipTracking(trackingNumber, rawCarrier = '') {
  const cleanNumber = String(trackingNumber).trim();

  // Step 1: use only safe manual mappings
  let slug = getSafeAfterShipSlug(rawCarrier);

  // Step 2: if none, ask AfterShip to detect
  if (!slug) {
    slug = await detectAfterShipSlug(cleanNumber);
  }

  const payload = { tracking_number: cleanNumber };

  // Only send slug if we truly have one
  if (slug) {
    payload.slug = slug;
  }

  console.log('📦 AfterShip create payload:', JSON.stringify(payload));

  const result = await callAfterShip('trackings', 'POST', payload);
  const code = result?.meta?.code;

  if (code === 201 || code === 200 || code === 4003) {
    return { ok: true, slug, result };
  }

  return {
    ok: false,
    slug,
    result,
    error: result?.meta?.message || 'AfterShip tracking creation failed'
  };
}

async function fetchAfterShipTracking(trackingNumber, rawCarrier = '') {
  const cleanNumber = String(trackingNumber).trim();

  let slug = getSafeAfterShipSlug(rawCarrier);

  if (!slug) {
    slug = await detectAfterShipSlug(cleanNumber);
  }

  const query = new URLSearchParams({ tracking_numbers: cleanNumber });
  if (slug) query.set('slug', slug);

  const result = await callAfterShip(`trackings?${query.toString()}`, 'GET');
  const track = result?.data?.trackings?.[0] || null;

  return { slug, track, raw: result };
}

function mapTrackingStatus(tag = '') {
  const value = String(tag).toLowerCase();

  if (value === 'delivered') return 'DELIVERED';
  if (value === 'exception' || value === 'failed_attempt') return 'EXCEPTION';
  if (value === 'pending' || value === 'info_received') return 'PENDING';
  if (value === 'expired') return 'EXPIRED';
  if (value === 'available_for_pickup') return 'READY_FOR_PICKUP';

  return 'IN_TRANSIT';
}

function formatTrackingHistory(track) {
  return (track?.checkpoints || [])
    .map((cp) => ({
      date: cp.checkpoint_time || cp.created_at || null,
      detail: cp.message || cp.tag || '',
      location: cp.location || ''
    }))
    .reverse();
}

// =====================================================================
// 1. TRACKING API
// =====================================================================
app.get('/api/track', async (req, res) => {
  const { number, carrier } = req.query;

  if (number === 'KEEP_ALIVE') {
    return res.json({ status: 'AWAKE' });
  }

  if (!number) {
    return res.status(400).json({ error: 'Missing number' });
  }

  try {
    const cleanNumber = String(number).trim();

    const created = await createAfterShipTracking(cleanNumber, carrier);

    if (!created.ok) {
      throw new Error(created.error || 'AfterShip create failed');
    }

    const fetched = await fetchAfterShipTracking(cleanNumber, carrier);
    const track = fetched.track;

    if (!track) {
      return res.json({
        status: 'PENDING',
        history: [],
        slug: fetched.slug || created.slug || null
      });
    }

    return res.json({
      status: mapTrackingStatus(track.tag),
      tag: track.tag || null,
      slug: fetched.slug || created.slug || null,
      tracking_number: track.tracking_number || cleanNumber,
      history: formatTrackingHistory(track)
    });
  } catch (e) {
    console.error('🚨 Hub Error:', e.message);
    return res.status(500).json({ error: 'Tracking unavailable' });
  }
});

// =====================================================================
// 2. SHOPIFY WEBHOOK
// =====================================================================
app.post('/api/webhooks/fulfillment', async (req, res) => {
  res.status(200).send('OK');

  try {
    const { tracking_number, tracking_numbers, tracking_company } = req.body;

    let num = tracking_number || (Array.isArray(tracking_numbers) ? tracking_numbers[0] : null);
    if (!num) return;

    num = String(num).trim();

    const created = await createAfterShipTracking(num, tracking_company);

    if (created.ok) {
      console.log(`✅ Auto-Registered AfterShip: ${num}${created.slug ? ` (${created.slug})` : ' (no slug)'}`);
    } else {
      console.log(`⚠️ AfterShip registration failed for ${num}: ${created.error}`);
    }
  } catch (e) {
    console.error('🚨 Webhook Error:', e.message);
  }
});

// =====================================================================
// 3. AI PROFILE SYNC
// =====================================================================
app.post('/api/update-ai', async (req, res) => {
  const { customer_id, ai_overview } = req.body;

  if (!customer_id) {
    return res.status(400).json({ error: 'Missing ID' });
  }

  try {
    const ownerId = customer_id.includes('gid://')
      ? customer_id
      : `gid://shopify/Customer/${customer_id}`;

    const query = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      metafields: [
        {
          ownerId,
          namespace: 'custom',
          key: 'ai_overview',
          type: 'multi_line_text_field',
          value: ai_overview || ''
        }
      ]
    };

    const result = await shopifyGraphQL(query, variables);
    const userErrors = result?.data?.metafieldsSet?.userErrors || [];

    if (userErrors.length) {
      return res.status(400).json({ error: userErrors });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('🚨 AI Sync Failed:', error.message);
    return res.status(500).json({ error: 'Sync Failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AfterShip Hub active on ${PORT}`);
});
