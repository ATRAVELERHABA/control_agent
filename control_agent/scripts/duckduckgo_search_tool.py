from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def load_ddgs() -> Any:
    try:
        from ddgs import DDGS  # type: ignore

        return DDGS
    except ImportError:
        try:
            from duckduckgo_search import DDGS  # type: ignore

            return DDGS
        except ImportError as exc:
            raise RuntimeError(
                "Missing dependency. Install `ddgs` (recommended) or `duckduckgo-search`."
            ) from exc


def normalize_result(item: dict[str, Any]) -> dict[str, str]:
    title = str(item.get("title") or item.get("heading") or "").strip()
    url = str(item.get("href") or item.get("url") or "").strip()
    snippet = str(
        item.get("body") or item.get("snippet") or item.get("description") or ""
    ).strip()

    if not title:
        title = url or "(no title)"

    return {
        "title": title,
        "url": url,
        "snippet": snippet,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", required=True)
    parser.add_argument("--max-results", type=int, default=5)
    args = parser.parse_args()

    query = args.query.strip()
    if not query:
        raise RuntimeError("Query cannot be empty.")

    max_results = max(1, min(10, int(args.max_results)))
    DDGS = load_ddgs()

    try:
        raw_results = list(DDGS().text(query, max_results=max_results))
    except Exception as exc:
        raise RuntimeError(f"DuckDuckGo search failed: {exc}") from exc

    normalized_results: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    for item in raw_results:
        normalized = normalize_result(item)
        url = normalized["url"]

        if not url or url in seen_urls:
            continue

        seen_urls.add(url)
        normalized_results.append(normalized)

    json.dump(
        {
            "query": query,
            "results": normalized_results,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
