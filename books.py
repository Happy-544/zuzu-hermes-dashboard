"""Zuzu's library: search Project Gutenberg (70,000+ free, legal e-books), read page by page,
listen, and get a spoken brief of any book.
"""
import json
import pathlib
import re
import threading
import urllib.parse
import urllib.request

import runtime

ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / "books"
STATE = ROOT / "books.json"
LOCK = threading.RLock()
API = "https://gutendex.com/books/"
PAGE_CHARS = 3500


def _get(url, timeout=15, limit=12_000_000):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 Zuzu/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read(limit)


def _book(item):
    formats = item.get("formats", {})
    text_url = next((u for k, u in formats.items() if k.startswith("text/plain") and not u.endswith(".zip")), "")
    return {"id": item.get("id"), "title": item.get("title", "Untitled"),
            "authors": ", ".join(a.get("name", "") for a in item.get("authors", [])),
            "languages": item.get("languages", []), "downloads": item.get("download_count", 0),
            "cover": formats.get("image/jpeg", ""), "subjects": item.get("subjects", [])[:4],
            "readable": bool(text_url), "text_url": text_url}


def search(query="", topic="", language=""):
    params = {}
    if query:
        params["search"] = str(query)[:120]
    if topic:
        params["topic"] = str(topic)[:60]
    if language:
        params["languages"] = re.sub(r"[^a-z,]", "", str(language).lower())[:20]
    data = json.loads(_get(API + ("?" + urllib.parse.urlencode(params) if params else "")))
    return [_book(item) for item in data.get("results", [])[:32]]


def _meta(book_id):
    return _book(json.loads(_get(f"{API}{int(book_id)}")))


def _strip_gutenberg(text):
    start = re.search(r"\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG.*?\*\*\*", text, re.I)
    end = re.search(r"\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG", text, re.I)
    return text[start.end() if start else 0: end.start() if end else len(text)].strip()


def paginate(text, size=PAGE_CHARS):
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text.replace("\r\n", "\n")) if p.strip()]
    pages, current = [], ""
    for para in paragraphs:
        para = re.sub(r"[ \t]*\n[ \t]*", " ", para)
        if current and len(current) + len(para) > size:
            pages.append(current)
            current = ""
        current = f"{current}\n\n{para}" if current else para
    if current:
        pages.append(current)
    return pages or [""]


def load_book(book_id):
    book_id = int(book_id)
    CACHE.mkdir(exist_ok=True)
    cached = CACHE / f"{book_id}.json"
    if cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))
    meta = _meta(book_id)
    if not meta["text_url"]:
        raise ValueError("This book has no plain-text edition to read")
    text = _strip_gutenberg(_get(meta["text_url"]).decode("utf-8", "replace"))
    book = {**meta, "pages": paginate(text), "chars": len(text)}
    cached.write_text(json.dumps(book, ensure_ascii=False), encoding="utf-8")
    return book


def _progress():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def page(book_id, number=None):
    book = load_book(book_id)
    with LOCK:
        progress = _progress()
        if number is None:
            number = progress.get(str(book_id), {}).get("page", 0)
        number = max(0, min(int(number), len(book["pages"]) - 1))
        progress[str(book_id)] = {"page": number, "title": book["title"], "authors": book["authors"],
                                  "cover": book["cover"], "pages": len(book["pages"])}
        STATE.write_text(json.dumps(progress, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"id": book["id"], "title": book["title"], "authors": book["authors"], "cover": book["cover"],
            "page": number, "pages": len(book["pages"]), "text": book["pages"][number], "brief": book.get("brief")}


def shelf():
    return [{"id": int(k), **v} for k, v in _progress().items()]


def brief(book_id, language="English"):
    book = load_book(book_id)
    if book.get("brief"):
        return book["brief"]
    key = runtime.gemini_api_key()
    if not key:
        raise RuntimeError("A Gemini API key is needed for book briefs")
    text = "\n\n".join(book["pages"])[:600_000]
    prompt = (f"You are Zuzu, briefing a book for a busy listener in {language}. Book: {book['title']} by {book['authors']}.\n"
              "Give: 1) the story or core idea in 5 short sentences, 2) main characters or key concepts, "
              "3) the 3 best lessons or moments, 4) who will enjoy it and how long it takes to read. "
              "Plain text, no markdown symbols, warm and spoken-friendly.\n\nBOOK TEXT:\n" + text)
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.5, "maxOutputTokens": 900}}
    url = ("https://generativelanguage.googleapis.com/v1beta/models/" + urllib.parse.quote(runtime.GEMINI_MODEL or "gemini-2.5-flash", safe="-.")
           + ":generateContent")
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "x-goog-api-key": key})
    with urllib.request.urlopen(req, timeout=120) as response:
        payload = json.loads(response.read())
    parts = (payload.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    summary = "".join(p.get("text", "") for p in parts).strip()
    if not summary:
        raise RuntimeError("Gemini returned no brief")
    book["brief"] = summary
    (CACHE / f"{book['id']}.json").write_text(json.dumps(book, ensure_ascii=False), encoding="utf-8")
    return summary
