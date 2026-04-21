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

  // Embed the search query
  const voyageRes = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`
    },
    body: JSON.stringify({ model: 'voyage-3-lite', input: [query] })
  });

  if (!voyageRes.ok) {
    const err = await voyageRes.text();
    console.error('Voyage error:', err);
    return res.status(500).json({ error: 'Failed to process search query' });
  }

  const voyageData    = await voyageRes.json();
  const queryEmbedding = voyageData.data[0].embedding;

  // Vector similarity search via Supabase RPC (RLS enforced by caller JWT)
  const searchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/search_notes`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      'apikey':        process.env.SUPABASE_ANON_KEY
    },
    body: JSON.stringify({
      query_embedding: queryEmbedding,
      match_threshold: 0.25,
      match_count:     10
    })
  });

  if (!searchRes.ok) {
    const err = await searchRes.text();
    console.error('Supabase search error:', err);
    return res.status(500).json({ error: 'Search failed' });
  }

  const results = await searchRes.json();
  return res.status(200).json({ results });
};
