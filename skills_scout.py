"""Zuzu looks for new Hermes skills that fit how you use her, and proposes them.

Nothing is installed without your approval: proposals wait in Brain > Skills (or you say
"install it" by voice, which the voice model must confirm with you first).
"""
import datetime
import json
import re
import urllib.parse
import urllib.request
import uuid

import catalog
import personal
import runtime
import workspace

DEFAULT_TOPICS = ["personal productivity", "music", "market data", "home automation"]


def _topics_from_context(limit=3):
    data = workspace.load()
    notes = [m.get("value", "") for m in data.get("memory", [])[-15:]]
    notes += [r.get("text", "") for r in personal.load().get("reminders", [])[-15:]]
    key = runtime.gemini_api_key()
    if key and any(notes):
        prompt = ("From these notes about a user, suggest 3 short search queries (2-4 words each) for new AI-assistant "
                  "skills or tools that would genuinely help them. Reply as a JSON list of strings only.\n\n" + "\n".join(notes)[:6000])
        body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0.4}}
        req = urllib.request.Request(
            "https://generativelanguage.googleapis.com/v1beta/models/" + urllib.parse.quote(runtime.GEMINI_MODEL or "gemini-2.5-flash", safe="-.") + ":generateContent",
            data=json.dumps(body).encode(), method="POST", headers={"content-type": "application/json", "x-goog-api-key": key})
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                parts = (json.loads(response.read()).get("candidates") or [{}])[0].get("content", {}).get("parts", [])
            topics = json.loads("".join(p.get("text", "") for p in parts))
            topics = [re.sub(r"[^\w\s-]", "", str(t))[:40] for t in topics if str(t).strip()]
            if topics:
                return topics[:limit]
        except Exception:  # noqa: BLE001
            pass
    return DEFAULT_TOPICS[:limit]


def proposals():
    return personal.load().get("skillProposals", [])


def _save_proposals(items):
    with personal.LOCK:
        data = personal._load()
        data["skillProposals"] = items[-40:]
        personal._save(data)


def scout(topic=None, search=catalog.search):
    """Search the Hermes skill registries and store new proposals. Returns the new ones."""
    topics = [str(topic).strip()[:80]] if topic and str(topic).strip() else _topics_from_context()
    existing = proposals()
    known = {p["identifier"] for p in existing}
    new = []
    for query in topics:
        try:
            results = search(query, "all")
        except (ValueError, RuntimeError, OSError):
            continue
        for item in results[:3]:
            if item["identifier"] in known:
                continue
            known.add(item["identifier"])
            new.append({"id": uuid.uuid4().hex[:8], "name": item.get("name") or item["identifier"],
                        "identifier": item["identifier"], "kind": item.get("kind", "skill"),
                        "source": item.get("source", ""), "trust": item.get("trust_level", ""),
                        "description": (item.get("description") or "")[:300], "reason": query, "status": "new",
                        "found": datetime.datetime.now().isoformat(timespec="minutes")})
            if len(new) >= 6:
                break
    if new:
        _save_proposals(existing + new)
    return new


def decide(proposal_id, approve):
    items = proposals()
    item = next((p for p in items if p["id"] == proposal_id), None)
    if item is None:
        raise ValueError("proposal not found")
    if approve:
        result = catalog.install(item["identifier"], item.get("kind", "skill"))
        item["status"] = "installed"
        item["detail"] = result.get("detail", "")[:300]
    else:
        item["status"] = "dismissed"
    _save_proposals(items)
    return item


def scout_tick(now=None):
    now = now or datetime.datetime.now()
    s = personal.load()["settings"]
    if not s.get("skillScout"):
        return
    last = personal.load().get("skillScoutAt")
    if last and now - datetime.datetime.fromisoformat(last) < datetime.timedelta(days=int(s.get("skillScoutDays", 7))):
        return
    with personal.LOCK:
        data = personal._load()
        data["skillScoutAt"] = now.isoformat(timespec="minutes")
        personal._save(data)
    found = scout()
    if found:
        names = ", ".join(p["name"] for p in found[:3])
        personal.announce("skills", f"I found {len(found)} new skills that could help: {names}. "
                                    "Open Brain, Skills to approve or dismiss them.")
