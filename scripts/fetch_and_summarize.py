#!/usr/bin/env python3
"""
Fetches the latest AI news from Dev.to and Hacker News,
generates summaries + categories using Claude, and writes articles.json.

Run daily via GitHub Actions.
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

import anthropic
import requests

DEVTO_API = "https://dev.to/api/articles"
HN_API    = "https://hn.algolia.com/api/v1/search"

# What to fetch per category bucket
FETCH_BUCKETS = [
    {"devto": ["artificial-intelligence", "machinelearning"], "hn": "artificial intelligence"},
    {"devto": ["llm", "gpt", "openai"],                       "hn": "large language model GPT"},
    {"devto": ["deeplearning", "datascience"],                 "hn": "machine learning research paper"},
    {"devto": ["startup", "venturecapital"],                   "hn": "AI startup funding raises million billion"},
    {"devto": ["robotics"],                                    "hn": "AI robotics autonomous"},
    {"devto": ["opensource", "huggingface"],                   "hn": "open source AI model"},
]

MAX_ARTICLES = 60   # cap before summarization
BATCH_SIZE   = 15   # articles per Claude call


# ── Fetchers ──────────────────────────────────────────────────────────────────

def fetch_devto(tags, per_page=20):
    results = []
    seen = set()
    for tag in tags:
        try:
            r = requests.get(
                f"{DEVTO_API}?tag={tag}&per_page={per_page}&top=7",
                timeout=15
            )
            r.raise_for_status()
            for a in r.json():
                if a.get("id") and a.get("title") and a["id"] not in seen:
                    seen.add(a["id"])
                    results.append({
                        "id":           f"devto-{a['id']}",
                        "title":        a["title"].strip(),
                        "description":  (a.get("description") or "")[:400].strip(),
                        "url":          a.get("url", ""),
                        "source":       "dev.to",
                        "points":       a.get("positive_reactions_count", 0),
                        "comments":     a.get("comments_count", 0),
                        "published_at": a.get("published_at", ""),
                    })
        except Exception as e:
            print(f"  [warn] Dev.to tag={tag}: {e}", file=sys.stderr)
    return results


def fetch_hn(query, hits=20):
    try:
        r = requests.get(
            f"{HN_API}?query={requests.utils.quote(query)}&tags=story&hitsPerPage={hits}",
            timeout=15
        )
        r.raise_for_status()
        results = []
        for h in r.json().get("hits", []):
            if not h.get("title"):
                continue
            url = h.get("url") or f"https://news.ycombinator.com/item?id={h['objectID']}"
            try:
                source = url.split("/")[2].replace("www.", "")
            except Exception:
                source = "news.ycombinator.com"
            results.append({
                "id":           f"hn-{h['objectID']}",
                "title":        h["title"].strip(),
                "description":  "",
                "url":          url,
                "source":       source,
                "points":       h.get("points", 0),
                "comments":     h.get("num_comments", 0),
                "published_at": h.get("created_at", ""),
            })
        return results
    except Exception as e:
        print(f"  [warn] HN query='{query}': {e}", file=sys.stderr)
        return []


def deduplicate(articles):
    seen_ids     = set()
    seen_titles  = set()
    result       = []
    for a in articles:
        title_key = a["title"].lower()[:60]
        if a["id"] not in seen_ids and title_key not in seen_titles:
            seen_ids.add(a["id"])
            seen_titles.add(title_key)
            result.append(a)
    return result


# ── Summarisation ─────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an expert AI news editor. Your job is to write concise,
insightful summaries of AI news articles for a tech-savvy audience."""

def build_user_prompt(articles):
    lines = []
    for i, a in enumerate(articles):
        entry = f"[{i}] {a['title']}"
        if a.get("description"):
            entry += f"\n    Info: {a['description']}"
        lines.append(entry)

    return f"""\
Summarise each of the {len(articles)} AI news articles below.

Return ONLY a valid JSON array (no markdown, no extra text) with one object per article:
{{
  "summary":  "2-3 sentences. Sentence 1: what happened. Sentences 2-3: why it matters / implications.",
  "category": one of: llm | research | openai | google | robotics | opensource | funding | all,
  "tags":     array of 1-3 strings from: LLM | Research | Open Source | Robotics | Image/Video | Safety | Funding | Acquisition | Business | Agent
}}

Articles:
{chr(10).join(lines)}"""


def summarise_batch(articles, client):
    prompt = build_user_prompt(articles)
    resp = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = resp.content[0].text.strip()

    # Strip markdown fences if Claude wraps the JSON
    if raw.startswith("```"):
        raw = raw.split("```", 2)[1]
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip()

    return json.loads(raw)


def attach_summaries(articles, client):
    enriched = []
    total    = len(articles)

    for start in range(0, total, BATCH_SIZE):
        batch = articles[start:start + BATCH_SIZE]
        end   = start + len(batch)
        print(f"  Summarising articles {start + 1}–{end} of {total}…")

        try:
            results = summarise_batch(batch, client)
            for j, article in enumerate(batch):
                meta = results[j] if j < len(results) else {}
                article["summary"]  = meta.get("summary", "")
                article["category"] = meta.get("category", "all")
                article["tags"]     = meta.get("tags", [])
                enriched.append(article)
        except Exception as e:
            print(f"  [warn] Summarisation batch {start}–{end} failed: {e}", file=sys.stderr)
            for article in batch:
                article["summary"]  = ""
                article["category"] = "all"
                article["tags"]     = []
                enriched.append(article)

        # Brief pause between batches to be polite to the API
        if end < total:
            time.sleep(1)

    return enriched


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)

    # 1. Fetch
    print("Fetching articles…")
    raw = []
    for bucket in FETCH_BUCKETS:
        raw.extend(fetch_devto(bucket["devto"], per_page=15))
        raw.extend(fetch_hn(bucket["hn"], hits=15))

    articles = deduplicate(raw)
    articles.sort(key=lambda a: a.get("points", 0), reverse=True)
    articles = articles[:MAX_ARTICLES]
    print(f"Collected {len(articles)} unique articles.")

    # 2. Summarise
    print("Generating summaries with Claude…")
    articles = attach_summaries(articles, client)

    # 3. Write output
    output = {
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count":      len(articles),
        "articles":   articles,
    }

    out_path = os.path.join(os.path.dirname(__file__), "..", "articles.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Done. Wrote {len(articles)} articles to articles.json.")


if __name__ == "__main__":
    main()
