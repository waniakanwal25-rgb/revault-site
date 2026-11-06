// Unpublishes products that have been sold out for 24+ hours.
// Unpublish = delete the published doc, keep its content as a draft.

const PROJECT_ID = 'tyzbuc85';
const DATASET    = 'production';
const API_BASE   = `https://${PROJECT_ID}.api.sanity.io/v2023-01-01/data`;
const HOURS      = 24;

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const TOKEN = process.env.SANITY_API_TOKEN || process.env.SANITY_WRITE_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'No Sanity token set (SANITY_API_TOKEN)' });

  try {
    const groq = `*[_type == "product" && inStock == false && !(_id in path("drafts.**")) && dateTime(coalesce(soldAt, _updatedAt)) < dateTime(now()) - ${HOURS * 60 * 60}]`;
    const qRes = await fetch(`${API_BASE}/query/${DATASET}?query=${encodeURIComponent(groq)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const qData = await qRes.json();
    if (!qRes.ok) throw new Error(JSON.stringify(qData));
    const docs = qData.result || [];

    if (docs.length === 0) return res.status(200).json({ ok: true, unpublished: 0 });

    // ?dry=1 shows what would happen without changing anything
    if (req.query && req.query.dry) {
      return res.status(200).json({ ok: true, dryRun: true, wouldUnpublish: docs.map(d => d.name) });
    }

    const mutations = [];
    for (const d of docs) {
      const { _rev, _createdAt, _updatedAt, ...rest } = d;
      mutations.push({ createIfNotExists: { ...rest, _id: `drafts.${d._id}` } });
      mutations.push({ delete: { id: d._id } });
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
