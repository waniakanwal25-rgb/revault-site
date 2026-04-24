// /api/buy.js
// Handles: (1) marking product sold in Sanity, (2) sending emails via Resend
//
// Environment variables required (Vercel → Settings → Environment Variables):
//   SANITY_WRITE_TOKEN  — Sanity editor token
//   RESEND_API_KEY      — from resend.com/api-keys

const OWNER_EMAIL  = 'shop.revault0@gmail.com';
const FROM_ADDRESS = 'Revault <orders@revault.store>';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;

  // ── Contact form enquiry (no Sanity mutation needed) ──────────────
  if (body.type === 'enquiry') {
    await sendEnquiryEmail(body);
    return res.status(200).json({ ok: true });
  }

  // ── Order placement ───────────────────────────────────────────────
  const { productClientId } = body;

  if (productClientId) {
    // Mark sold in Sanity (your existing logic — keep as-is)
    const WRITE_TOKEN = process.env.SANITY_API_TOKEN;
    const PROJECT_ID  = 'tyzbuc85';
    const DATASET     = 'production';
    const API_BASE    = `https://${PROJECT_ID}.api.sanity.io/v2023-01-01/data`;

    try {
      const idx = parseInt(productClientId.replace(/^s-/, ''));
      const query = encodeURIComponent(
        `*[_type == "product"] | order(_createdAt asc) [${idx}] { _id, _rev, inStock }`
      );
      const fetchRes  = await fetch(`${API_BASE}/query/${DATASET}?query=${query}`, {
        headers: { Authorization: `Bearer ${WRITE_TOKEN}` }
      });
      const fetchData = await fetchRes.json();
      const doc       = fetchData.result;

      if (!doc || !doc._id)        return res.status(404).json({ error: 'Product not found' });
      if (doc.inStock === false)   return res.status(409).json({ error: 'already_sold', message: 'This item is no longer available.' });

      const mutateRes = await fetch(`${API_BASE}/mutate/${DATASET}?returnIds=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WRITE_TOKEN}` },
        body: JSON.stringify({
          mutations: [{ patch: { id: doc._id, ifRevisionID: doc._rev, set: { inStock: false, tag: 'Sold' } } }]
        })
      });

      if (mutateRes.status === 409) return res.status(409).json({ error: 'already_sold', message: 'This item was just purchased by another customer.' });
      if (!mutateRes.ok) {
        const err = await mutateRes.json().catch(() => ({}));
        return res.status(mutateRes.status).json(err);
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Send order emails via Resend ──────────────────────────────────
  await sendOrderEmails(body);

  return res.status(200).json({ ok: true });
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

  // 1. Customer confirmation (only if they provided an email)
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

  // 2. Owner notification
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
// HTML email templates
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
    <p style="margin:0;font-size:12px;color:#c8bdb4;line-height:1.7;">Send your payment screenshot via our <a href="https://www.instagram.com/shoprevault" style="color:#7a6355;">Instagram</a> to confirm your order. A tracking link will be shared once dispatched.</p>`;
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
