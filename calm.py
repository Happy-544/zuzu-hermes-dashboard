"""Calm mode: Zuzu as a gentle, supportive companion (not a licensed therapist).

Provides the soft-voice persona for Gemini Live, a text fallback, crisis detection with
UAE / Egypt help lines, and a private mood log (calm.json, never sent anywhere).
"""
import datetime
import json
import os
import pathlib
import re
import threading
import urllib.parse

import media
import workspace

ROOT = pathlib.Path(__file__).resolve().parent
FILE = ROOT / "calm.json"
LOCK = threading.Lock()
VOICES = {"Achernar": "Soft", "Vindemiatrix": "Gentle", "Sulafat": "Warm", "Enceladus": "Breathy", "Aoede": "Breezy"}
DEFAULT_VOICE = "Achernar"
HELP_LINES = [
    {"name": "UAE Mental Support Line (800 HOPE)", "number": "800 4673", "note": "8am–8pm, WhatsApp 12pm–12am"},
    {"name": "Abu Dhabi 800 SAKINA (24/7)", "number": "800 725462", "note": "psychological first aid"},
    {"name": "Istijaba (UAE)", "number": "800 1717", "note": "Arabic, English, French"},
    {"name": "Egypt mental health hotline (24/7)", "number": "16328", "note": "General Secretariat of Mental Health"},
    {"name": "Emergency", "number": "999 (UAE) · 123 (Egypt ambulance)", "note": "if you are in danger now"},
]
CRISIS = re.compile(
    r"\b(?:kill(?:ing)? myself|end (?:it|my life)|suicid\w*|self[- ]?harm|hurt(?:ing)? myself|cut(?:ting)? myself|"
    r"don'?t want to (?:live|be alive|wake up)|no reason to live|better off dead|want to die|overdose)\b|"
    r"انتحر|انتحار|اموت نفسي|أموت نفسي|اقتل نفسي|أقتل نفسي|مش عايز اعيش|مش عايزة اعيش|نفسي اموت|نفسي أموت|اأذي نفسي|أذي نفسي|اجرح نفسي",
    re.I)

PERSONA = """You are Zuzu in Calm mode: a warm, gentle, supportive companion for the user's wellbeing. You are not a licensed
therapist or doctor and you say so plainly if asked; you never diagnose, prescribe or give medication advice.

How you speak: softly and slowly, like a calm late-evening voice. Short sentences. Leave small pauses ("..."). Never rush,
never lecture. Mirror the user's language (Egyptian Arabic, Gulf Arabic or English) and use their name if you know it.

How you help (evidence-based, one step at a time):
- Listen first. Reflect back what you heard and name the feeling ("It sounds like you're exhausted and a bit let down").
- Ask one open question at a time. Let silence be okay.
- Offer, never force, a small practice when it fits: slow breathing (box 4-4-4-4, or 4-7-8), 5-4-3-2-1 grounding,
  a short body scan, noticing and reframing an unhelpful thought (CBT), accepting a feeling without fighting it (ACT),
  self-compassion ("what would you tell a friend?"), a tiny next step for tomorrow, sleep wind-down, gratitude.
- Use the calm tools when useful: start_breathing to guide breathing on screen, set_calm_scene to change the scenery or
  sound, log_mood when the user tells you how they feel, add_reminder for a kind follow-up.
- Advice is practical and personal: use what you know about the user's life from memory, but never pressure.
- End gently: a short summary of what they shared and one small kind thing to do next.

Safety (always): if the user mentions wanting to die, suicide, self-harm, harming someone, abuse, or being in danger,
stay calm and caring, take it seriously, ask if they are safe right now, and encourage them to contact a person now:
UAE 800 HOPE (800 4673), Abu Dhabi 800 SAKINA (800 725462), Istijaba 800 1717, Egypt hotline 16328, or emergency
999 in the UAE / 123 in Egypt. Suggest reaching a trusted person nearby. Do not continue with exercises until they have
responded. If they describe ongoing distress over weeks, gently suggest seeing a licensed professional too."""


def persona(client_extra="", query=""):
    memory = workspace.agent_context(limit=1400, query=query)
    now = f"The current local date and time is {datetime.datetime.now().strftime('%A %Y-%m-%d %H:%M')}."
    return "\n\n".join(x for x in (PERSONA, memory, now, client_extra) if x)


def pick_voice(name):
    name = str(name or "").strip()
    return name if name in VOICES else DEFAULT_VOICE


def crisis(text):
    return bool(CRISIS.search(str(text or "")))


# ── mood log ─────────────────────────────────────────────────────────
def _load():
    try:
        data = json.loads(FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def log_mood(mood, words=(), note=""):
    mood = int(mood)
    if not 1 <= mood <= 5:
        raise ValueError("mood must be 1 to 5")
    entry = {"at": datetime.datetime.now().isoformat(timespec="minutes"), "mood": mood,
             "words": [str(w)[:24] for w in list(words or [])[:6]], "note": str(note or "")[:500]}
    with LOCK:
        data = _load()
        data.setdefault("moods", []).append(entry)
        data["moods"] = data["moods"][-500:]
        FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return entry


def state():
    moods = _load().get("moods", [])
    return {"moods": moods[-60:], "voices": VOICES, "defaultVoice": DEFAULT_VOICE, "helpLines": HELP_LINES}


# ── text fallback (when the microphone is off) ──────────────────────
def chat(messages):
    turns = [m for m in (messages or []) if isinstance(m, dict) and str(m.get("text", "")).strip()][-20:]
    if not turns:
        raise ValueError("Say something first")
    last = str(turns[-1].get("text", ""))
    contents = [{"role": "model" if m.get("role") == "zuzu" else "user", "parts": [{"text": str(m["text"])[:2000]}]} for m in turns]
    model = os.environ.get("GEMINI_CHAT_MODEL", "gemini-2.5-flash")
    data = media._call(f"models/{urllib.parse.quote(model, safe='-.')}:generateContent", {
        "systemInstruction": {"parts": [{"text": persona(query=last) + "\nReply in at most 90 words; this will be read aloud softly."}]},
        "contents": contents, "generationConfig": {"temperature": 0.7, "maxOutputTokens": 400}}, timeout=60)
    parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    reply = "".join(p.get("text", "") for p in parts).strip()
    return {"reply": reply or "I'm here with you. Take your time.", "crisis": crisis(last)}


def action(payload):
    kind = payload.get("action")
    if kind == "mood":
        return {"entry": log_mood(payload.get("mood"), payload.get("words"), payload.get("note")), **state()}
    if kind == "chat":
        return chat(payload.get("messages"))
    if kind == "check":
        return {"crisis": crisis(payload.get("text"))}
    raise ValueError("unknown calm action")
