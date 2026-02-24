/* ============================================================
   AI Pulse — Daily AI News  |  app.js
   Data: Hacker News via Algolia Search API (free, no key)
   ============================================================ */

'use strict';

/* ── Config ───────────────────────────────────────────────── */
const HN_SEARCH   = 'https://hn.algolia.com/api/v1/search';
const CACHE_KEY   = 'aipulse_cache_v3';
const CACHE_TTL   = 60 * 60 * 1000; // 1 hour
const PAGE_SIZE   = 18;

// One clear query per filter (Algolia doesn't support OR clauses well)
const FILTER_QUERIES = {
  all:        ['artificial intelligence', 'machine learning', 'LLM', 'OpenAI'],
  llm:        ['large language model', 'LLM', 'ChatGPT', 'Claude AI', 'Gemini AI'],
  research:   ['AI research', 'machine learning paper', 'deep learning', 'neural network'],
  openai:     ['OpenAI', 'ChatGPT', 'GPT-4', 'Sora OpenAI'],
  google:     ['Google DeepMind', 'Gemini Google', 'Google AI'],
  robotics:   ['AI robotics', 'robot AI', 'autonomous robot'],
  opensource: ['open source AI', 'Llama AI', 'Mistral AI', 'HuggingFace'],
};

// Auto-tag keywords
const TAGS = [
  { label: 'LLM',        words: ['llm','language model','gpt','chatgpt','claude','gemini','mistral','llama'] },
  { label: 'Research',   words: ['research','paper','arxiv','study','benchmark','dataset'] },
  { label: 'Open Source',words: ['open source','open-source','huggingface','ollama','llama','mistral'] },
  { label: 'Robotics',   words: ['robot','robotic','autonomous','drone'] },
  { label: 'Image/Video',words: ['image','video','diffusion','sora','midjourney','stable diffusion','dall-e'] },
  { label: 'Safety',     words: ['safety','alignment','bias','ethics','regulation'] },
  { label: 'Business',   words: ['startup','funding','valuation','acquisition','revenue','raises','billion'] },
];

/* ── State ────────────────────────────────────────────────── */
let allArticles    = [];
let displayedCount = 0;
let currentFilter  = 'all';
let isLoading      = false;

/* ── DOM ──────────────────────────────────────────────────── */
const grid         = document.getElementById('articleGrid');
const articleCount = document.getElementById('articleCount');
const lastUpdated  = document.getElementById('lastUpdated');
const loadMoreWrap = document.getElementById('loadMoreWrap');
const loadMoreBtn  = document.getElementById('loadMoreBtn');
const errorBanner  = document.getElementById('errorBanner');
const errorMsg     = document.getElementById('errorMsg');
const themeToggle  = document.getElementById('themeToggle');
const themeIcon    = themeToggle.querySelector('.theme-icon');
const headerDate   = document.getElementById('headerDate');
const filterBtns   = document.querySelectorAll('.filter-btn');

/* ── Theme ────────────────────────────────────────────────── */
function initTheme() {
  const saved = localStorage.getItem('aipulse_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}
function applyTheme(t) {
  document.body.className = t;
  themeIcon.textContent = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('aipulse_theme', t);
}
themeToggle.addEventListener('click', () => {
  applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark');
});

/* ── Helpers ──────────────────────────────────────────────── */
function renderDate() {
  headerDate.textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function timeAgo(unix) {
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60)      return 'just now';
  if (s < 3600)    return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)   return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800)  return 'yesterday';
  return `${Math.floor(s / 86400)}d ago`;
}

function domain(url) {
  if (!url) return 'news.ycombinator.com';
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h.length > 28 ? h.slice(0, 26) + '…' : h;
  } catch { return 'link'; }
}

function getTags(title) {
  const t = title.toLowerCase();
  return TAGS.filter(({ words }) => words.some(w => t.includes(w)))
    .map(({ label }) => label).slice(0, 3);
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ── API ──────────────────────────────────────────────────── */
async function fetchOne(query, daysBack) {
  const since = Math.floor(Date.now() / 1000) - daysBack * 86400;

  // Build URL manually to ensure numericFilters is correctly formatted
  const url = new URL(HN_SEARCH);
  url.searchParams.set('query', query);
  url.searchParams.set('tags', 'story');
  url.searchParams.set('hitsPerPage', '30');
  // Pass numericFilters as two separate array params (Algolia array syntax)
  url.searchParams.append('numericFilters[]', `created_at_i>${since}`);
  url.searchParams.append('numericFilters[]', 'points>1');

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.hits || [];
}

async function fetchAll(filter) {
  const queries = FILTER_QUERIES[filter] || FILTER_QUERIES.all;
  const seen    = new Set();
  let   results = [];

  // Fetch queries in parallel (last 24 h)
  const batches = await Promise.allSettled(queries.map(q => fetchOne(q, 1)));

  for (const b of batches) {
    if (b.status === 'fulfilled') {
      for (const hit of b.value) {
        if (!seen.has(hit.objectID) && hit.title) {
          seen.add(hit.objectID);
          results.push(hit);
        }
      }
    }
  }

  // If sparse, try last 3 days
  if (results.length < 6) {
    const batches2 = await Promise.allSettled(queries.map(q => fetchOne(q, 3)));
    for (const b of batches2) {
      if (b.status === 'fulfilled') {
        for (const hit of b.value) {
          if (!seen.has(hit.objectID) && hit.title) {
            seen.add(hit.objectID);
            results.push(hit);
          }
        }
      }
    }
  }

  // Sort by points desc, cap at 80
  results.sort((a, b) => (b.points || 0) - (a.points || 0));
  return results.slice(0, 80);
}

/* ── Cache ────────────────────────────────────────────────── */
function saveCache(filter, articles) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    all[filter] = { ts: Date.now(), articles };
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* storage full */ }
}
function loadCache(filter) {
  try {
    const entry = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')[filter];
    if (!entry || Date.now() - entry.ts > CACHE_TTL) return null;
    return entry.articles;
  } catch { return null; }
}

/* ── Card ─────────────────────────────────────────────────── */
function buildCard(a) {
  const href   = a.url || `https://news.ycombinator.com/item?id=${a.objectID}`;
  const hnLink = `https://news.ycombinator.com/item?id=${a.objectID}`;
  const tags   = getTags(a.title || '');
  const card   = document.createElement('article');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-meta">
      <span class="card-source" title="${esc(domain(a.url))}">${esc(domain(a.url))}</span>
      <span class="card-time">${timeAgo(a.created_at_i)}</span>
    </div>
    <a class="card-title" href="${esc(href)}" target="_blank" rel="noopener">${esc(a.title || 'Untitled')}</a>
    ${tags.length ? `<div class="card-tags">${tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>` : ''}
    <div class="card-footer">
      <span class="card-points">▲ ${a.points || 0}</span>
      <a href="${esc(hnLink)}" class="card-comments" target="_blank" rel="noopener">💬 ${a.num_comments || 0}</a>
      <a class="card-link" href="${esc(href)}" target="_blank" rel="noopener">Read →</a>
    </div>`;
  return card;
}

/* ── Render ───────────────────────────────────────────────── */
function showSkeletons() {
  grid.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const d = document.createElement('div');
    d.className = 'card skeleton';
    grid.appendChild(d);
  }
}

function renderPage() {
  const slice = allArticles.slice(displayedCount, displayedCount + PAGE_SIZE);
  slice.forEach(a => grid.appendChild(buildCard(a)));
  displayedCount += slice.length;
  loadMoreWrap.style.display = displayedCount < allArticles.length ? '' : 'none';
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorBanner.classList.remove('hidden');
}

/* ── Load ─────────────────────────────────────────────────── */
async function load(filter = 'all', force = false) {
  if (isLoading) return;
  isLoading = true;
  currentFilter = filter;
  displayedCount = 0;
  loadMoreWrap.style.display = 'none';
  errorBanner.classList.add('hidden');
  showSkeletons();
  articleCount.textContent = 'Loading…';
  lastUpdated.textContent = '';

  const cached = !force && loadCache(filter);
  if (cached && cached.length > 0) {
    allArticles = cached;
    finish(true);
    isLoading = false;
    return;
  }

  try {
    allArticles = await fetchAll(filter);
    if (allArticles.length > 0) saveCache(filter, allArticles);
    finish(false);
  } catch (err) {
    console.error(err);
    const fb = loadCache(filter);
    if (fb && fb.length > 0) {
      allArticles = fb;
      showError('Could not reach server — showing cached articles.');
      finish(true);
    } else {
      grid.innerHTML = `<div class="empty-state"><div class="emoji">📡</div><p>Failed to load articles. Check your internet connection.</p></div>`;
      articleCount.textContent = '0 articles';
    }
  }
  isLoading = false;
}

function finish(fromCache) {
  grid.innerHTML = '';
  if (!allArticles.length) {
    grid.innerHTML = `<div class="empty-state"><div class="emoji">🔍</div><p>No articles found — try a different category.</p></div>`;
    articleCount.textContent = '0 articles';
    return;
  }
  renderPage();
  articleCount.textContent = `${allArticles.length} article${allArticles.length !== 1 ? 's' : ''}`;
  lastUpdated.textContent = fromCache ? 'cached' : `updated ${new Date().toLocaleTimeString()}`;
}

/* ── Events ───────────────────────────────────────────────── */
filterBtns.forEach(btn => btn.addEventListener('click', () => {
  filterBtns.forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  load(btn.dataset.query);
}));
loadMoreBtn.addEventListener('click', renderPage);

/* ── Auto-refresh every hour ──────────────────────────────── */
setInterval(() => { load(currentFilter, true); renderDate(); }, CACHE_TTL);

/* ── Boot ─────────────────────────────────────────────────── */
initTheme();
renderDate();
load('all');
