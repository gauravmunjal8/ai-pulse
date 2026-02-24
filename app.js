/* ============================================================
   AI Pulse — Daily AI News  |  app.js
   Reads articles.json (generated daily by GitHub Actions + Claude)
   ============================================================ */

'use strict';

const CACHE_KEY = 'aipulse_v5';
const PAGE_SIZE = 15;

/* ── State ────────────────────────────────────────────────── */
let allArticles    = [];
let filtered       = [];
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
themeToggle.addEventListener('click', () =>
  applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark')
);

/* ── Helpers ──────────────────────────────────────────────── */
function renderDate() {
  headerDate.textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function timeAgo(dateStr) {
  if (!dateStr || dateStr === '1970-01-01T00:00:00Z') return '';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60)     return 'just now';
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800) return 'yesterday';
  return `${Math.floor(diff / 86400)}d ago`;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Filter logic ─────────────────────────────────────────── */
const FUNDING_WORDS = [
  'raises','raised','funding','series a','series b','series c','series d',
  'seed round','investment','venture','million','billion','ipo','unicorn',
  'valuation','secures','secured','backed','acquisition','acquires',
];

function matchesFilter(article, filter) {
  if (filter === 'all') return true;
  if (filter === 'funding') {
    if (article.category === 'funding') return true;
    const t = (article.title || '').toLowerCase();
    return FUNDING_WORDS.some(w => t.includes(w));
  }
  return article.category === filter;
}

/* ── Card builder ─────────────────────────────────────────── */
function buildCard(a) {
  const ago  = timeAgo(a.published_at);
  const tags = (a.tags || []).slice(0, 3);
  const el   = document.createElement('article');
  el.className = 'card';
  el.innerHTML = `
    <div class="card-meta">
      <span class="card-source">${esc(a.source || 'unknown')}</span>
      ${ago ? `<span class="card-time">${esc(ago)}</span>` : ''}
    </div>
    <a class="card-title" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>
    ${a.summary ? `<p class="card-summary">${esc(a.summary)}</p>` : ''}
    ${tags.length ? `<div class="card-tags">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="card-footer">
      <span class="card-points">▲ ${a.points || 0}</span>
      <span class="card-comments">💬 ${a.comments || 0}</span>
      <a class="card-link" href="${esc(a.url)}" target="_blank" rel="noopener">Read →</a>
    </div>`;
  return el;
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
  const slice = filtered.slice(displayedCount, displayedCount + PAGE_SIZE);
  slice.forEach(a => grid.appendChild(buildCard(a)));
  displayedCount += slice.length;
  loadMoreWrap.style.display = displayedCount < filtered.length ? '' : 'none';
}

function applyFilter(filter) {
  currentFilter  = filter;
  displayedCount = 0;
  filtered = allArticles.filter(a => matchesFilter(a, filter));
  grid.innerHTML = '';
  loadMoreWrap.style.display = 'none';

  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state"><div class="emoji">🔍</div><p>No articles found for this category yet.<br>Try another filter or check back after the next update.</p></div>`;
    articleCount.textContent = '0 articles';
    return;
  }
  renderPage();
  articleCount.textContent = `${filtered.length} article${filtered.length !== 1 ? 's' : ''}`;
}

/* ── Load articles.json ───────────────────────────────────── */
async function loadArticles() {
  showSkeletons();
  errorBanner.classList.add('hidden');
  articleCount.textContent = 'Loading…';
  lastUpdated.textContent  = '';

  try {
    // Cache-bust so we always get the latest version
    const res  = await fetch(`articles.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    allArticles = data.articles || [];

    if (allArticles.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="emoji">⏳</div>
          <p>Articles are being generated for the first time.<br>
             Please check back in a few minutes after the GitHub Action completes.</p>
        </div>`;
      articleCount.textContent = '0 articles';
      return;
    }

    const updatedAt = data.updated_at
      ? new Date(data.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    lastUpdated.textContent = updatedAt ? `Last updated: ${updatedAt}` : '';

    applyFilter(currentFilter);

  } catch (err) {
    console.error('Failed to load articles.json:', err);
    grid.innerHTML = `<div class="empty-state"><div class="emoji">📡</div><p>Could not load articles. Please refresh the page.</p></div>`;
    articleCount.textContent = '0 articles';
    errorMsg.textContent = 'Could not load articles.json — the daily update may still be running.';
    errorBanner.classList.remove('hidden');
  }
}

/* ── Events ───────────────────────────────────────────────── */
document.querySelectorAll('.filter-btn').forEach(btn =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyFilter(btn.dataset.query);
  })
);
loadMoreBtn.addEventListener('click', renderPage);

/* ── Boot ─────────────────────────────────────────────────── */
initTheme();
renderDate();
loadArticles();
