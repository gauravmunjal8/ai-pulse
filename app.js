/* ============================================================
   AI Pulse — Daily AI News  |  app.js
   ============================================================
   Data source: Hacker News via Algolia Search API
   Endpoint:    https://hn.algolia.com/api/v1/search
   No API key required. Free, CORS-enabled.
   ============================================================ */

'use strict';

/* ── Constants ────────────────────────────────────────────── */
const HN_API   = 'https://hn.algolia.com/api/v1/search';
const CACHE_KEY   = 'aipulse_cache_v2';
const CACHE_TTL   = 60 * 60 * 1000; // 1 hour in ms (refresh cap)
const PAGE_SIZE   = 18;              // articles per "page"
const MAX_RESULTS = 60;

// Topics used for the category filter buttons
const TOPIC_QUERIES = {
  all:       'artificial intelligence OR machine learning OR LLM OR GPT OR neural network',
  llm:       'LLM large language model ChatGPT Claude GPT',
  research:  'AI research machine learning paper arxiv',
  openai:    'OpenAI GPT ChatGPT Sora',
  google:    'Google DeepMind Gemini Bard',
  robotics:  'AI robotics autonomous robot',
  opensource: 'open source AI model Llama Mistral HuggingFace',
};

// Keywords used to auto-tag cards
const TAG_MAP = [
  { tag: 'LLM',       words: ['llm','language model','gpt','chatgpt','claude','gemini','mistral','llama'] },
  { tag: 'Research',  words: ['research','paper','arxiv','study','benchmark'] },
  { tag: 'Open Source', words: ['open source','open-source','huggingface','ollama','llama','mistral'] },
  { tag: 'Robotics',  words: ['robot','robotic','autonomous','drone'] },
  { tag: 'Image/Video', words: ['image','video','diffusion','sora','midjourney','stable diffusion','dall-e'] },
  { tag: 'Safety',    words: ['safety','alignment','bias','ethics','regulation'] },
  { tag: 'Business',  words: ['startup','funding','valuation','acquisition','revenue','raises'] },
];

/* ── State ────────────────────────────────────────────────── */
let allArticles     = [];   // full deduped list for current filter
let displayedCount  = 0;
let currentFilter   = 'all';

/* ── DOM refs ─────────────────────────────────────────────── */
const grid          = document.getElementById('articleGrid');
const statsBar      = document.getElementById('statsBar');
const articleCount  = document.getElementById('articleCount');
const lastUpdated   = document.getElementById('lastUpdated');
const loadMoreWrap  = document.getElementById('loadMoreWrap');
const loadMoreBtn   = document.getElementById('loadMoreBtn');
const errorBanner   = document.getElementById('errorBanner');
const errorMsg      = document.getElementById('errorMsg');
const themeToggle   = document.getElementById('themeToggle');
const themeIcon     = themeToggle.querySelector('.theme-icon');
const headerDate    = document.getElementById('headerDate');
const filterBtns    = document.querySelectorAll('.filter-btn');

/* ── Theme ────────────────────────────────────────────────── */
function initTheme() {
  const saved = localStorage.getItem('aipulse_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  applyTheme(theme);
}

function applyTheme(theme) {
  document.body.classList.remove('dark','light');
  document.body.classList.add(theme);
  themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('aipulse_theme', theme);
}

themeToggle.addEventListener('click', () => {
  const isDark = document.body.classList.contains('dark');
  applyTheme(isDark ? 'light' : 'dark');
});

/* ── Date display ─────────────────────────────────────────── */
function renderDate() {
  const now = new Date();
  headerDate.textContent = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

/* ── Relative time ────────────────────────────────────────── */
function timeAgo(unixSeconds) {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60)                   return 'just now';
  if (diff < 3600)                 return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)                return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 2)            return 'yesterday';
  return `${Math.floor(diff / 86400)}d ago`;
}

/* ── Domain extraction ────────────────────────────────────── */
function extractDomain(url) {
  if (!url) return 'news.ycombinator.com';
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.length > 26 ? host.slice(0, 24) + '…' : host;
  } catch { return 'link'; }
}

/* ── Auto-tagging ─────────────────────────────────────────── */
function getTags(title) {
  const lower = title.toLowerCase();
  return TAG_MAP
    .filter(({ words }) => words.some(w => lower.includes(w)))
    .map(({ tag }) => tag)
    .slice(0, 3); // max 3 tags
}

/* ── Fetch from HN Algolia ────────────────────────────────── */
async function fetchHN(query, daysBack = 1) {
  const since = Math.floor(Date.now() / 1000) - daysBack * 86400;
  const params = new URLSearchParams({
    query,
    tags: 'story',
    hitsPerPage: 50,
    numericFilters: `created_at_i>${since},points>5`,
    attributesToRetrieve: 'title,url,points,num_comments,created_at_i,objectID,author',
  });

  const res = await fetch(`${HN_API}?${params}`);
  if (!res.ok) throw new Error(`HN API ${res.status}`);
  const data = await res.json();
  return data.hits || [];
}

/* ── Multi-query fetch + dedup + sort ─────────────────────── */
async function fetchArticles(filter) {
  const query = TOPIC_QUERIES[filter] || TOPIC_QUERIES.all;

  // Try last 24 h, then fall back to last 3 days if sparse
  let hits = await fetchHN(query, 1);
  if (hits.length < 5) {
    hits = await fetchHN(query, 3);
  }

  // Deduplicate by objectID
  const seen = new Set();
  const unique = hits.filter(h => {
    if (seen.has(h.objectID)) return false;
    seen.add(h.objectID);
    return true;
  });

  // Sort by points descending
  unique.sort((a, b) => (b.points || 0) - (a.points || 0));

  return unique.slice(0, MAX_RESULTS);
}

/* ── Cache helpers ────────────────────────────────────────── */
function saveCache(filter, articles) {
  try {
    const entry = { ts: Date.now(), filter, articles };
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    cache[filter] = entry;
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch { /* storage full — ignore */ }
}

function loadCache(filter) {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    const entry = cache[filter];
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) return null;
    return entry.articles;
  } catch { return null; }
}

/* ── Build a card element ─────────────────────────────────── */
function buildCard(article) {
  const {
    title = 'Untitled',
    url,
    points = 0,
    num_comments: comments = 0,
    created_at_i,
    objectID,
  } = article;

  const href     = url || `https://news.ycombinator.com/item?id=${objectID}`;
  const hnLink   = `https://news.ycombinator.com/item?id=${objectID}`;
  const domain   = extractDomain(url);
  const ago      = timeAgo(created_at_i);
  const tags     = getTags(title);

  const card = document.createElement('article');
  card.className = 'card';

  card.innerHTML = `
    <div class="card-meta">
      <span class="card-source" title="${domain}">${domain}</span>
      <span class="card-time">${ago}</span>
    </div>
    <a class="card-title" href="${href}" target="_blank" rel="noopener noreferrer">${escapeHTML(title)}</a>
    ${tags.length ? `<div class="card-tags">${tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>` : ''}
    <div class="card-footer">
      <span class="card-points">▲ ${points}</span>
      <a href="${hnLink}" class="card-comments" target="_blank" rel="noopener noreferrer" title="Discuss on Hacker News">
        💬 ${comments}
      </a>
      <a class="card-link" href="${href}" target="_blank" rel="noopener noreferrer">
        Read <span>→</span>
      </a>
    </div>
  `;

  return card;
}

/* ── Render next page of articles ─────────────────────────── */
function renderPage() {
  const slice = allArticles.slice(displayedCount, displayedCount + PAGE_SIZE);
  slice.forEach(article => grid.appendChild(buildCard(article)));
  displayedCount += slice.length;
  loadMoreWrap.style.display = displayedCount < allArticles.length ? '' : 'none';
}

/* ── Main load function ───────────────────────────────────── */
async function loadArticles(filter = 'all', forceRefresh = false) {
  currentFilter = filter;
  displayedCount = 0;

  // Clear grid (keep or add skeletons)
  grid.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const sk = document.createElement('div');
    sk.className = 'card skeleton';
    grid.appendChild(sk);
  }

  loadMoreWrap.style.display = 'none';
  articleCount.textContent = 'Loading articles…';
  lastUpdated.textContent = '';
  errorBanner.classList.add('hidden');

  // Try cache first
  const cached = !forceRefresh && loadCache(filter);
  if (cached) {
    allArticles = cached;
    finishRender(true);
    return;
  }

  try {
    allArticles = await fetchArticles(filter);
    saveCache(filter, allArticles);
    finishRender(false);
  } catch (err) {
    console.error('Fetch error:', err);
    const cached = loadCache(filter);
    if (cached) {
      allArticles = cached;
      showError('Could not fetch fresh data — showing cached articles.');
      finishRender(true);
    } else {
      showError('Could not load articles. Check your connection and try again.');
      grid.innerHTML = `
        <div class="empty-state">
          <div class="emoji">📡</div>
          <p>Unable to fetch articles right now.</p>
        </div>`;
      articleCount.textContent = '0 articles';
    }
  }
}

function finishRender(fromCache) {
  grid.innerHTML = '';
  if (allArticles.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="emoji">🔍</div>
        <p>No articles found for this filter — try another category.</p>
      </div>`;
    articleCount.textContent = '0 articles';
    return;
  }

  renderPage();

  const label = `${allArticles.length} article${allArticles.length !== 1 ? 's' : ''}`;
  articleCount.textContent = label;
  lastUpdated.textContent = fromCache ? 'from cache' : `updated ${new Date().toLocaleTimeString()}`;
}

/* ── Error display ────────────────────────────────────────── */
function showError(msg) {
  errorMsg.textContent = msg;
  errorBanner.classList.remove('hidden');
}

/* ── HTML escape ──────────────────────────────────────────── */
function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── Event listeners ──────────────────────────────────────── */
filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadArticles(btn.dataset.query);
  });
});

loadMoreBtn.addEventListener('click', renderPage);

/* ── Auto-refresh every hour ──────────────────────────────── */
function scheduleRefresh() {
  setInterval(() => {
    loadArticles(currentFilter, true);
    renderDate();
  }, CACHE_TTL);
}

/* ── Init ─────────────────────────────────────────────────── */
initTheme();
renderDate();
loadArticles('all');
scheduleRefresh();
