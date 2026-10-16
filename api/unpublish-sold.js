// /api/unpublish-sold.js
// Runs on a schedule (Vercel Cron). Unpublishes every product that has been
// sold out for 48+ hours. "Unpublish" = delete the published document and keep
// its content as a draft, exactly like the Unpublish button in Sanity Studio.
//
// Env vars (Vercel → Settings → Environment Variables):
//   SANITY_API_TOKEN — already set (Editor role)
//   CRON_SECRET      — any long random string (Vercel sends it automatically on cron runs)

const PROJECT_ID = 'tyzbuc85';
const DATASET    = 'production';
const API_BASE   = `https://${PROJECT_ID}.api.sanity.io/v2023-01-01/data`;
const HOURS      = 48;

export default async function handler(req, res) {
  // Only allow Vercel Cron (or you, with the secret)
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const TOKEN = process.env.SANITY_API_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'SANITY_API_TOKEN not set' });

  try {
    // Published products that are sold out and untouched for 48h+
    // (buy.js marks inStock:false when sold, which sets _updatedAt)
    const groq = `*[_type == "product" && inStock == false && !(_id in path("drafts.**")) && dateTime(_updatedAt) < dateTime(now()) - ${HOURS * 60 * 60}]`;
    const qRes = await fetch(`${API_BASE}/query/${DATASET}?query=${encodeURIComponent(groq)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const qData = await qRes.json();
    if (!qRes.ok) throw new Error(JSON.stringify(qData));
    const docs = qData.result || [];

    if (docs.length === 0) return res.status(200).json({ ok: true, unpublished: 0 });

    // For each doc: keep a draft copy, delete the published one (one atomic transaction)
    const mutations = [];
    for (const d of docs) {
      const { _rev, _createdAt, _updatedAt, ...rest } = d;
      mutations.push({ createIfNotExists: { ...rest, _id: `drafts.${d._id}` } });
      mutations.push({ delete: { id: d._id } });
    }

    // ?dry=1 shows what would happen without changing anything
    if (req.query && req.query.dry) {
      return res.status(200).json({ ok: true, dryRun: true, wouldUnpublish: docs.map(d => d.name) });
    }

    const mRes = await fetch(`${API_BASE}/mutate/${DATASET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ mutations })
    });
    if (!mRes.ok) throw new Error(JSON.stringify(await mRes.json().catch(() => ({}))));

    console.log('Unpublished:', docs.map(d => d.name).join(', '));
    return res.status(200).json({ ok: true, unpublished: docs.length, names: docs.map(d => d.name) });
  } catch (err) {
    console.error('unpublish-sold failed:', err.message);
    return res.status(500).json({ error: 'failed', message: err.message });
  }
}
