// File: aiProfileSync.js
const fetch = require('node-fetch'); // Make sure you have node-fetch installed

async function syncAIProfile(req, res) {
    const { customer_id, ai_overview } = req.body;

    if (!customer_id || !ai_overview) {
        return res.status(400).json({ error: 'Missing customer_id or ai_overview' });
    }

    const shopifyDomain = process.env.SHOPIFY_DOMAIN; 
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN; 

    const query = `
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
                metafields { id key value }
                userErrors { field message }
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
                value: ai_overview
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
        
        if (data.data?.metafieldsSet?.userErrors?.length > 0) {
            console.error('Shopify Metafield Errors:', data.data.metafieldsSet.userErrors);
            return res.status(400).json({ error: data.data.metafieldsSet.userErrors });
        }

        res.json({ success: true, message: "AI Profile successfully synced to Shopify!" });

    } catch (error) {
        console.error('Server error updating metafield:', error);
        res.status(500).json({ error: 'Failed to sync with Shopify' });
    }
}

module.exports = { syncAIProfile };
