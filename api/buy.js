// /api/buy.js
// Handles: (1) marking product sold in Sanity, (2) sending emails via Resend
//
// ATOMIC BY DESIGN:
// Step 1 checks the stock of every item in the order WITHOUT writing anything.
// Only if every single item is confirmed available do we send ONE batched
// mutation request containing a patch for every item. Sanity applies all
// mutations in a single request as one transaction — if ANY patch's
// ifRevisionID doesn't match (i.e. someone else bought it in the meantime),
// the ENTIRE transaction is rejected and NOTHING is written. This guarantees
// a product can never be marked sold unless the whole order actually succeeds.
//
// Environment variables required (Vercel → Settings → Environment Variables):
//   SANITY_API_TOKEN  — Sanity editor token (Editor role)
//   RESEND_API_KEY    — from resend.com/api-keys

const OWNER_EMAIL  = 'shop.revault0@gmail.com';
const FROM_ADDRESS = 'Revault <orders@revault.store>';

const PROJECT_ID = 'tyzbuc85';
const DATASET    = 'production';
const API_BASE   = `https://${PROJECT_ID}.api.sanity.io/v2023-01-01/data`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;

  // ── Contact form enquiry ──────────────────────────────────────────
  if (body.type === 'enquiry') {
    await sendEnquiryEmail(body);
    return res.status(200).json({ ok: true });
  }

  // ── Place order (single atomic call) ─────────────────────────────
  // Must have type === 'order' AND a non-empty sanityIds array
  if (body.type === 'order') {
    const { sanityIds, customer_name, customer_phone, address, city } = body;

    // Basic server-side field validation — reject incomplete orders outright
    if (!customer_name || !customer_phone || !address || !city) {
      return res.status(400).json({ error: 'incomplete_order', message: 'Missing required order fields.' });
    }

    // Reject if no items provided
    if (!Array.isArray(sanityIds) || sanityIds.length === 0) {
      return res.status(400).json({ error: 'no_items', message: 'Order contains no items.' });
    }

    // Validate Pakistani phone number format
    const phoneClean = customer_phone.replace(/[\s\-]/g, '');
    if (!/^(03\d{9}|\+923\d{9})$/.test(phoneClean)) {
      return res.status(400).json({ error: 'invalid_phone', message: 'Please provide a valid Pakistani mobile number.' });
    }

    // Validate every sanityId is a plain safe string with no injection characters
    for (const sanityId of sanityIds) {
      if (typeof sanityId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sanityId)) {
        return res.status(400).json({ error: 'invalid_id', message: 'Invalid product ID.' });
      }
    }

    const WRITE_TOKEN = process.env.SANITY_API_TOKEN;
    if (!WRITE_TOKEN) {
      console.error('SANITY_API_TOKEN not set');
      return res.status(500).json({ error: 'Server misconfiguration' });
    }

    // ── Step 1: Read-only check of every item — NOTHING is written yet ─
    // We fetch all requested docs in a single query so this is one round trip.
    let docs;
    try {
      const idsGroq = JSON.stringify(sanityIds); // safe: already validated above
      const query = encodeURIComponent(`*[_id in ${idsGroq}]{ _id, _rev, inStock, name }`);
      const fetchRes = await fetch(`${API_BASE}/query/${DATASET}?query=${query}`, {
        headers: { Authorization: `Bearer ${WRITE_TOKEN}` }
      });
      const fetchData = await fetchRes.json();
      docs = fetchData.result || [];
    } catch (err) {
      console.error('Error checking stock:', err.message);
      return res.status(500).json({ error: 'stock_check_failed', message: 'Could not verify item availability. Please try again.' });
    }

    const docsById = {};
    docs.forEach(d => { docsById[d._id] = d; });

    const soldOut = [];
    for (const sanityId of sanityIds) {
      const doc = docsById[sanityId];
      if (!doc) {
        soldOut.push({ sanityId, name: 'Unknown item', reason: 'not_found' });
      } else if (doc.inStock === false) {
        soldOut.push({ sanityId, name: doc.name, reason: 'already_sold' });
      }
    }

    // ── Step 2: If ANY item is unavailable, reject — nothing was ever written ─
    if (soldOut.length > 0) {
      const soldNames = soldOut.map(i => i.name).join(', ');
      console.log('Order rejected — sold out items:', soldNames);
      return res.status(409).json({
        error:    'items_sold_out',
        message:  `Sorry, the following item(s) are no longer available: ${soldNames}. Please remove them and try again.`,
        soldOut:  soldOut.map(i => ({ sanityId: i.sanityId, name: i.name }))
      });
    }

    // ── Step 3: Every item confirmed available — claim ALL of them in ONE
    // atomic transaction. ifRevisionID on every patch guards against anyone
    // else buying an item in the gap between our read and this write.
    // Sanity applies all mutations in a single request as one transaction:
    // if even ONE patch's revision no longer matches, the WHOLE request is
    // rejected and NO items get marked sold — never a partial claim.
    try {
      const mutations = sanityIds.map(sanityId => ({
        patch: {
          id:           sanityId,
          ifRevisionID: docsById[sanityId]._rev,
          set: { inStock: false, tag: 'Sold' }
        }
      }));

      const mutateRes = await fetch(`${API_BASE}/mutate/${DATASET}?returnIds=true`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          Authorization:   `Bearer ${WRITE_TOKEN}`
        },
        body: JSON.stringify({ mutations })
      });

      if (mutateRes.status === 409) {
        // Someone else bought one (or more) of these items in the split-second
        // between our read and this write. The whole transaction was rejected,
        // so NOTHING was marked sold. Safe to tell the customer to retry.
        console.log('Race condition on batch claim — order rejected, nothing was written');
        return res.status(409).json({
          error:   'items_sold_out',
          message: 'Sorry, one or more items in your order were just purchased by someone else. Please refresh and try again.'
        });
      }

      if (!mutateRes.ok) {
        const err = await mutateRes.json().catch(() => ({}));
        console.error('Sanity batch mutate failed:', JSON.stringify(err));
        return res.status(500).json({ error: 'claim_failed', message: 'Something went wrong reserving your items. Please try again.' });
      }

      console.log('✓ Claimed all items:', sanityIds.join(', '));

    } catch (err) {
      console.error('Error claiming items:', err.message);
      return res.status(500).json({ error: 'claim_failed', message: 'Something went wrong reserving your items. Please try again.' });
    }

    // ── Step 4: All items claimed — now send emails ────────────────
    // Emails only fire after every single item was successfully, atomically claimed.
    await sendOrderEmails(body);

    console.log('✓ Order complete:', body.order_id);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown request type' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Email helpers
// ─────────────────────────────────────────────────────────────────────────────

async function sendOrderEmails(d) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const headers = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${RESEND_API_KEY}`
  };

  const promises = [];

  if (d.customer_email) {
    promises.push(
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from:    FROM_ADDRESS,
          to:      [d.customer_email],
          subject: `Order Confirmed — ${d.order_id}`,
          html:    buildCustomerHtml(d),
        })
      }).then(r => r.ok ? null : r.json().then(e => console.warn('Customer email failed:', e)))
        .catch(err => console.warn('Customer email error:', err))
    );
  }

  promises.push(
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from:    FROM_ADDRESS,
        to:      [OWNER_EMAIL],
        subject: `New Order — ${d.order_id}`,
        html:    buildOwnerHtml(d),
      })
    }).then(r => r.ok ? null : r.json().then(e => console.warn('Owner email failed:', e)))
      .catch(err => console.warn('Owner email error:', err))
  );

  await Promise.all(promises);
}

async function sendEnquiryEmail(d) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from:    FROM_ADDRESS,
      to:      [OWNER_EMAIL],
      subject: `Customer Enquiry — ${d.customer_name}`,
      html:    buildEnquiryHtml(d),
    })
  }).catch(err => console.warn('Enquiry email error:', err));
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML email templates (unchanged from your original)
// ─────────────────────────────────────────────────────────────────────────────

function row(label, value) {
  return `<tr><td style="padding:6px 12px 6px 0;color:#7a6355;font-size:13px;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:6px 0;font-size:13px;color:#2c2118;">${value || '—'}</td></tr>`;
}

function baseLayout(title, content) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f1e8;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px;">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#faf8f3;border:1px solid #e8e2d8;border-radius:4px;overflow:hidden;">
    <tr><td style="background:#2c2118;padding:28px 32px;">
      <p style="margin:0;font-family:Georgia,serif;font-size:22px;color:#f5f1e8;letter-spacing:.08em;">REVAULT</p>
      <p style="margin:6px 0 0;font-size:11px;color:rgba(245,241,232,.5);letter-spacing:.18em;text-transform:uppercase;">${title}</p>
    </td></tr>
    <tr><td style="padding:32px;">${content}</td></tr>
    <tr><td style="padding:20px 32px;border-top:1px solid #e8e2d8;font-size:11px;color:#c8bdb4;text-align:center;letter-spacing:.1em;">
      REVAULT · Curated Pre-Loved Fashion · <a href="https://www.instagram.com/shoprevault" style="color:#c8bdb4;">@shoprevault</a>
    </td></tr>
  </table></td></tr></table></body></html>`;
}

function buildCustomerHtml(d) {
  const content = `
    <p style="margin:0 0 20px;font-size:15px;color:#2c2118;">Hi ${d.customer_name},</p>
    <p style="margin:0 0 24px;font-size:13px;color:#7a6355;line-height:1.7;">Thank you for your order! We've received your request and will confirm once payment is verified.</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;">
      ${row('Order ID',       d.order_id)}
      ${row('Items',          d.order_items)}
      ${row('Total',          'PKR ' + d.total)}
      ${row('Payment',        d.payment_method)}
      ${row('Address',        [d.address, d.area, d.city].filter(Boolean).join(', '))}
      ${row('Phone',          d.customer_phone)}
    </table>
    <p style="margin:0;font-size:12px;color:#c8bdb4;line-height:1.7;">Send your payment screenshot via our Instagram <a href="https://www.instagram.com/shoprevault" style="color:#7a6355;text-decoration:none;white-space:nowrap;">@shoprevault</a> to confirm your order. A tracking link will be shared once dispatched.</p>`;
  return baseLayout('Order Confirmation', content);
}

function buildOwnerHtml(d) {
  const content = `
    <p style="margin:0 0 20px;font-size:15px;color:#2c2118;font-weight:600;">New Order Received</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;">
      ${row('Order ID',       d.order_id)}
      ${row('Customer',       d.customer_name)}
      ${row('Email',          d.customer_email)}
      ${row('Phone',          d.customer_phone)}
      ${row('Items',          d.order_items)}
      ${row('Total',          'PKR ' + d.total)}
      ${row('Payment',        d.payment_method)}
      ${row('Address',        [d.address, d.area, d.city].filter(Boolean).join(', '))}
    </table>`;
  return baseLayout('New Order', content);
}

function buildEnquiryHtml(d) {
  const content = `
    <p style="margin:0 0 20px;font-size:15px;color:#2c2118;font-weight:600;">New Customer Enquiry</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;">
      ${row('From',    d.customer_name)}
      ${row('Email',   d.customer_email)}
      ${row('Message', d.area)}
    </table>`;
  return baseLayout('Customer Enquiry', content);
}
