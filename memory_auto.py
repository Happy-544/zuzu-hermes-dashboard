"""Zuzu learns about you on her own.

After each chat or voice turn the page sends the exchange here. Zuzu picks out lasting facts
about you (people, preferences, routines, dates, places, work, goals), then adds new memories,
updates ones that changed, merges duplicates and links related notes with [[Title]] and #tags.
Gemini does the reading when a key is set; simple English/Arabic patterns cover the rest.
Secrets (passwords, codes, card or account numbers) are never stored.
"""
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import personal
import runtime
import workspace

_RUN = threading.Semaphore(2)
SECRET = re.compile(
    r"pass(?:word|code|phrase)|\bpin\b|\botp\b|\bcvv\b|\biban\b|api[\s_-]?key|secret|token|credit card|card number|"
    r"كلمة (?:السر|المرور)|الباسورد|رقم (?:الكارت|البطاقة|الحساب)|\b\d{12,}\b|\b(?:\d{4}[ -]){3}\d{4}\b", re.I)
EXPLICIT = re.compile(r"(?:^|\b)(?:remember|save this|note this|don'?t forget|افتكري|احفظي|احفظ|خلي بالك|متنسيش)\s*(?:that\s+)?[:،,-]?\s*(.{4,})", re.I)
FORGET = re.compile(r"(?:^|\b)(?:forget|delete the memory|انسي|امسحي من الذاكرة)\s+(?:that\s+|about\s+)?(.{3,})", re.I)
PATTERNS = [   # (regex, label builder, value builder) — conservative fallback when Gemini is unavailable
    (re.compile(r"\bmy (wife|husband|son|daughter|mother|mom|father|dad|brother|sister|boss|friend|manager|partner)(?:'s name)? is ([^.,;!?]{2,60})", re.I),
     lambda m: m.group(1).capitalize(), lambda m: f"My {m.group(1).lower()} is {m.group(2).strip()}."),
    (re.compile(r"\bmy birthday is ([^.,;!?]{3,40})", re.I), lambda m: "My birthday", lambda m: f"Birthday: {m.group(1).strip()}."),
    (re.compile(r"\bi(?: am|'m) allergic to ([^.,;!?]{2,60})", re.I), lambda m: "Allergies", lambda m: f"Allergic to {m.group(1).strip()}."),
    (re.compile(r"\bi live in ([^.,;!?]{2,60})", re.I), lambda m: "Home city", lambda m: f"Lives in {m.group(1).strip()}."),
    (re.compile(r"\bi work (?:as|at) ([^.,;!?]{2,80})", re.I), lambda m: "Work", lambda m: f"Works {m.group(0).split(' ', 2)[2].strip()}."),
    (re.compile(r"\bcall me ([^.,;!?]{2,30})", re.I), lambda m: "Preferred name", lambda m: f"Likes to be called {m.group(1).strip()}."),
    (re.compile(r"\bi (?:really )?(?:love|prefer|like) ([^.,;!?]{3,80})", re.I), lambda m: "Likes", lambda m: f"Likes {m.group(1).strip()}."),
    (re.compile(r"(?:^|\s)اسمي ([^.,،!؟]{2,40})"), lambda m: "Name", lambda m: f"اسمي {m.group(1).strip()}"),
    (re.compile(r"(?:^|\s)(?:انا|أنا) (?:ساكن|عايش|ساكنة|عايشة) في ([^.,،!؟]{2,40})"), lambda m: "Home city", lambda m: f"ساكن في {m.group(1).strip()}"),
    (re.compile(r"(?:^|\s)(?:انا|أنا) (?:بحب|بموت في) ([^.,،!؟]{3,60})"), lambda m: "Likes", lambda m: f"بحب {m.group(1).strip()}"),
]


def enabled():
    return bool(personal.load()["settings"].get("autoMemory", True))


def _norm(s):
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def _label_from(text):
    owner = re.match(r"\s*(my|our)\s+([\w' -]{2,30}?)\s+(?:is|are|was|lives|works)\b", text, re.I)
    if owner:
        return f"{owner.group(1).capitalize()} {owner.group(2).strip()}"[:60]
    words = re.sub(r"[^\w\s'-]", " ", text).split()
    return " ".join(words[:5]).strip().capitalize()[:60] or "Note"


def safe(text):
    return not SECRET.search(str(text or ""))


QUESTION = re.compile(r"\?\s*$|؟\s*$|^(?:do|did|can|could|will|would) you\b|^(?:هل|انتي فاكرة|فاكرة)\b", re.I)


def heuristic_ops(user_text, explicit=False):
    """explicit=True returns only remember/forget commands; otherwise also the fact patterns."""
    text = str(user_text or "").strip()
    ops = []
    if QUESTION.search(text):
        return ops
    forget = FORGET.match(text)
    if forget:
        return [{"op": "forget", "match": forget.group(1).strip(" .")}]
    m = EXPLICIT.search(text)
    if m:
        value = m.group(1).strip(" .")
        ops.append({"op": "add", "label": _label_from(value), "value": value, "tags": []})
        return ops
    if explicit:
        return ops
    for regex, label, value in PATTERNS:
        hit = regex.search(text)
        if hit:
            ops.append({"op": "add", "label": label(hit), "value": value(hit), "tags": []})
    return ops[:3]


def _gemini(prompt):
    key = runtime.gemini_api_key()
    if not key:
        return None
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0.1, "maxOutputTokens": 800}}
    payload = None
    last_err = None
    for candidate in dict.fromkeys([runtime.GEMINI_MODEL or "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"]):
        url = ("https://generativelanguage.googleapis.com/v1beta/models/"
               + urllib.parse.quote(candidate, safe="-.") + ":generateContent")
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"content-type": "application/json", "x-goog-api-key": key})
        try:
            with urllib.request.urlopen(req, timeout=40) as response:
                payload = json.loads(response.read())
            break
        except urllib.error.HTTPError as exc:
            last_err = exc
            if exc.code not in (404, 400):
                raise
    if payload is None:
        if last_err is not None:
            raise last_err
        return None
    parts = (payload.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    return json.loads("".join(p.get("text", "") for p in parts) or "{}")


def ai_ops(user_text, assistant_text, memories):
    known = "\n".join(f"- id={m['id']} | {m['label']} | {m['value'][:180].replace(chr(10), ' ')}" for m in memories[-60:]) or "(none yet)"
    prompt = (
        "You maintain the personal long-term memory of Zuzu, a private voice assistant. Read the latest exchange and decide "
        "what lasting facts about the USER to store. Store only durable things useful weeks from now: people in their life and "
        "relationships, names, birthdays and dates, preferences and dislikes, routines, health notes they share, home/work, "
        "projects, goals, possessions, important decisions. Ignore small talk, one-off requests, questions, anything the "
        "assistant said that the user did not confirm, and any password, code, card, bank or ID number.\n"
        "If a fact changes or corrects an existing memory, UPDATE that memory (give its id and the full new value). "
        "If the same thing already exists, do nothing. Delete a memory only when the user clearly asks to forget it.\n"
        "Write short values in the user's language. Link related existing notes by writing [[Their exact label]] in the value, "
        "and give 1-3 lowercase tags (family, health, work, money, home, habits, hobby, people, travel, goals...).\n"
        'Reply JSON only: {"ops": [{"op": "add"|"update"|"delete", "id": "existing id for update/delete", '
        '"label": "2-5 word title", "value": "the fact", "tags": ["..."]}]} — at most 3 ops, or {"ops": []}.\n\n'
        f"EXISTING MEMORIES:\n{known}\n\nUSER SAID:\n{str(user_text)[:2000]}\n\nASSISTANT REPLIED:\n{str(assistant_text or '')[:1200]}"
    )
    answer = _gemini(prompt)
    if answer is None:
        return None
    ops = answer.get("ops") if isinstance(answer, dict) else answer
    return [o for o in (ops or []) if isinstance(o, dict)][:3]


def apply_ops(ops, source="chat"):
    """Apply add/update/delete/forget ops to the workspace memory. Returns a list of change notes."""
    changes = []
    with workspace.LOCK:
        data = workspace.load()
        memories = data.setdefault("memory", [])
        by_id = {m["id"]: m for m in memories}
        for op in ops:
            kind = str(op.get("op", "")).lower()
            label = str(op.get("label", "")).strip()[:100]
            value = str(op.get("value", "")).strip()[:4000]
            tags = workspace.clean_tags(op.get("tags") or [])
            if kind in {"add", "update"} and (not value or not safe(value) or not safe(label)):
                continue
            if kind == "forget":
                words = [w for w in re.findall(r"[^\W_]{2,}", _norm(op.get("match"))) if w not in {"the", "my", "a", "an", "about", "that"}]
                hit = next((m for m in memories if words and all(w in _norm(f"{m['label']} {m['value']}") for w in words)), None)
                if hit:
                    memories.remove(hit); changes.append(f"Forgot: {hit['label']}")
                continue
            if kind == "delete":
                hit = by_id.get(str(op.get("id", "")))
                if hit:
                    memories.remove(hit); changes.append(f"Forgot: {hit['label']}")
                continue
            target = by_id.get(str(op.get("id", ""))) if kind == "update" else None
            if target is None:   # same title already stored? then it is an update, not a duplicate
                target = next((m for m in memories if _norm(m["label"]) == _norm(label)), None)
            if target is not None:
                if _norm(value) in _norm(target["value"]):
                    continue
                history = target.setdefault("history", [])
                history.append({"value": target["value"], "at": time.time()}); del history[:-3]
                target["value"] = value
                if label:
                    target["label"] = label
                target["tags"] = workspace.clean_tags((target.get("tags") or []) + tags)
                target["updated"] = time.time(); target["source"] = source
                changes.append(f"Updated: {target['label']}")
                continue
            if any(_norm(value) == _norm(m["value"]) for m in memories):
                continue
            memory = {"id": uuid.uuid4().hex[:10], "label": label or _label_from(value), "value": value, "tags": tags,
                      "created": time.time(), "auto": True, "source": source}
            memories.append(memory); by_id[memory["id"]] = memory
            changes.append(f"Saved: {memory['label']}")
        tidy(memories)
        if changes:
            workspace.save(data)
    return changes


def tidy(memories):
    """Merge exact duplicates (same title and text), keeping the oldest."""
    seen, keep = set(), []
    for m in memories:
        key = (_norm(m.get("label")), _norm(m.get("value")))
        if key in seen:
            continue
        seen.add(key); keep.append(m)
    memories[:] = keep


def observe(user_text, assistant_text="", source="chat"):
    """Learn from one exchange. Safe to call for every turn; returns the list of changes."""
    user_text = str(user_text or "").strip()
    if not user_text or user_text.startswith("/") or not enabled():
        return []
    forced = heuristic_ops(user_text, explicit=True)       # "remember …" / "forget …"
    if forced and forced[0]["op"] == "forget":
        ops = forced
    else:
        try:
            ops = ai_ops(user_text, assistant_text, workspace.load().get("memory", []))
        except Exception:  # noqa: BLE001 - a failed call must never break chat
            ops = None
        if ops is None:
            ops = heuristic_ops(user_text)
        elif not ops and forced:                            # the user asked explicitly; keep it
            ops = forced
    changes = apply_ops(ops, source=source)
    if changes:
        personal.announce("memory", " · ".join(changes)[:220], {"changes": changes}, telegram=False)
    return changes


def observe_async(user_text, assistant_text="", source="chat"):
    def work():
        with _RUN:
            observe(user_text, assistant_text, source)
    threading.Thread(target=work, daemon=True).start()
