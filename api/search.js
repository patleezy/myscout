module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const authRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: process.env.SUPABASE_ANON_KEY
    }
  });
  if (!authRes.ok) return res.status(401).json({ error: 'Unauthorized' });

  const { query } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: 'Query is required' });

  const q = query.trim();
  // Strip PostgREST wildcard/grouping chars so they can't break the filter syntax
  const safeQ = encodeURIComponent(q.replace(/[*()]/g, ''));

  // Text search and embedding run in parallel — text doesn't need the embedding
  const textUrl = `${process.env.SUPABASE_URL}/rest/v1/notes`
    + `?or=(content.ilike.*${safeQ}*,og_title.ilike.*${safeQ}*)`
    + `&select=id,content,tags,og_image,og_title,summary,is_favorite,created_at`
    + `&order=created_at.desc`;

  const [voyageSettled, textSettled] = await Promise.allSettled([
    fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}` },
      body: JSON.stringify({ model: 'voyage-3-lite', input: [q] })
    }),
    fetch(textUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': process.env.SUPABASE_ANON_KEY }
    })
  ]);

  // Collect text results
  let textResults = [];
  if (textSettled.status === 'fulfilled' && textSettled.value.ok) {
    try { textResults = await textSettled.value.json(); } catch { /* ignore */ }
  }

  // Vector search (only if embedding succeeded)
  let vectorResults = [];
  if (voyageSettled.status === 'fulfilled' && voyageSettled.value.ok) {
    try {
      const voyageData = await voyageSettled.value.json();
      const embedding  = voyageData.data[0].embedding;

      const vectorRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/search_notes`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey':        process.env.SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ query_embedding: embedding, match_threshold: 0.25, match_count: 10 })
      });
      if (vectorRes.ok) vectorResults = await vectorRes.json();
    } catch { /* fall through to text-only */ }
  }

  // Merge: text results first (exact match wins), then unique vector results
  const seen = new Set(textResults.map(n => n.id));
  for (const n of vectorResults) {
    if (!seen.has(n.id)) { textResults.push(n); seen.add(n.id); }
  }

  return res.status(200).json({ results: textResults });
};
