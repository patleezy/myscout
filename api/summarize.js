module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify Supabase session
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

  // Rate limit: 20 summarizes per user per day via Upstash
  const today = new Date().toISOString().slice(0, 10);
  const key   = `summarize:${user.id}:${today}`;

  const incrRes = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/incr/${key}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const { result: count } = await incrRes.json();

  if (count === 1) {
    // Set TTL of 25 hours on first use so the key always expires
    fetch(`${process.env.UPSTASH_REDIS_REST_URL}/expire/${key}/90000`, {
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
    });
  }

  if (count > 20) {
    return res.status(429).json({
      error: 'Daily limit reached (20 summaries/day). Try again tomorrow.'
    });
  }

  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'No content provided' });

  // Call Anthropic
  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role:    'user',
        content: `Summarize the following saved note in 1–2 concise sentences. The note may contain URLs — treat them as references, not as pages to visit. Summarize only what is written in the note itself.\n\n${content}`
      }]
    })
  });

  if (!aiRes.ok) {
    const err = await aiRes.text();
    console.error('Anthropic error:', err);
    return res.status(500).json({ error: 'Failed to generate summary' });
  }

  const aiData = await aiRes.json();
  return res.status(200).json({ summary: aiData.content[0].text });
};
