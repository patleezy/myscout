function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0].replace(/[.,;!?)]+$/, '') : null;
}

async function fetchOgData(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000)
    });

    if (!res.ok) return {};

    const html = await res.text();

    const get = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
             || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'));
      return m ? m[1].trim() : null;
    };

    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);

    return {
      og_image: get('og:image') || null,
      og_title: get('og:title') || (titleTag ? titleTag[1].trim() : null)
    };
  } catch {
    return {};
  }
}

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

  // Run embedding, tagging, and OG fetch in parallel
  const url = extractUrl(content);

  const [voyageRes, aiRes, ogData] = await Promise.all([
    fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}` },
      body: JSON.stringify({ model: 'voyage-3-lite', input: [content] })
    }),
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        messages: [{
          role: 'user',
          content: `Return 2-3 tags for this note as a JSON array. Tags: lowercase, 1-2 words, topic or type. Examples: ["ai","strategy"], ["productivity","tools"], ["economics","reading"]. Respond with ONLY the JSON array.\n\nNote: ${content}`
        }]
      })
    }),
    url ? fetchOgData(url) : Promise.resolve({})
  ]);

  if (!voyageRes.ok) {
    console.error('Voyage error:', await voyageRes.text());
    return res.status(500).json({ error: 'Failed to generate embedding' });
  }

  const voyageData = await voyageRes.json();
  const embedding  = voyageData.data[0].embedding;

  let tags = [];
  if (aiRes.ok) {
    try {
      const aiData = await aiRes.json();
      const raw    = aiData.content[0].text.trim().replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) tags = parsed.filter(t => typeof t === 'string').slice(0, 3);
    } catch { /* tags stays [] */ }
  }

  // Patch note with embedding, tags, and OG data
  const patch = { embedding, tags };
  if (ogData.og_image) patch.og_image = ogData.og_image;
  if (ogData.og_title) patch.og_title = ogData.og_title;

  const patchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/notes?id=eq.${noteId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      'apikey':        process.env.SUPABASE_ANON_KEY,
      'Prefer':        'return=minimal'
    },
    body: JSON.stringify(patch)
  });

  if (!patchRes.ok) {
    console.error('Supabase patch error:', await patchRes.text());
    return res.status(500).json({ error: 'Failed to save embedding' });
  }

  return res.status(200).json({ tags, og_image: ogData.og_image || null, og_title: ogData.og_title || null });
};
