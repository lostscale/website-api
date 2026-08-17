/**
 * LostScale Website API Worker
 *
 * Serves read-only content for the lostscale.com homepage:
 *  - GET /todays-brief  → picks a random cached brief section from today's email run
 *  - GET /book-of-week  → returns the current book of the week (deterministic per ISO week)
 *  - POST /add-book     → admin: add a book to the books table
 *
 * Runs at 13:00 UTC (1 hour after the email worker at 12:00 UTC)
 * so the cache is already populated by the time this fires.
 */

// ─── Book of the Week (from D1 books table) ───

function getWeekNumber() {
  const date = new Date();
  const tempDate = new Date(date.getTime());
  tempDate.setHours(0, 0, 0, 0);
  tempDate.setDate(tempDate.getDate() + 3 - (tempDate.getDay() + 6) % 7);
  const week1 = new Date(tempDate.getFullYear(), 0, 4);
  return 1 + Math.round(((tempDate.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

async function getBookOfTheWeek(env) {
  const weekNo = getWeekNumber();
  // Pick deterministic book for this week, cycling through all books
  const count = await env.DB.prepare('SELECT COUNT(*) as cnt FROM books').first();
  if (!count || count.cnt === 0) {
    return null;
  }
  const offset = weekNo % count.cnt;
  const book = await env.DB.prepare(
    'SELECT title, author, topic, description, affiliate_link, cover_link FROM books LIMIT 1 OFFSET ?'
  ).bind(offset).first();
  if (!book) return null;
  return {
    title: book.title,
    author: book.author,
    topic: book.topic,
    why: book.description,
    cover: book.cover_link,
    link: book.affiliate_link,
  };
}

/**
 * Get a book matching one of the subscriber's interests.
 * Falls back to a random book if no topic match.
 */
async function getBookForInterests(env, interests) {
  // Try to find a book whose topic matches one of the subscriber's interests
  for (const interest of interests) {
    const book = await env.DB.prepare(
      'SELECT title, author, topic, description, affiliate_link, cover_link FROM books WHERE LOWER(topic) = LOWER(?) LIMIT 1'
    ).bind(interest.toLowerCase()).first();
    if (book) {
      return {
        title: book.title,
        author: book.author,
        topic: book.topic,
        why: book.description,
        cover: book.cover_link,
        link: book.affiliate_link,
      };
    }
  }
  // Fallback: random book
  const book = await env.DB.prepare(
    'SELECT title, author, topic, description, affiliate_link, cover_link FROM books ORDER BY RANDOM() LIMIT 1'
  ).first();
  if (!book) return null;
  return {
    title: book.title,
    author: book.author,
    topic: book.topic,
    why: book.description,
    cover: book.cover_link,
    link: book.affiliate_link,
  };
}

// ─── Today's Brief (from cache) ───

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

async function getTodaysBrief(env) {
  const today = new Date().toISOString().slice(0, 10);

  const result = await env.DB.prepare(
    "SELECT cache_key, result_json FROM brief_cache WHERE cache_key LIKE ? ORDER BY RANDOM() LIMIT 1"
  ).bind(`section|%|%|${today}`).first();

  if (!result) {
    return { html: null, topic: null };
  }

  const parts = result.cache_key.split('|');
  const topic = parts[1] ? parts[1].charAt(0).toUpperCase() + parts[1].slice(1) : "Today's Brief";

  const parsed = JSON.parse(result.result_json);

  let html = '';

  if (parsed.paragraph) {
    html += `<p style="margin:0 0 16px 0;font-size:0.9375rem;line-height:1.6;color:#1a1a1a;">${parsed.paragraph}</p>`;
  }

  const sources = parsed.sources || (parsed.searchResult && parsed.searchResult.sources) || [];

  if (sources.length > 0) {
    let sourcesHtml = 'Sources: ';
    sources.forEach((s, j) => {
      const num = j + 1;
      const url = s.url || '#';
      sourcesHtml += `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#2b6cb0;text-decoration:none;">[${num}]</a> `;
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

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Today's brief
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

    // Book of the week
    if (path === '/book-of-week') {
      try {
        const book = await getBookOfTheWeek(env);
        if (!book) {
          return jsonResponse({ error: 'No books available' }, 404, CORS_HEADERS);
        }
        return jsonResponse(book, 200, {
          ...CORS_HEADERS,
          'Cache-Control': 'public, max-age=3600',
        });
      } catch (err) {
        console.error('Book of week error:', err);
        return jsonResponse({ error: 'Failed to get book' }, 500, CORS_HEADERS);
      }
    }

    // Get a book for specific interests (used by email worker)
    if (path === '/book-for-interests' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization') || '';
      const providedToken = authHeader.replace(/^Bearer\s+/i, '');
      if (!env.ADMIN_TOKEN || providedToken !== env.ADMIN_TOKEN) {
        return jsonResponse({ error: 'Unauthorized' }, 401, CORS_HEADERS);
      }
      try {
        const body = await request.json();
        const book = await getBookForInterests(env, body.interests || []);
        if (!book) {
          return jsonResponse({ book: null }, 200, CORS_HEADERS);
        }
        return jsonResponse({ book }, 200, CORS_HEADERS);
      } catch (err) {
        console.error('Book for interests error:', err);
        return jsonResponse({ book: null }, 200, CORS_HEADERS);
      }
    }

    // Add a book (admin only)
    if (path === '/add-book' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization') || '';
      const providedToken = authHeader.replace(/^Bearer\s+/i, '');
      if (!env.ADMIN_TOKEN || providedToken !== env.ADMIN_TOKEN) {
        return jsonResponse({ error: 'Unauthorized' }, 401, CORS_HEADERS);
      }
      try {
        const body = await request.json();
        if (!body.title || !body.author || !body.topic || !body.description || !body.affiliate_link || !body.cover_link) {
          return jsonResponse({ error: 'Missing required fields: title, author, topic, description, affiliate_link, cover_link' }, 400, CORS_HEADERS);
        }
        await env.DB.prepare(
          'INSERT INTO books (title, author, topic, description, affiliate_link, cover_link) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(body.title, body.author, body.topic, body.description, body.affiliate_link, body.cover_link).run();
        return jsonResponse({ message: 'Book added', title: body.title }, 201, CORS_HEADERS);
      } catch (err) {
        console.error('Add book error:', err);
        return jsonResponse({ error: 'Failed to add book' }, 500, CORS_HEADERS);
      }
    }

    // List all books (admin only)
    if (path === '/books' && request.method === 'GET') {
      const authHeader = request.headers.get('Authorization') || '';
      const providedToken = authHeader.replace(/^Bearer\s+/i, '');
      if (!env.ADMIN_TOKEN || providedToken !== env.ADMIN_TOKEN) {
        return jsonResponse({ error: 'Unauthorized' }, 401, CORS_HEADERS);
      }
      const result = await env.DB.prepare(
        'SELECT id, title, author, topic, description, affiliate_link, cover_link, created_at FROM books ORDER BY created_at DESC'
      ).all();
      return jsonResponse({ books: result.results }, 200, CORS_HEADERS);
    }

    // Health check
    if (path === '/health') {
      return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
    }

    return jsonResponse({ error: 'Not found' }, 404, CORS_HEADERS);
  },

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
