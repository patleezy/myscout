function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0].replace(/[.,;!?)]+$/, '') : null;
}

function isYouTubeUrl(url) {
  return /youtube\.com\/watch|youtu\.be\//.test(url);
}

async function fetchYoutubeSummary(url) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { fileData: { mimeType: 'video/*', fileUri: url } },
          { text: 'Summarize this YouTube video in 2–3 sentences. Be specific about the main topic and key insights — no filler.' }
        ]}]
      }),
      signal: AbortSignal.timeout(20000)
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini response');
  return text;
}

async function fetchArticleText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control':   'no-cache'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) return null;

  const html = await res.text();

  // Strip noisy blocks first, then all tags
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();

  // If we got back mostly boilerplate or very little content, treat as failure
  if (text.length < 200) return null;

  // Cap at ~6000 chars to stay well within Claude's context for this task
  return text.slice(0, 6000);
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

  // Rate limit: 20 summarizes per user per day
  const today = new Date().toISOString().slice(0, 10);
  const key   = `summarize:${user.id}:${today}`;

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
    return res.status(429).json({ error: 'Daily limit reached (20 summaries/day). Try again tomorrow.' });
  }

  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'No content provided' });

  const url = extractUrl(content);

  // YouTube path: Gemini handles video natively
  if (url && isYouTubeUrl(url)) {
    try {
      const summary = await fetchYoutubeSummary(url);
      return res.status(200).json({ summary, source: 'youtube' });
    } catch (e) {
      console.error('Gemini error:', e);
      return res.status(500).json({ error: 'Failed to generate YouTube summary' });
    }
  }

  // Non-YouTube path: fetch article text → Claude Sonnet
  let articleText = null;
  if (url) {
    try { articleText = await fetchArticleText(url); } catch { /* fall through */ }
  }

  const prompt = articleText
    ? `Summarize this article in 2–3 sentences. Be specific about the key argument and main insights — no filler.\n\nURL: ${url}\n\n${articleText}`
    : `Summarize this saved note in 1–2 sentences. Be direct and specific.\n\n${content}`;

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
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!aiRes.ok) {
    const err = await aiRes.text();
    console.error('Anthropic error:', err);
    return res.status(500).json({ error: 'Failed to generate summary' });
  }

  const aiData = await aiRes.json();
  return res.status(200).json({
    summary: aiData.content[0].text,
    source:  articleText ? 'article' : 'note'
  });
};
