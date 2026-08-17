/**
 * LostScale Website API Worker
 *
 * Serves read-only content for the lostscale.com homepage:
 *  - GET /todays-brief  → picks a random cached brief section from today's email run
 *  - GET /book-of-week  → returns the current book of the week
 *
 * Runs at 13:00 UTC (1 hour after the email worker at 12:00 UTC)
 * so the cache is already populated by the time this fires.
 *
 * No LLM/search pipeline — reads only from the D1 brief_cache table
 * that the email worker populates.
 */

// ─── Book of the Week ───

const BOOKS = [
  { title: "Atomic Habits", author: "James Clear", topic: "Self-Improvement", why: "The definitive guide to building good habits and breaking bad ones. Small changes, remarkable results.", cover: "https://covers.openlibrary.org/b/isbn/9780735211292-L.jpg", link: "https://www.amazon.in/dp/1847941834?&linkCode=ll2&tag=lostscale-21&linkId=c4d49457cb1cf464a421be4753a64567&ref_=as_li_ss_tl" },
];

function getBookOfTheWeek() {
  const date = new Date();
  const tempDate = new Date(date.getTime());
  tempDate.setHours(0, 0, 0, 0);
  tempDate.setDate(tempDate.getDate() + 3 - (tempDate.getDay() + 6) % 7);
  const week1 = new Date(tempDate.getFullYear(), 0, 4);
  const weekNo = 1 + Math.round(((tempDate.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
  return BOOKS[weekNo % BOOKS.length];
}

// ─── Today's Brief (from cache) ───

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function getTodaysBrief(env) {
  const today = new Date().toISOString().slice(0, 10);

  // The email worker caches sections as: section|<topic>|<vibe>|<date>
  // Pick a random one from today
  const result = await env.DB.prepare(
    "SELECT cache_key, result_json FROM brief_cache WHERE cache_key LIKE ? ORDER BY RANDOM() LIMIT 1"
  ).bind(`section|%|%|${today}`).first();

  if (!result) {
    return { html: null, topic: null };
  }

  // Extract topic from cache_key: section|<topic>|<vibe>|<date>
  const parts = result.cache_key.split('|');
  const topic = parts[1] ? parts[1].charAt(0).toUpperCase() + parts[1].slice(1) : "Today's Brief";

  const parsed = JSON.parse(result.result_json);

  // Build HTML from the cached paragraph + sources
  let html = '';

  if (parsed.paragraph) {
    html += `<p style="margin:0 0 16px 0;font-size:0.9375rem;line-height:1.6;color:#1a1a1a;">${parsed.paragraph}</p>`;
  }

  // Sources are nested inside searchResult in the cache
  const sources = parsed.sources || (parsed.searchResult && parsed.searchResult.sources) || [];

  if (sources.length > 0) {
    let sourcesHtml = 'Sources: ';
    sources.forEach((s, j) => {
      const num = j + 1;
      const url = s.url || '#';
      sourcesHtml += `<a href="${url}" style="color:#2b6cb0;text-decoration:none;">[${num}]</a> `;
    });
    html += `<p style="margin:12px 0 0 0;font-size:0.8125rem;color:#999;">${sourcesHtml.trim()}</p>`;
  }

  return { html, topic };
}

// ─── Worker entry ───

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Today's brief — public, cached for 1 hour
    if (path === '/todays-brief') {
      try {
        const brief = await getTodaysBrief(env);
        return jsonResponse(brief, 200, {
          ...CORS_HEADERS,
          'Cache-Control': 'public, max-age=3600',
        });
      } catch (err) {
        console.error('Todays brief error:', err);
        return jsonResponse({ html: null, topic: null }, 200, CORS_HEADERS);
      }
    }

    // Book of the week — public, cached for 1 hour
    if (path === '/book-of-week') {
      const book = getBookOfTheWeek();
      return jsonResponse(book, 200, {
        ...CORS_HEADERS,
        'Cache-Control': 'public, max-age=3600',
      });
    }

    // Health check
    if (path === '/health') {
      return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
    }

    return jsonResponse({ error: 'Not found' }, 404, CORS_HEADERS);
  },

  // Cron — just warms the cache read. The brief is already in D1
  // from the email worker's 12:00 UTC run. This fires at 13:00 UTC
  // as a safety net to ensure the website has content available.
  async scheduled(event, env) {
    console.log('Website API cron tick — cache should already be populated by email worker');
    const brief = await getTodaysBrief(env);
    console.log('Brief available:', brief.html ? 'yes' : 'no', '| topic:', brief.topic);
  },
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
