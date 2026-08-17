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
  const today = new Date().toISOString().slice(0, 10);

  // Check if we already have a book picked for today
  const cached = await env.DB.prepare(
    'SELECT title, author, topic, description, affiliate_link, cover_link FROM daily_book_cache WHERE date = ?'
  ).bind(today).first();

  if (cached) {
    return sanitizeBook({
      title: cached.title,
      author: cached.author,
      topic: cached.topic,
      description: cached.description,
      cover_link: cached.cover_link,
      affiliate_link: cached.affiliate_link,
    });
  }

  // No book for today yet — pick a random one from the books table
  const count = await env.DB.prepare('SELECT COUNT(*) as cnt FROM books').first();
  if (!count || count.cnt === 0) {
    return null;
  }

  const book = await env.DB.prepare(
    'SELECT title, author, topic, description, affiliate_link, cover_link FROM books ORDER BY RANDOM() LIMIT 1'
  ).first();

  if (!book) return null;

  // Cache it for today so all visitors see the same book
  await env.DB.prepare(
    'INSERT OR REPLACE INTO daily_book_cache (date, title, author, topic, description, affiliate_link, cover_link) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(today, book.title, book.author, book.topic, book.description, book.affiliate_link, book.cover_link).run();

  return sanitizeBook({
    title: book.title,
    author: book.author,
    topic: book.topic,
    description: book.description,
    cover_link: book.cover_link,
    affiliate_link: book.affiliate_link,
  });
}

/**
 * Get a book matching one of the subscriber's interests.
 * Falls back to a random book if no topic match.
 */
async function getBookForInterests(env, interests) {
  // Collect all books whose topic matches any of the subscriber's interests
  const matched = [];
  for (const interest of interests) {
    const result = await env.DB.prepare(
      'SELECT title, author, topic, description, affiliate_link, cover_link FROM books WHERE LOWER(topic) = LOWER(?)'
    ).bind(interest.toLowerCase()).all();
    if (result.results && result.results.length > 0) {
      matched.push(...result.results);
    }
  }
  // Pick one at random from all matches
  if (matched.length > 0) {
    const book = matched[Math.floor(Math.random() * matched.length)];
    return sanitizeBook({
      title: book.title,
      author: book.author,
      topic: book.topic,
      description: book.description,
      cover_link: book.cover_link,
      affiliate_link: book.affiliate_link,
    });
  }
  // Fallback: random book
  const book = await env.DB.prepare(
    'SELECT title, author, topic, description, affiliate_link, cover_link FROM books ORDER BY RANDOM() LIMIT 1'
  ).first();
  if (!book) return null;
  return sanitizeBook({
    title: book.title,
    author: book.author,
    topic: book.topic,
    description: book.description,
    cover_link: book.cover_link,
    affiliate_link: book.affiliate_link,
  });
}

/**
 * Sanitize untrusted text for safe HTML insertion.
 *
 * Approach: escape EVERYTHING first, then selectively un-escape a tiny
 * allowlist of formatting tags the LLM might reasonably produce.
 * Anything else (<script>, <img onerror=…>, <a href=javascript:…>, etc.)
 * stays escaped and renders as visible, harmless text.
 */
const SAFE_TAG_PATTERN = /&lt;\/?(b|i|em|strong|br|p)\s*&gt;/gi;

function sanitizeText(text) {
  if (!text) return '';
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  // Re-enable only the allowlisted tags
  return escaped.replace(SAFE_TAG_PATTERN, (match) =>
    match.toLowerCase().replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  );
}

/**
 * Validate that a URL is safe for use in href or src.
 * Only allows http:// and https:// protocols — blocks javascript:, data:, etc.
 */
function safeUrl(url) {
  const u = String(url || '').trim();
  if (/^https?:\/\//i.test(u)) return u;
  return '#';
}

/**
 * Sanitize all fields of a book object before returning to the API.
 * Escapes text fields, validates URLs.
 */
function sanitizeBook(book) {
  if (!book) return null;
  return {
    title: sanitizeText(book.title),
    author: sanitizeText(book.author),
    topic: sanitizeText(book.topic),
    why: sanitizeText(book.description || book.why),
    cover: safeUrl(book.cover_link || book.cover),
    link: safeUrl(book.affiliate_link || book.link),
  };
}

// ─── Today's Brief (from cache) ───

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Constant-time string comparison to prevent timing attacks on auth tokens.
 * Always processes the full length of both strings.
 */
function timingSafeEqual(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  let result = sa.length ^ sb.length;
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const ca = i < sa.length ? sa.charCodeAt(i) : 0;
    const cb = i < sb.length ? sb.charCodeAt(i) : 0;
    result |= ca ^ cb;
  }
  return result === 0;
}

/**
 * Check admin auth. Returns true if authorized, false otherwise.
 */
function checkAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const providedToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN) return false;
  return timingSafeEqual(providedToken, env.ADMIN_TOKEN);
}

async function getTodaysBrief(env) {
  const today = new Date().toISOString().slice(0, 10);

  const result = await env.DB.prepare(
    "SELECT cache_key, result_json FROM brief_cache WHERE cache_key LIKE ? ORDER BY RANDOM() LIMIT 1"
  ).bind(`section|%|%|${today}`).first();

  if (!result) {
    return { html: null, topic: null };
  }

  const parts = result.cache_key.split('|');
  // Capitalize each word of the topic (cache stores it lowercased)
  const rawTopic = parts[1] || '';
  const topic = rawTopic
    ? rawTopic.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : "Today's Brief";

  const parsed = JSON.parse(result.result_json);

  let html = '';

  if (parsed.paragraph) {
    html += `<p style="margin:0 0 16px 0;font-size:0.9375rem;line-height:1.6;color:#1a1a1a;">${sanitizeText(parsed.paragraph)}</p>`;
  }

  const sources = parsed.sources || (parsed.searchResult && parsed.searchResult.sources) || [];

  if (sources.length > 0) {
    let sourcesHtml = 'Sources: ';
    sources.forEach((s, j) => {
      const num = j + 1;
      const url = safeUrl(s.url);
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
      if (!checkAuth(request, env)) {
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
      if (!checkAuth(request, env)) {
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
      if (!checkAuth(request, env)) {
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
    console.log('Website API cron tick — picking today\'s recommended book');
    const book = await getBookOfTheWeek(env);
    console.log('Today\'s book:', book ? book.title : 'none available');
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
