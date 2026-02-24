/* ============================================================
   AI Pulse — Daily AI News  |  app.js
   Primary:   dev.to public API  (no key, CORS-enabled)
   Secondary: HN Algolia API     (no key, CORS-enabled)
   ============================================================ */

'use strict';

const DEVTO_API = 'https://dev.to/api/articles';
const HN_API    = 'https://hn.algolia.com/api/v1/search';
const CACHE_KEY = 'aipulse_v4';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const PAGE_SIZE = 18;

/* ── Filter definitions ───────────────────────────────────── */
// Each filter maps to Dev.to tags + an HN search query
const FILTERS = {
  all:        { devto: ['artificial-intelligence', 'machinelearning', 'llm'], hn: 'artificial intelligence' },
  llm:        { devto: ['llm', 'gpt', 'openai'],                             hn: 'large language model' },
  research:   { devto: ['deeplearning', 'machinelearning', 'datascience'],   hn: 'machine learning research' },
  openai:     { devto: ['openai', 'chatgpt', 'gpt'],                        hn: 'OpenAI' },
  google:     { devto: ['googleai', 'gemini', 'tensorflow'],                 hn: 'Google DeepMind Gemini' },
  robotics:   { devto: ['robotics', 'ros'],                                  hn: 'AI robotics' },
  opensource: { devto: ['opensource', 'llm', 'huggingface'],                 hn: 'open source AI model' },
  funding:    { devto: ['startup', 'artificial-intelligence', 'machinelearning'], hn: 'AI startup funding raises million' },
};

// Keywords that identify a funding article
const FUNDING_KEYWORDS = [
  'raises', 'funding', 'raised', 'series a', 'series b', 'series c', 'series d',
  'seed round', 'investment', 'investor', 'venture', 'valuation', 'valued at',
  'million', 'billion', 'backed', 'round led', 'secures', 'secured', 'acqui',
  'ipo', 'unicorn', 'pre-seed', 'growth round', 'led by', 'capital',
];

/* ── Auto-tag map ─────────────────────────────────────────── */
const TAG_MAP = [
  { label: 'LLM',         words: ['llm','language model','gpt','chatgpt','claude','gemini','mistral','llama'] },
  { label: 'Research',    words: ['research','paper','arxiv','study','benchmark'] },
  { label: 'Open Source', words: ['open source','open-source','huggingface','llama','mistral','ollama'] },
  { label: 'Robotics',    words: ['robot','robotic','autonomous','drone'] },
  { label: 'Image/Video', words: ['image','video','diffusion','sora','midjourney','dall-e','stable diffusion'] },
  { label: 'Safety',      words: ['safety','alignment','bias','ethics','regulation'] },
  { label: 'Funding',     words: ['raises','raised','funding','series a','series b','series c','seed','investment','million','billion','ipo','unicorn','venture','valuation','backed'] },
  { label: 'Acquisition', words: ['acqui','acquired','acquisition','merger','buys','bought'] },
];

/* ── State ────────────────────────────────────────────────── */
let allArticles    = [];
let displayedCount = 0;
let currentFilter  = 'all';

/* ── DOM ──────────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const grid         = $('articleGrid');
const articleCount = $('articleCount');
const lastUpdated  = $('lastUpdated');
const loadMoreWrap = $('loadMoreWrap');
const loadMoreBtn  = $('loadMoreBtn');
const errorBanner  = $('errorBanner');
const errorMsg     = $('errorMsg');
const themeToggle  = $('themeToggle');
const themeIcon    = themeToggle.querySelector('.theme-icon');
const headerDate   = $('headerDate');

/* ── Theme ────────────────────────────────────────────────── */
function initTheme() {
  const saved = localStorage.getItem('aipulse_theme');
  const sys   = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(saved || sys);
}
function applyTheme(t) {
  document.body.className = t;
  themeIcon.textContent   = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('aipulse_theme', t);
}
themeToggle.addEventListener('click', () => {
  applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark');
});

/* ── Utilities ────────────────────────────────────────────── */
function renderDate() {
  headerDate.textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function timeAgo(dateStr) {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60)     return 'just now';
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800) return 'yesterday';
  return `${Math.floor(diff / 86400)}d ago`;
}

function timeAgoUnix(unix) {
  return timeAgo(new Date(unix * 1000).toISOString());
}

function parseDomain(url) {
  if (!url) return 'dev.to';
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h.length > 28 ? h.slice(0, 26) + '…' : h;
  } catch { return 'link'; }
}

function autoTags(title) {
  const low = (title || '').toLowerCase();
  return TAG_MAP.filter(({ words }) => words.some(w => low.includes(w)))
    .map(({ label }) => label).slice(0, 3);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Fetch: Dev.to ────────────────────────────────────────── */
async function fetchDevTo(tags) {
  const results = [];
  // Fetch each tag separately, in parallel
  const promises = tags.map(tag =>
    fetch(`${DEVTO_API}?tag=${encodeURIComponent(tag)}&per_page=30&top=7`)
      .then(r => r.ok ? r.json() : [])
      .catch(() => [])
  );
  const batches = await Promise.all(promises);
  const seen = new Set();
  for (const batch of batches) {
    for (const a of batch) {
      if (!seen.has(a.id) && a.title) {
        seen.add(a.id);
        results.push({
          id:       `devto-${a.id}`,
          title:    a.title,
          url:      a.url,
          source:   'dev.to',
          points:   a.positive_reactions_count || 0,
          comments: a.comments_count || 0,
          date:     a.published_at,
          dateStr:  timeAgo(a.published_at),
        });
      }
    }
  }
  return results;
}

/* ── Fetch: Hacker News (Algolia) ─────────────────────────── */
async function fetchHN(query) {
  try {
    // Simple query — no numericFilters to avoid encoding issues
    const url = `${HN_API}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=30`;
    const res  = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.hits || []).filter(h => h.title).map(h => ({
      id:       `hn-${h.objectID}`,
      title:    h.title,
      url:      h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      source:   parseDomain(h.url),
      points:   h.points || 0,
      comments: h.num_comments || 0,
      date:     new Date(h.created_at_i * 1000).toISOString(),
      dateStr:  timeAgoUnix(h.created_at_i),
    }));
  } catch { return []; }
}

/* ── Merge & deduplicate by title similarity ──────────────── */
function merge(devto, hn) {
  const seen  = new Set();
  const all   = [];
  const normalize = t => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

  for (const a of [...devto, ...hn]) {
    const key = normalize(a.title).slice(0, 60);
    if (!seen.has(key)) {
      seen.add(key);
      all.push(a);
    }
  }
  // Sort by points desc
  all.sort((a, b) => b.points - a.points);
  return all.slice(0, 80);
}

/* ── Cache ────────────────────────────────────────────────── */
function saveCache(filter, articles) {
  try {
    const store = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    store[filter] = { ts: Date.now(), articles };
    localStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch { /* quota exceeded */ }
}
function loadCache(filter) {
  try {
    const entry = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')[filter];
    if (!entry || Date.now() - entry.ts > CACHE_TTL) return null;
    return entry.articles;
  } catch { return null; }
}

/* ── Card builder ─────────────────────────────────────────── */
function buildCard(a) {
  const tags = autoTags(a.title);
  const el   = document.createElement('article');
  el.className = 'card';
  el.innerHTML = `
    <div class="card-meta">
      <span class="card-source" title="${esc(a.source)}">${esc(a.source)}</span>
      <span class="card-time">${esc(a.dateStr)}</span>
    </div>
    <a class="card-title" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>
    ${tags.length ? `<div class="card-tags">${tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>` : ''}
    <div class="card-footer">
      <span class="card-points">▲ ${a.points}</span>
      <span class="card-comments">💬 ${a.comments}</span>
      <a class="card-link" href="${esc(a.url)}" target="_blank" rel="noopener">Read →</a>
    </div>`;
  return el;
}

/* ── Render page ──────────────────────────────────────────── */
function renderPage() {
  const slice = allArticles.slice(displayedCount, displayedCount + PAGE_SIZE);
  slice.forEach(a => grid.appendChild(buildCard(a)));
  displayedCount += slice.length;
  loadMoreWrap.style.display = displayedCount < allArticles.length ? '' : 'none';
}

function showSkeletons() {
  grid.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const d = document.createElement('div');
    d.className = 'card skeleton';
    grid.appendChild(d);
  }
}

/* ── Main load ────────────────────────────────────────────── */
async function load(filter = 'all', force = false) {
  currentFilter  = filter;
  displayedCount = 0;
  loadMoreWrap.style.display = 'none';
  errorBanner.classList.add('hidden');
  showSkeletons();
  articleCount.textContent = 'Loading…';
  lastUpdated.textContent  = '';

  // Serve from cache if fresh
  const cached = !force && loadCache(filter);
  if (cached && cached.length > 0) {
    allArticles = cached;
    finish(true);
    return;
  }

  const cfg = FILTERS[filter] || FILTERS.all;

  try {
    // Fetch both sources in parallel
    const [devto, hn] = await Promise.all([
      fetchDevTo(cfg.devto),
      fetchHN(cfg.hn),
    ]);

    allArticles = merge(devto, hn);

    // For funding filter: keep only articles that mention funding keywords
    if (filter === 'funding') {
      allArticles = allArticles.filter(a =>
        FUNDING_KEYWORDS.some(kw => (a.title || '').toLowerCase().includes(kw))
      );
    }

    if (allArticles.length > 0) {
      saveCache(filter, allArticles);
      finish(false);
    } else {
      // Try broader fallback
      const fallback = await fetchDevTo(['artificial-intelligence']);
      allArticles = fallback;
      if (allArticles.length > 0) {
        finish(false);
        showError('Limited results for this filter — showing broader AI articles.');
      } else {
        grid.innerHTML = `<div class="empty-state"><div class="emoji">📡</div><p>Could not load articles. Please check your internet connection.</p></div>`;
        articleCount.textContent = '0 articles';
      }
    }
  } catch (err) {
    console.error('Load error:', err);
    const fb = loadCache(filter);
    if (fb && fb.length > 0) {
      allArticles = fb;
      showError('Network error — showing cached articles.');
      finish(true);
    } else {
      grid.innerHTML = `<div class="empty-state"><div class="emoji">📡</div><p>Failed to load. Please check your connection and refresh.</p></div>`;
      articleCount.textContent = '0 articles';
    }
  }
}

function finish(fromCache) {
  grid.innerHTML = '';
  if (!allArticles.length) {
    grid.innerHTML = `<div class="empty-state"><div class="emoji">🔍</div><p>No articles found. Try another category.</p></div>`;
    articleCount.textContent = '0 articles';
    return;
  }
  renderPage();
  const n = allArticles.length;
  articleCount.textContent = `${n} article${n !== 1 ? 's' : ''}`;
  lastUpdated.textContent  = fromCache ? 'cached' : `updated ${new Date().toLocaleTimeString()}`;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorBanner.classList.remove('hidden');
}

/* ── Events ───────────────────────────────────────────────── */
document.querySelectorAll('.filter-btn').forEach(btn =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    load(btn.dataset.query);
  })
);
loadMoreBtn.addEventListener('click', renderPage);

// Auto-refresh every hour
setInterval(() => { load(currentFilter, true); renderDate(); }, CACHE_TTL);

/* ── Boot ─────────────────────────────────────────────────── */
initTheme();
renderDate();
load('all');
