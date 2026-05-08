const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

// =====================================================================
// OPTIONAL SHOPIFY HELPERS
// =====================================================================

function getShopifyDomain() {
  const domain = process.env.SHOPIFY_DOMAIN;

  if (!domain) {
    throw new Error('Missing SHOPIFY_DOMAIN in environment.');
  }

  return domain
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
}

async function getShopifyToken() {
  // Prefer a permanent Admin API token if you have one.
  // Useful env names:
  // SHOPIFY_ADMIN_API_ACCESS_TOKEN
  // SHOPIFY_ACCESS_TOKEN
  if (process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
    return process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
  }

  if (process.env.SHOPIFY_ACCESS_TOKEN) {
    return process.env.SHOPIFY_ACCESS_TOKEN;
  }

  const {
    SHOPIFY_DOMAIN,
    SHOPIFY_CLIENT_ID,
    SHOPIFY_CLIENT_SECRET
  } = process.env;

  if (!SHOPIFY_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error('Missing Shopify credentials in environment.');
  }

  const response = await fetch(`https://${getShopifyDomain()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET
    })
  });

  const data = await response.json();

  if (data.access_token) {
    return data.access_token;
  }

  throw new Error(`Shopify token generation failed: ${JSON.stringify(data)}`);
}

async function shopifyGraphQL(query, variables = {}) {
  const accessToken = await getShopifyToken();
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2026-04';

  const response = await fetch(
    `https://${getShopifyDomain()}/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const data = await response.json();

  if (data.errors) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data;
}

// =====================================================================
// TRACK123 HELPERS
// =====================================================================

async function callTrack123ShopifyOrder(orderId) {
  const {
    TRACK123_STORE_UUID,
    TRACK123_API_KEY
  } = process.env;

  if (!TRACK123_STORE_UUID || !TRACK123_API_KEY) {
    throw new Error('Missing Track123 credentials in environment.');
  }

  const endpoint = `https://shp.track123.com/shopify/api/v1/${TRACK123_STORE_UUID}/orders/${orderId}.json`;

  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'X-Api-Key': TRACK123_API_KEY,
      Accept: 'application/json'
    }
  });

  const text = await res.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Track123 returned non-JSON response: ${text}`);
  }

  if (!res.ok) {
    throw new Error(`Track123 Shopify API failed [${res.status}]: ${JSON.stringify(data)}`);
  }

  return data;
}

async function callTrack123Tracking(endpoint, body) {
  const { TRACK123_API_KEY } = process.env;

  if (!TRACK123_API_KEY) {
    throw new Error('Missing Track123 API key in environment.');
  }

  const res = await fetch(`https://api.track123.com${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Track123-Api-Key': TRACK123_API_KEY,
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Track123 returned non-JSON response: ${text}`);
  }

  if (!res.ok) {
    throw new Error(`Track123 Tracking API failed [${res.status}]: ${JSON.stringify(data)}`);
  }

  return data;
}

// =====================================================================
// GENERAL HELPERS
// =====================================================================

function isDeliveredText(value) {
  return String(value || '').toLowerCase().includes('delivered');
}

function normalizeTrackingNumber(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

function normalizeTrack123OrderResponse(raw, requestedTrackingNum = '') {
  const order = raw?.order || raw || {};
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];

  let fulfillment = fulfillments[0] || null;

  // If a specific tracking number was requested, find that fulfillment.
  if (requestedTrackingNum) {
    const safeReqNum = normalizeTrackingNumber(requestedTrackingNum);

    const match = fulfillments.find((f) => {
      const tn = normalizeTrackingNumber(f.tracking_number);
      return tn === safeReqNum;
    });

    if (match) {
      fulfillment = match;
    }
  }

  if (!fulfillment) {
    return {
      found: false,
      status: 'UNAVAILABLE',
      history: [],
      order: {
        order_id: order.order_id || order.id || null,
        order_name: order.order_name || order.name || null
      },
      fulfillment: null
    };
  }

  const trackingDetails = Array.isArray(fulfillment.tracking_details)
    ? fulfillment.tracking_details
    : [];

  const transitStatus = String(
    fulfillment.transit_status ||
    fulfillment.status ||
    ''
  ).toLowerCase();

  let status = 'IN_TRANSIT';

  if (transitStatus.includes('delivered')) {
    status = 'DELIVERED';
  } else if (transitStatus.includes('exception')) {
    status = 'ISSUE';
  } else if (transitStatus.includes('pending')) {
    status = 'PENDING';
  } else if (transitStatus.includes('info')) {
    status = 'PENDING';
  }

  return {
    found: true,
    status,
    history: trackingDetails.map((item) => ({
      date: item.event_time || item.event_time_utc || '',
      detail: item.event_detail || item.status || '',
      location: item.event_location || ''
    })),
    order: {
      order_id: order.order_id || order.id || null,
      order_name: order.order_name || order.name || null,
      order_status: order.status || ''
    },
    fulfillment: {
      id: fulfillment.id || null,
      tracking_number: fulfillment.tracking_number || '',
      tracking_company: fulfillment.tracking_company || fulfillment.courier?.name || '',
      carrier_code: fulfillment.carrier_code || '',
      transit_status: fulfillment.transit_status || '',
      transit_sub_status: fulfillment.transit_sub_status || '',
      last_event: fulfillment.last_event || '',
      last_event_time: fulfillment.last_event_time || '',
      tracking_link: fulfillment.courier?.query_link || order.tracking_link || ''
    }
  };
}

function buildPublicTrackingUrl(carrier, trackingNumber, fallbackUrl = '') {
  const c = String(carrier || '').toLowerCase();
  const n = String(trackingNumber || '').trim();

  if (!n) {
    return fallbackUrl || '';
  }

  if (c.includes('royal mail')) {
    return `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(n)}`;
  }

  if (c.includes('evri') || c.includes('hermes')) {
    return `https://www.evri.com/track-a-parcel/tracking-details?trackingId=${encodeURIComponent(n)}`;
  }

  return fallbackUrl || '';
}

// =====================================================================
// DELIVERED ORDER TAG HELPERS
// =====================================================================

const DELIVERED_ORDER_TAG = process.env.DELIVERED_ORDER_TAG || 'delivered';

// Default is conservative.
// false = only tag order if every known tracked fulfillment is delivered.
// true = tag order when the requested/current fulfillment is delivered.
const TAG_ORDER_ON_PARTIAL_DELIVERY =
  String(process.env.TAG_ORDER_ON_PARTIAL_DELIVERY || '').toLowerCase() === 'true';

function toShopifyOrderGid(orderId) {
  const value = String(orderId || '').trim();

  if (!value) {
    return null;
  }

  if (value.startsWith('gid://shopify/Order/')) {
    return value;
  }

  // Only convert numeric Shopify order IDs.
  // Do not convert order names like "#1021" directly into GIDs.
  if (/^\d+$/.test(value)) {
    return `gid://shopify/Order/${value}`;
  }

  return null;
}

function extractOrderInfo(raw, normalized = {}) {
  const order = raw?.order || raw || {};

  return {
    orderId:
      normalized?.order?.order_id ||
      order.order_id ||
      order.id ||
      null,
    orderName:
      normalized?.order?.order_name ||
      order.order_name ||
      order.name ||
      null
  };
}

async function findShopifyOrderGidByName(orderName) {
  const rawName = String(orderName || '').trim();

  if (!rawName) {
    return null;
  }

  const nameWithHash = rawName.startsWith('#') ? rawName : `#${rawName}`;
  const nameWithoutHash = rawName.replace(/^#/, '');

  const query = `
    query FindOrderByName($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `;

  const attempts = [
    `name:${nameWithHash}`,
    `name:${nameWithoutHash}`
  ];

  for (const searchQuery of attempts) {
    const result = await shopifyGraphQL(query, {
      query: searchQuery
    });

    const order = result.data?.orders?.edges?.[0]?.node;

    if (order?.id) {
      return order.id;
    }
  }

  return null;
}

async function resolveShopifyOrderGid(orderId, orderName) {
  const directGid = toShopifyOrderGid(orderId);

  if (directGid) {
    return directGid;
  }

  return findShopifyOrderGidByName(orderName);
}

function fulfillmentLooksDelivered(fulfillment) {
  if (!fulfillment) {
    return false;
  }

  return (
    isDeliveredText(fulfillment.transit_status) ||
    isDeliveredText(fulfillment.transit_sub_status) ||
    isDeliveredText(fulfillment.last_event) ||
    isDeliveredText(fulfillment.status)
  );
}

function allKnownFulfillmentsDelivered(raw, normalized) {
  const order = raw?.order || raw || {};
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];

  if (TAG_ORDER_ON_PARTIAL_DELIVERY) {
    return normalized?.status === 'DELIVERED';
  }

  const trackableFulfillments = fulfillments.filter((fulfillment) => (
    fulfillment.tracking_number ||
    fulfillment.transit_status ||
    fulfillment.transit_sub_status ||
    fulfillment.last_event
  ));

  // If Track123 did not return fulfillment-level detail,
  // fall back to the selected normalized fulfillment status.
  if (trackableFulfillments.length === 0) {
    return normalized?.status === 'DELIVERED';
  }

  return trackableFulfillments.every(fulfillmentLooksDelivered);
}

async function addDeliveredTagToShopifyOrder(orderId, orderName) {
  const shopifyOrderGid = await resolveShopifyOrderGid(orderId, orderName);

  if (!shopifyOrderGid) {
    return {
      success: false,
      skipped: true,
      reason: 'missing_or_invalid_shopify_order_id',
      orderId: orderId || null,
      orderName: orderName || null
    };
  }

  const mutation = `
    mutation AddDeliveredTag($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyGraphQL(mutation, {
    id: shopifyOrderGid,
    tags: [DELIVERED_ORDER_TAG]
  });

  const userErrors = result.data?.tagsAdd?.userErrors || [];

  if (userErrors.length > 0) {
    throw new Error(
      `Shopify tagsAdd failed: ${userErrors.map((error) => error.message).join(', ')}`
    );
  }

  return {
    success: true,
    skipped: false,
    orderId: shopifyOrderGid,
    tag: DELIVERED_ORDER_TAG
  };
}

async function maybeTagDeliveredOrder(raw, normalized) {
  if (!normalized?.found) {
    return {
      success: false,
      skipped: true,
      reason: 'tracking_not_found'
    };
  }

  if (!allKnownFulfillmentsDelivered(raw, normalized)) {
    return {
      success: false,
      skipped: true,
      reason: TAG_ORDER_ON_PARTIAL_DELIVERY
        ? 'selected_fulfillment_not_delivered'
        : 'order_not_fully_delivered'
    };
  }

  const { orderId, orderName } = extractOrderInfo(raw, normalized);

  return addDeliveredTagToShopifyOrder(orderId, orderName);
}

async function safelyTagDeliveredOrder(raw, normalized) {
  try {
    return await maybeTagDeliveredOrder(raw, normalized);
  } catch (error) {
    console.error('Delivered order tag update failed:', error.message);

    return {
      success: false,
      skipped: false,
      reason: 'shopify_tag_update_failed',
      message: error.message
    };
  }
}

// =====================================================================
// 1. ORDER-BASED TRACKING API
// =====================================================================

app.get('/api/order-tracking', async (req, res) => {
  const { order_id, tracking_num } = req.query;

  if (order_id === 'KEEP_ALIVE') {
    return res.json({ status: 'AWAKE' });
  }

  if (!order_id) {
    return res.status(400).json({ error: 'Missing order_id' });
  }

  try {
    const raw = await callTrack123ShopifyOrder(String(order_id).trim());
    const normalized = normalizeTrack123OrderResponse(raw, tracking_num);

    if (normalized.fulfillment) {
      normalized.fulfillment.tracking_link = buildPublicTrackingUrl(
        normalized.fulfillment.tracking_company,
        normalized.fulfillment.tracking_number,
        normalized.fulfillment.tracking_link
      );
    }

    normalized.shopify_tag_update = await safelyTagDeliveredOrder(raw, normalized);

    return res.json(normalized);
  } catch (error) {
    console.error('Order Tracking Error:', error.message);

    return res.status(500).json({
      error: 'Order tracking unavailable',
      message: error.message
    });
  }
});

// =====================================================================
// 2. LEGACY TRACKING ROUTE
// =====================================================================

app.get('/api/track', async (req, res) => {
  const { number, order_id, carrier } = req.query;

  if (number === 'KEEP_ALIVE' || order_id === 'KEEP_ALIVE') {
    return res.json({ status: 'AWAKE' });
  }

  // Order ID mode.
  // This mode can update Shopify because we can resolve the Shopify order.
  if (order_id) {
    try {
      const raw = await callTrack123ShopifyOrder(String(order_id).trim());
      const normalized = normalizeTrack123OrderResponse(raw, number);

      if (normalized.fulfillment) {
        normalized.fulfillment.tracking_link = buildPublicTrackingUrl(
          normalized.fulfillment.tracking_company,
          normalized.fulfillment.tracking_number,
          normalized.fulfillment.tracking_link
        );
      }

      normalized.shopify_tag_update = await safelyTagDeliveredOrder(raw, normalized);

      return res.json(normalized);
    } catch (error) {
      console.error('/api/track order_id mode failed:', error.message);
    }
  }

  if (!number) {
    return res.status(400).json({ error: 'Missing number or order_id' });
  }

  // Tracking-number-only mode.
  // This cannot reliably tag a Shopify order because Track123 may not return
  // the Shopify order ID from this endpoint.
  try {
    const cleanNumber = String(number).trim();

    const queryResult = await callTrack123Tracking('/gateway/open-api/tk/v2/track/query', {
      trackings: [
        {
          tracking_number: cleanNumber,
          carrier_code: carrier || undefined
        }
      ]
    });

    const item =
      queryResult?.data?.trackings?.[0] ||
      queryResult?.data?.items?.[0] ||
      queryResult?.trackings?.[0] ||
      null;

    if (!item) {
      return res.json({
        found: false,
        status: 'PENDING',
        history: [],
        shopify_tag_update: {
          success: false,
          skipped: true,
          reason: 'tracking_number_only_no_shopify_order_id'
        },
        fulfillment: {
          tracking_number: cleanNumber,
          tracking_company: carrier || '',
          carrier_code: carrier || '',
          transit_status: 'Pending',
          transit_sub_status: '',
          last_event: '',
          last_event_time: '',
          tracking_link: buildPublicTrackingUrl(carrier || '', cleanNumber, '')
        }
      });
    }

    const history = Array.isArray(item.tracking_details)
      ? item.tracking_details.map((event) => ({
          date: event.event_time || event.event_time_utc || '',
          detail: event.event_detail || event.status || '',
          location: event.event_location || ''
        }))
      : [];

    const transitStatus = String(item.transit_status || item.status || '').toLowerCase();

    let status = 'IN_TRANSIT';

    if (transitStatus.includes('delivered')) {
      status = 'DELIVERED';
    } else if (transitStatus.includes('exception')) {
      status = 'ISSUE';
    } else if (transitStatus.includes('pending')) {
      status = 'PENDING';
    }

    return res.json({
      found: true,
      status,
      history,
      shopify_tag_update: {
        success: false,
        skipped: true,
        reason: 'tracking_number_only_no_shopify_order_id'
      },
      fulfillment: {
        tracking_number: item.tracking_number || cleanNumber,
        tracking_company: item.courier_name || item.tracking_company || carrier || '',
        carrier_code: item.carrier_code || carrier || '',
        transit_status: item.transit_status || item.status || '',
        transit_sub_status: item.transit_sub_status || '',
        last_event: item.last_event || '',
        last_event_time: item.last_event_time || '',
        tracking_link: buildPublicTrackingUrl(
          item.courier_name || item.tracking_company || carrier || '',
          item.tracking_number || cleanNumber,
          item.query_link || ''
        )
      }
    });
  } catch (error) {
    console.error('Tracking Error:', error.message);

    return res.status(500).json({
      error: 'Tracking unavailable',
      message: error.message
    });
  }
});

// =====================================================================
// 3. SHOPIFY FULFILLMENT WEBHOOK
// =====================================================================

app.post('/api/webhooks/fulfillment', async (req, res) => {
  res.status(200).send('OK');

  try {
    const {
      tracking_number,
      tracking_numbers,
      tracking_company
    } = req.body;

    const num =
      tracking_number ||
      (Array.isArray(tracking_numbers) ? tracking_numbers[0] : null);

    if (!num) {
      return;
    }

    console.log(`Fulfillment webhook received: ${num} (${tracking_company || 'carrier unknown'})`);
  } catch (error) {
    console.error('Fulfillment Webhook Error:', error.message);
  }
});

// =====================================================================
// 4. TRACK123 WEBHOOK
// Optional automatic delivered tagging.
// Configure this webhook URL in Track123 if available:
// https://YOUR-SERVER-DOMAIN/api/webhooks/track123
// =====================================================================

app.post('/api/webhooks/track123', async (req, res) => {
  res.status(200).send('OK');

  try {
    const payload = req.body || {};

    const transitStatus =
      payload.transitStatus ||
      payload.transit_status ||
      payload.status ||
      payload.deliveryStatus ||
      payload.delivery_status ||
      '';

    if (!isDeliveredText(transitStatus)) {
      return;
    }

    const orderId =
      payload.orderId ||
      payload.order_id ||
      payload.shopifyOrderId ||
      payload.shopify_order_id ||
      null;

    const orderName =
      payload.orderName ||
      payload.order_name ||
      payload.name ||
      null;

    const update = await addDeliveredTagToShopifyOrder(orderId, orderName);

    console.log('Track123 delivered webhook tag update:', update);
  } catch (error) {
    console.error('Track123 Webhook Error:', error.message);
  }
});

// =====================================================================
// 5. AI PROFILE SYNC
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
          metafields {
            id
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
          ownerId,
          namespace: 'custom',
          key: 'ai_overview',
          type: 'multi_line_text_field',
          value: ai_overview || ''
        }
      ]
    };

    await shopifyGraphQL(query, variables);

    return res.json({ success: true });
  } catch (error) {
    console.error('AI Sync Failed:', error.message);

    return res.status(500).json({ error: 'Sync Failed' });
  }
});

// =====================================================================
// 6. WISHLIST API
// =====================================================================

app.get('/api/get-wishlist', async (req, res) => {
  const { customerId } = req.query;

  if (!customerId) {
    return res.status(400).json({ error: 'Missing customerId' });
  }

  try {
    const ownerId = customerId.includes('gid://')
      ? customerId
      : `gid://shopify/Customer/${customerId}`;

    const query = `
      query getCustomerWishlist($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "custom", key: "wishlist") {
            value
          }
        }
      }
    `;

    const result = await shopifyGraphQL(query, { id: ownerId });
    const rawValue = result.data?.customer?.metafield?.value;
    const wishlist = rawValue ? JSON.parse(rawValue) : [];

    return res.json({ wishlist });
  } catch (error) {
    console.error('Get Wishlist Failed:', error.message);

    return res.status(500).json({ error: 'Failed to fetch wishlist' });
  }
});

app.post('/api/wishlist-toggle', async (req, res) => {
  const { customerId, productHandle } = req.body;

  if (!customerId || !productHandle) {
    return res.status(400).json({ error: 'Missing data' });
  }

  try {
    const ownerId = customerId.includes('gid://')
      ? customerId
      : `gid://shopify/Customer/${customerId}`;

    const getQuery = `
      query getWish($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "custom", key: "wishlist") {
            value
          }
        }
      }
    `;

    const currentRes = await shopifyGraphQL(getQuery, { id: ownerId });
    const rawValue = currentRes.data?.customer?.metafield?.value;

    let wishlist = rawValue ? JSON.parse(rawValue) : [];
    let action;

    if (wishlist.includes(productHandle)) {
      wishlist = wishlist.filter((handle) => handle !== productHandle);
      action = 'removed';
    } else {
      wishlist.push(productHandle);
      action = 'added';
    }

    const setQuery = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            value
          }
          userErrors {
            message
          }
        }
      }
    `;

    const variables = {
      metafields: [
        {
          ownerId,
          namespace: 'custom',
          key: 'wishlist',
          type: 'json',
          value: JSON.stringify(wishlist)
        }
      ]
    };

    const result = await shopifyGraphQL(setQuery, variables);
    const userErrors = result.data?.metafieldsSet?.userErrors || [];

    if (userErrors.length > 0) {
      throw new Error(userErrors[0].message);
    }

    return res.json({
      success: true,
      action,
      wishlist
    });
  } catch (error) {
    console.error('Wishlist Toggle Failed:', error.message);

    return res.status(500).json({ error: 'Toggle failed' });
  }
});

// =====================================================================
// 7. RESTOCK ALERTS API
// =====================================================================

app.post('/api/restock-alert', async (req, res) => {
  const {
    email,
    tags,
    action = 'add',
    metafieldString
  } = req.body;

  if (!email || !tags || !Array.isArray(tags)) {
    return res.status(400).json({ error: 'Missing email or tags array' });
  }

  try {
    const searchRes = await shopifyGraphQL(
      `
        query customerSearch($query: String!) {
          customers(first: 1, query: $query) {
            edges {
              node {
                id
                tags
              }
            }
          }
        }
      `,
      {
        query: `email:${email}`
      }
    );

    const existingCustomer = searchRes.data?.customers?.edges?.[0]?.node;

    const metafieldsPayload = [];

    if (metafieldString && action === 'add') {
      metafieldsPayload.push({
        namespace: 'custom',
        key: 'notification_latest',
        value: metafieldString,
        type: 'single_line_text_field'
      });
    }

    if (existingCustomer) {
      const currentTags = existingCustomer.tags || [];

      let newTags;

      if (action === 'remove') {
        newTags = currentTags.filter((tag) => !tags.includes(tag));
      } else {
        newTags = Array.from(new Set([...currentTags, ...tags]));
      }

      const updatePayload = {
        id: existingCustomer.id,
        tags: newTags
      };

      if (metafieldsPayload.length > 0) {
        updatePayload.metafields = metafieldsPayload;
      }

      const updateRes = await shopifyGraphQL(
        `
          mutation customerUpdate($input: CustomerInput!) {
            customerUpdate(input: $input) {
              userErrors {
                message
              }
            }
          }
        `,
        {
          input: updatePayload
        }
      );

      const userErrors = updateRes.data?.customerUpdate?.userErrors || [];

      if (userErrors.length > 0) {
        throw new Error(userErrors[0].message);
      }
    } else if (action === 'add') {
      const createPayload = {
        email,
        tags,
        emailMarketingConsent: {
          marketingState: 'SUBSCRIBED',
          marketingOptInLevel: 'SINGLE_OPT_IN'
        }
      };

      if (metafieldsPayload.length > 0) {
        createPayload.metafields = metafieldsPayload;
      }

      const createRes = await shopifyGraphQL(
        `
          mutation customerCreate($input: CustomerInput!) {
            customerCreate(input: $input) {
              userErrors {
                message
              }
            }
          }
        `,
        {
          input: createPayload
        }
      );

      const userErrors = createRes.data?.customerCreate?.userErrors || [];

      if (userErrors.length > 0) {
        throw new Error(userErrors[0].message);
      }
    }

    return res.json({
      success: true,
      action,
      message: `Alert ${action === 'remove' ? 'removed' : 'saved'} successfully!`
    });
  } catch (error) {
    console.error('Restock Alert Failed:', error.message);

    return res.status(500).json({ error: 'Failed to update alert' });
  }
});

// =====================================================================
// 8. AI RECOMMENDATIONS PROFILE API
// =====================================================================

app.get('/api/get-ai-profile', async (req, res) => {
  const { customerId } = req.query;

  if (!customerId) {
    return res.status(400).json({ error: 'Missing customerId' });
  }

  try {
    const ownerId = customerId.includes('gid://')
      ? customerId
      : `gid://shopify/Customer/${customerId}`;

    const query = `
      query getCustomerAIProfile($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "custom", key: "ai_profile") {
            value
          }
        }
      }
    `;

    const result = await shopifyGraphQL(query, { id: ownerId });
    const rawValue = result.data?.customer?.metafield?.value;
    const profile = rawValue ? JSON.parse(rawValue) : {};

    return res.json({ profile });
  } catch (error) {
    console.error('Get AI Profile Failed:', error.message);

    return res.status(500).json({ error: 'Failed to fetch AI profile' });
  }
});

app.post('/api/save-ai-profile', async (req, res) => {
  const { customerId, profile } = req.body;

  if (!customerId || !profile) {
    return res.status(400).json({ error: 'Missing data' });
  }

  try {
    const ownerId = customerId.includes('gid://')
      ? customerId
      : `gid://shopify/Customer/${customerId}`;

    const setQuery = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            value
          }
          userErrors {
            message
          }
        }
      }
    `;

    const variables = {
      metafields: [
        {
          ownerId,
          namespace: 'custom',
          key: 'ai_profile',
          type: 'json',
          value: JSON.stringify(profile)
        }
      ]
    };

    const result = await shopifyGraphQL(setQuery, variables);
    const userErrors = result.data?.metafieldsSet?.userErrors || [];

    if (userErrors.length > 0) {
      throw new Error(userErrors[0].message);
    }

    return res.json({
      success: true,
      profile
    });
  } catch (error) {
    console.error('Save AI Profile Failed:', error.message);

    return res.status(500).json({ error: 'Failed to save AI profile' });
  }
});

// =====================================================================
// SERVER START
// =====================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Track123 Hub active on ${PORT}`);
});
