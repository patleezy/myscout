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

  // Rate limit: 20 chat queries per user per day
  const today = new Date().toISOString().slice(0, 10);
  const key   = `chat:${user.id}:${today}`;

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
    return res.status(429).json({ error: 'Daily limit reached (20 chats/day). Try again tomorrow.' });
  }

  const { question } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Question is required' });

  // Embed the question
  const voyageRes = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}` },
    body: JSON.stringify({ model: 'voyage-3-lite', input: [question] })
  });
  if (!voyageRes.ok) {
    console.error('Voyage error:', await voyageRes.text());
    return res.status(500).json({ error: 'Failed to process question' });
  }
  const { data: [{ embedding }] } = await voyageRes.json();

  // Retrieve top-5 relevant notes via existing search_notes RPC
  const searchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/search_notes`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      'apikey':        process.env.SUPABASE_ANON_KEY
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_threshold: 0.2,
      match_count:     5
    })
  });
  if (!searchRes.ok) {
    console.error('Supabase search error:', await searchRes.text());
    return res.status(500).json({ error: 'Failed to retrieve notes' });
  }
  const notes = await searchRes.json();

  if (!notes.length) {
    return res.status(200).json({
      answer:  "I couldn't find any relevant notes to answer that. Try saving more content first!",
      noteIds: []
    });
  }

  const context = notes.map((n, i) =>
    `Note ${i + 1}:\n${n.content}`
  ).join('\n\n---\n\n');

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 400,
      system: `You are a personal knowledge assistant. Answer the user's question using ONLY the notes provided. Be direct and specific. If the notes don't contain a clear answer, say so honestly.\n\nNotes:\n${context}`,
      messages: [{ role: 'user', content: question }]
    })
  });

  if (!aiRes.ok) {
    console.error('Anthropic error:', await aiRes.text());
    return res.status(500).json({ error: 'Failed to generate answer' });
  }

  const aiData = await aiRes.json();
  return res.status(200).json({
    answer:  aiData.content[0].text,
    noteIds: notes.map(n => n.id)
  });
};
