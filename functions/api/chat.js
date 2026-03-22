// Cloudflare Pages Function — proxies chat messages to Google Gemini API
// The GEMINI_API_KEY is set as an environment variable in Cloudflare Dashboard:
//   Settings → Environment variables → Add: GEMINI_API_KEY = <your key>

const SYSTEM_PROMPT = `You are Fanelia AI, a friendly IT support assistant for Fanelia Consulting LLC in New York.

Services: Mac & Apple repair, virus removal, data recovery, network setup, remote support, system optimization, iPhone/iPad setup, IT consulting.
Pricing: On-Site Tech Support starts at $130/visit. Remote Tech Support starts at $65/session. Transparent pricing, no hidden fees.
Phone: (347) 702-0988
Email: info@faneliaconsulting.com
Hours: Mon–Fri 9am–7pm, Sat 10am–5pm, Sun by appointment. Available remotely anytime.
Area: New York City and remotely nationwide.

Rules:
- Keep all replies SHORT (2–4 sentences max).
- Be warm, helpful, and professional.
- When someone is ready to book or needs urgent help, always end with: "Call us at (347) 702-0988 or click **Get Help Now** above."
- For pricing, refer to the service rates above or say "we'll give you a free estimate."
- You are a live website assistant for faneliaconsulting.com.`;

// ── Allowed origins (restrict to your domain) ──────────────
const ALLOWED_ORIGINS = [
  'https://faneliaconsulting.com',
  'https://www.faneliaconsulting.com',
];

// ── Simple in-memory rate limiter (per-IP, resets per worker lifecycle) ──
const rateMap = new Map();
const RATE_LIMIT = 20;        // max requests …
const RATE_WINDOW_MS = 60000; // … per 60 seconds

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

// ── Main handler ────────────────────────────────────────────
export async function onRequestPost(context) {
  const { env, request } = context;
  const apiKey = env.GEMINI_API_KEY;
  const corsHeaders = getCorsHeaders(request);

  // 1. Check origin
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response(
      JSON.stringify({ error: 'Forbidden' }),
      { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  // 2. Rate limit by IP
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (isRateLimited(ip)) {
    return new Response(
      JSON.stringify({ error: 'Too many requests. Please try again in a minute.' }),
      { status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  // 3. Check API key
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'API key not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  try {
    const body = await request.json();
    let { messages } = body;

    // 4. Validate messages
    if (!messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: 'Invalid request: messages array required' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // 5. Cap conversation history to prevent abuse
    if (messages.length > 20) {
      messages = messages.slice(-20);
    }

    // 6. Check each message for excessive length
    for (const msg of messages) {
      const text = msg?.parts?.[0]?.text || '';
      if (text.length > 2000) {
        return new Response(
          JSON.stringify({ error: 'Message too long (max 2000 characters)' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: messages,
      }),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('Gemini API error:', JSON.stringify(data));
      return new Response(
        JSON.stringify({ error: 'AI service error', detail: data?.error?.message || 'Unknown error' }),
        { status: geminiRes.status, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text
      || "I'm having trouble right now. Please call us at (347) 702-0988!";

    return new Response(
      JSON.stringify({ reply }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  } catch (err) {
    console.error('Proxy error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}

// ── Handle preflight CORS requests ─────────────────────────
export async function onRequestOptions(context) {
  const corsHeaders = getCorsHeaders(context.request);
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}
