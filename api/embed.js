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
  const user = await authRes.json();

  // Rate limit: 20 AI-processed saves per user per day
  const today = new Date().toISOString().slice(0, 10);
  const key   = `ai_process:${user.id}:${today}`;

  const incrRes = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/incr/${key}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const { result: count } = await incrRes.json();

  if (count === 1) {
    fetch(`${process.env.UPSTASH_REDIS_REST_URL}/expire/${key}/90000`, {
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
    });
  }

  if (count > 20) {
    return res.status(429).json({ error: 'Daily limit reached (20 saves/day). Try again tomorrow.' });
  }

  const { noteId, content } = req.body;
  if (!noteId || !content?.trim()) {
    return res.status(400).json({ error: 'noteId and content are required' });
  }

  // Generate embedding via Voyage AI
  const voyageRes = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`
    },
    body: JSON.stringify({ model: 'voyage-3-lite', input: [content] })
  });

  if (!voyageRes.ok) {
    const err = await voyageRes.text();
    console.error('Voyage error:', err);
    return res.status(500).json({ error: 'Failed to generate embedding' });
  }

  const voyageData = await voyageRes.json();
  const embedding  = voyageData.data[0].embedding;

  // Generate tags via Claude Haiku
  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [{
        role:    'user',
        content: `Return 2-3 tags for this note as a JSON array. Tags: lowercase, 1-2 words, topic or type. Examples: ["ai","strategy"], ["productivity","tools"], ["economics","reading"]. Respond with ONLY the JSON array.\n\nNote: ${content}`
      }]
    })
  });

  let tags = [];
  if (aiRes.ok) {
    try {
      const aiData = await aiRes.json();
      const raw    = aiData.content[0].text.trim().replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        tags = parsed.filter(t => typeof t === 'string').slice(0, 3);
      }
    } catch { /* tags stays [] */ }
  }

  // Patch the note with embedding + tags
  const patchRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/notes?id=eq.${noteId}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey':        process.env.SUPABASE_ANON_KEY,
        'Prefer':        'return=minimal'
      },
      body: JSON.stringify({ embedding, tags })
    }
  );

  if (!patchRes.ok) {
    const err = await patchRes.text();
    console.error('Supabase patch error:', err);
    return res.status(500).json({ error: 'Failed to save embedding' });
  }

  return res.status(200).json({ tags });
};
