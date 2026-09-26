"""Personal assistant data for Zuzu: reminders, daily brief sources and announcements.

Everything is stored locally in personal.json. Network sources (weather, news,
calendar) are free, key-less feeds and every one of them fails soft: a brief is
still produced when a source is unreachable.
"""
import datetime
import json
import os
import pathlib
import re
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent
FILE = ROOT / "personal.json"
LOCK = threading.RLock()
OUTBOX = []          # announcements waiting for the dashboard to speak them
OUTBOX_LOCK = threading.Lock()

DEFAULT_SETTINGS = {
    "city": "Dubai", "lat": 25.2048, "lon": 55.2708,
    "newsRegion": "AE", "newsLang": "en", "newsTopic": "",
    "calendarIcs": "",
    "briefMorning": "08:00", "briefEvening": "20:00", "briefsEnabled": True,
    "telegramTarget": "",
    "wakeWord": False,
    "emailBrief": False, "emailAlerts": False, "emailAlertMinutes": 30,
}
WEATHER_CODES = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain",
    65: "heavy rain", 71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers",
    81: "rain showers", 82: "violent rain showers", 95: "thunderstorm", 96: "thunderstorm with hail",
    99: "thunderstorm with hail",
}


# ── storage ─────────────────────────────────────────────────
def _load():
    try:
        data = json.loads(FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    data.setdefault("reminders", [])
    data.setdefault("briefsSent", {})
    data["settings"] = {**DEFAULT_SETTINGS, **data.get("settings", {})}
    return data


def load():
    with LOCK:
        return _load()


def _save(data):
    temp = FILE.with_name(f".{FILE.name}.{uuid.uuid4().hex}.tmp")
    temp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temp, FILE)


def public_state():
    data = load()
    now = datetime.datetime.now()
    reminders = sorted(data["reminders"], key=lambda r: (r.get("done", False), r.get("due") or "9999"))
    return {"settings": data["settings"], "reminders": reminders, "now": now.isoformat(timespec="minutes")}


# ── time parsing ────────────────────────────────────────────
_WEEKDAYS = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4, "saturday": 5, "sunday": 6,
             "الاثنين": 0, "الإثنين": 0, "التلات": 1, "الثلاثاء": 1, "الاربع": 2, "الأربعاء": 2, "الخميس": 3,
             "الجمعة": 4, "الجمعه": 4, "السبت": 5, "الحد": 6, "الأحد": 6, "الاحد": 6}
_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")


def _clock(text):
    """Find 'at 5', '5pm', '17:30', 'الساعة 5' and return (hour, minute) or None."""
    m = re.search(r"(?:\bat\s+|الساعة\s*|الساعه\s*)?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|ص|م|صباحا|مساء|مساءً|بالليل)?\b", text, re.I)
    if not m or (not m.group(2) and not m.group(3) and not re.search(r"\bat\s+\d|الساع", text)):
        return None
    hour, minute = int(m.group(1)), int(m.group(2) or 0)
    suffix = (m.group(3) or "").lower()
    if suffix in {"pm", "م", "مساء", "مساءً", "بالليل"} and hour < 12:
        hour += 12
    if suffix in {"am", "ص", "صباحا"} and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return None
    return hour, minute


def parse_when(text, now=None):
    """Best-effort natural-language due time (English + Egyptian Arabic). Returns datetime or None."""
    now = now or datetime.datetime.now()
    t = str(text or "").lower().translate(_ARABIC_DIGITS)
    for phrase, delta in (("نص ساعة", 30), ("نص ساعه", 30), ("ربع ساعة", 15), ("ربع ساعه", 15),
                          ("ساعتين", 120), ("half an hour", 30)):
        if phrase in t and ("بعد" in t or phrase == "half an hour"):
            return now + datetime.timedelta(minutes=delta)
    m = re.search(r"\bin\s+(\d+)\s*(min|minute|minutes|h|hr|hour|hours|day|days)\b|بعد\s+(\d+)\s*(دقيقة|دقايق|دقائق|ساعة|ساعات|يوم|ايام|أيام)", t)
    if m:
        n = int(m.group(1) or m.group(3))
        unit = (m.group(2) or m.group(4))
        if unit.startswith(("min", "دق")):
            return now + datetime.timedelta(minutes=n)
        if unit.startswith(("h", "ساع")):
            return now + datetime.timedelta(hours=n)
        return now + datetime.timedelta(days=n)
    day = None
    if re.search(r"\btomorrow\b|بكرة|بكره|غدا|غداً", t):
        day = (now + datetime.timedelta(days=1)).date()
    elif re.search(r"\btoday\b|tonight|النهاردة|النهارده|الليلة", t):
        day = now.date()
    else:
        dm = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", t)
        if dm:
            day = datetime.date(int(dm.group(1)), int(dm.group(2)), int(dm.group(3)))
        else:
            for name, idx in _WEEKDAYS.items():
                if re.search(rf"(?:\b|^|\s){re.escape(name)}(?:\b|$|\s)", t):
                    ahead = (idx - now.weekday()) % 7 or 7
                    day = (now + datetime.timedelta(days=ahead)).date()
                    break
    clock = _clock(re.sub(r"\b\d{4}-\d{2}-\d{2}\b", "", t))
    if day is None and clock is None:
        return None
    if day is None:
        candidate = now.replace(hour=clock[0], minute=clock[1], second=0, microsecond=0)
        return candidate if candidate > now else candidate + datetime.timedelta(days=1)
    hour, minute = clock or (9, 0)
    return datetime.datetime.combine(day, datetime.time(hour, minute))


_TIME_WORDS = [
    r"\bin\s+\d+\s*(?:min|minute|minutes|h|hr|hour|hours|day|days)\b", r"\bin half an hour\b",
    r"\b(?:tomorrow|today|tonight)\b", r"\b(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
    r"\b\d{4}-\d{2}-\d{2}\b", r"\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b", r"\bat\s+\d{1,2}(?::\d{2})?\b", r"\b\d{1,2}:\d{2}\b",
    r"بعد\s+(?:\d+\s*)?(?:دقيقة|دقايق|دقائق|ساعة|ساعه|ساعات|ساعتين|يوم|ايام|أيام|نص ساعة|نص ساعه|ربع ساعة|ربع ساعه)",
    r"(?:بكرة|بكره|غدا|غداً|النهاردة|النهارده|الليلة)", r"(?:يوم\s+)?(?:الاثنين|الإثنين|التلات|الثلاثاء|الاربع|الأربعاء|الخميس|الجمعة|الجمعه|السبت|الحد|الأحد|الاحد)",
    r"(?:الساعة|الساعه)\s*\d{1,2}(?::\d{2})?\s*(?:ص|م|صباحا|مساء|مساءً|بالليل)?",
]


def _clean_reminder_text(text):
    original = str(text or "").strip()
    t = re.sub(r"^\s*(?:/remind\w*|remind me(?: to)?|reminder:?|ذكرني|فكرني|فكريني|ذكريني)\s*(?:ان|إن|to)?\s*", "", original, flags=re.I)
    stripped = t.translate(_ARABIC_DIGITS)
    for pattern in _TIME_WORDS:
        stripped = re.sub(pattern, " ", stripped, flags=re.I)
    stripped = re.sub(r"\s+", " ", stripped).strip(" .،,-")
    return stripped or t.strip(" .،,") or original


# ── reminders ───────────────────────────────────────────────
def add_reminder(text, due=None, repeat=None, now=None):
    text = str(text or "").strip()[:300]
    if not text:
        raise ValueError("Say what to remind you about")
    if repeat not in (None, "", "daily", "weekly"):
        raise ValueError("repeat must be daily or weekly")
    if isinstance(due, str) and due.strip():
        try:
            due_dt = datetime.datetime.fromisoformat(due.strip()[:16])
        except ValueError:
            due_dt = parse_when(due, now)
    else:
        due_dt = parse_when(text, now)
    item = {"id": uuid.uuid4().hex[:10], "text": _clean_reminder_text(text),
            "due": due_dt.isoformat(timespec="minutes") if due_dt else None,
            "repeat": repeat or None, "done": False, "announced": False,
            "created": (now or datetime.datetime.now()).isoformat(timespec="minutes")}
    with LOCK:
        data = _load()
        data["reminders"].append(item)
        _save(data)
    return item


def update_reminder(item_id, **changes):
    with LOCK:
        data = _load()
        item = next((r for r in data["reminders"] if r["id"] == item_id), None)
        if item is None:
            raise ValueError("reminder not found")
        if "done" in changes:
            item["done"] = bool(changes["done"])
        if changes.get("text"):
            item["text"] = str(changes["text"])[:300]
        if "due" in changes:
            item["due"] = changes["due"] or None
            item["announced"] = False
        _save(data)
        return item


def delete_reminder(item_id):
    with LOCK:
        data = _load()
        data["reminders"] = [r for r in data["reminders"] if r["id"] != item_id]
        _save(data)


def reminders_for_day(day=None):
    day = day or datetime.date.today()
    out = []
    for r in load()["reminders"]:
        if r.get("done") or not r.get("due"):
            continue
        if r["due"][:10] == day.isoformat():
            out.append(r)
    return sorted(out, key=lambda r: r["due"])


def take_due(now=None):
    """Mark reminders that are due as announced (rescheduling repeats) and return them."""
    now = now or datetime.datetime.now()
    due = []
    with LOCK:
        data = _load()
        for r in data["reminders"]:
            if r.get("done") or r.get("announced") or not r.get("due"):
                continue
            if datetime.datetime.fromisoformat(r["due"]) <= now:
                due.append(dict(r))
                if r.get("repeat"):
                    step = datetime.timedelta(days=1 if r["repeat"] == "daily" else 7)
                    nxt = datetime.datetime.fromisoformat(r["due"])
                    while nxt <= now:
                        nxt += step
                    r["due"] = nxt.isoformat(timespec="minutes")
                else:
                    r["announced"] = True
        if due:
            _save(data)
    return due


# ── brief sources ───────────────────────────────────────────
def _get(url, timeout=8):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 Zuzu/1.0",
                                               "Accept-Language": "en-US,en;q=0.9,ar;q=0.8"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read(3_000_000)


def weather(lat, lon):
    url = ("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode({
        "latitude": lat, "longitude": lon, "timezone": "auto", "forecast_days": 1,
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code"}))
    data = json.loads(_get(url))
    cur, daily = data.get("current", {}), data.get("daily", {})
    first = lambda key: (daily.get(key) or [None])[0]
    return {"temp": cur.get("temperature_2m"), "feels": cur.get("apparent_temperature"),
            "humidity": cur.get("relative_humidity_2m"), "wind": cur.get("wind_speed_10m"),
            "summary": WEATHER_CODES.get(cur.get("weather_code"), "—"),
            "high": first("temperature_2m_max"), "low": first("temperature_2m_min"),
            "rain": first("precipitation_probability_max")}


def news(region="AE", lang="en", topic="", limit=5):
    params = {"hl": f"{lang}-{region}", "gl": region, "ceid": f"{region}:{lang}"}
    if topic:
        url = "https://news.google.com/rss/search?" + urllib.parse.urlencode({"q": topic, **params})
    else:
        url = "https://news.google.com/rss?" + urllib.parse.urlencode(params)
    root = ET.fromstring(_get(url))
    items = []
    for node in root.iter("item"):
        title = (node.findtext("title") or "").strip()
        source = (node.findtext("source") or "").strip()
        if source and title.endswith(" - " + source):
            title = title[: -len(source) - 3]
        if title:
            items.append({"title": title, "source": source, "url": (node.findtext("link") or "").strip()})
        if len(items) >= limit:
            break
    return items


def _ics_datetime(value):
    value = value.strip()
    if len(value) == 8:
        return datetime.datetime.strptime(value, "%Y%m%d"), True
    utc = value.endswith("Z")
    dt = datetime.datetime.strptime(value.rstrip("Z")[:15], "%Y%m%dT%H%M%S")
    if utc:
        dt = dt.replace(tzinfo=datetime.timezone.utc).astimezone().replace(tzinfo=None)
    return dt, False


def calendar_events(ics_text, day=None):
    """Events on `day` from an iCal feed (single events; recurring rules are not expanded)."""
    day = day or datetime.date.today()
    text = re.sub(r"\r?\n[ \t]", "", ics_text)          # unfold continuation lines
    events = []
    for block in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", text, re.S):
        fields = {}
        for line in block.strip().splitlines():
            key, _, val = line.partition(":")
            fields.setdefault(key.split(";")[0].upper(), val)
        if "DTSTART" not in fields:
            continue
        try:
            start, all_day = _ics_datetime(fields["DTSTART"])
        except ValueError:
            continue
        if start.date() != day:
            continue
        summary = fields.get("SUMMARY", "Event").replace("\\,", ",").replace("\\n", " ")
        events.append({"time": "All day" if all_day else start.strftime("%H:%M"), "title": summary[:160]})
    return sorted(events, key=lambda e: (e["time"] != "All day", e["time"]))


def build_brief(kind="morning", now=None):
    now = now or datetime.datetime.now()
    s = load()["settings"]
    brief = {"kind": kind, "date": now.strftime("%A %d %B %Y"), "time": now.strftime("%H:%M"),
             "city": s["city"], "weather": None, "news": [], "events": [], "reminders": [], "errors": []}
    try:
        brief["weather"] = weather(s["lat"], s["lon"])
    except Exception as exc:  # noqa: BLE001
        brief["errors"].append(f"weather unavailable ({type(exc).__name__})")
    try:
        brief["news"] = news(s["newsRegion"], s["newsLang"], s["newsTopic"])
    except Exception as exc:  # noqa: BLE001
        brief["errors"].append(f"news unavailable ({type(exc).__name__})")
    if s.get("calendarIcs"):
        try:
            brief["events"] = calendar_events(_get(s["calendarIcs"]).decode("utf-8", "replace"), now.date())
        except Exception as exc:  # noqa: BLE001
            brief["errors"].append(f"calendar unavailable ({type(exc).__name__})")
    day = now.date() if kind == "morning" else (now + datetime.timedelta(days=1)).date()
    brief["reminders"] = [{"time": r["due"][11:16], "text": r["text"]} for r in reminders_for_day(day)]
    brief["speech"] = brief_speech(brief)
    return brief


def brief_speech(b):
    parts = [("Good morning" if b["kind"] == "morning" else "Good evening") + f". It's {b['date']}."]
    w = b.get("weather")
    if w:
        parts.append(f"In {b['city']} it's {round(w['temp'])} degrees and {w['summary']}, "
                     f"with a high of {round(w['high'])} and a low of {round(w['low'])}.")
    if b["events"]:
        parts.append("On your calendar: " + "; ".join(f"{e['time']} {e['title']}" for e in b["events"][:5]) + ".")
    label = "today" if b["kind"] == "morning" else "tomorrow"
    if b["reminders"]:
        parts.append(f"Your reminders for {label}: " + "; ".join(f"{r['time']} {r['text']}" for r in b["reminders"][:6]) + ".")
    else:
        parts.append(f"No reminders for {label}.")
    if b["news"]:
        parts.append("Top headlines: " + "; ".join(n["title"] for n in b["news"][:3]) + ".")
    return " ".join(parts)


# ── announcements ───────────────────────────────────────────
def announce(kind, text, payload=None):
    with OUTBOX_LOCK:
        OUTBOX.append({"id": uuid.uuid4().hex[:8], "kind": kind, "text": text, "payload": payload or {},
                       "at": datetime.datetime.now().isoformat(timespec="seconds")})
        del OUTBOX[:-50]
    target = load()["settings"].get("telegramTarget", "").strip()
    if target:
        threading.Thread(target=_send_telegram, args=(target, text), daemon=True).start()


def take_outbox():
    with OUTBOX_LOCK:
        items = list(OUTBOX)
        OUTBOX.clear()
    return items


def _send_telegram(target, text):
    try:
        import runtime  # local import: runtime reads env at import time
        subprocess.run(runtime._hermes_base() + ["send", "--to", target, text[:3500]],
                       capture_output=True, timeout=60, cwd=runtime.WORKDIR)
    except Exception:  # noqa: BLE001
        pass


def tick(now=None):
    """One scheduler pass: due reminders and morning/evening briefs."""
    now = now or datetime.datetime.now()
    for r in take_due(now):
        announce("reminder", f"Reminder: {r['text']}", r)
    data = load()
    s = data["settings"]
    if not s.get("briefsEnabled", True):
        return
    for kind, at in (("morning", s.get("briefMorning")), ("evening", s.get("briefEvening"))):
        if not at or not re.fullmatch(r"\d{2}:\d{2}", at):
            continue
        key = f"{kind}:{now.date().isoformat()}"
        if now.strftime("%H:%M") >= at and data["briefsSent"].get(kind) != key:
            with LOCK:
                fresh = _load()
                if fresh["briefsSent"].get(kind) == key:
                    continue
                fresh["briefsSent"][kind] = key
                _save(fresh)
            # A brief more than 3 hours late (PC was off) is skipped rather than read out of context.
            hh, mm = map(int, at.split(":"))
            if now - now.replace(hour=hh, minute=mm, second=0, microsecond=0) > datetime.timedelta(hours=3):
                continue
            brief = build_brief(kind, now)
            if s.get("emailBrief"):
                try:
                    brief["email"] = email_summary(12)
                    if brief["email"]:
                        brief["speech"] += " Your email: " + brief["email"]
                except Exception as exc:  # noqa: BLE001
                    brief["errors"].append(f"email unavailable ({type(exc).__name__})")
            announce("brief", brief["speech"], brief)


EXTRA_TICKS = []   # other modules register periodic checks (market alerts, email)


def start_scheduler(interval=30):
    def loop():
        while True:
            try:
                tick()
            except Exception:  # noqa: BLE001
                pass
            for extra in list(EXTRA_TICKS):
                try:
                    extra()
                except Exception:  # noqa: BLE001
                    pass
            time.sleep(interval)
    threading.Thread(target=loop, daemon=True, name="zuzu-personal").start()


def save_settings(values):
    allowed = set(DEFAULT_SETTINGS)
    clean = {}
    for key, value in (values or {}).items():
        if key not in allowed:
            continue
        if key in {"lat", "lon"}:
            clean[key] = float(value)
        elif key in {"briefsEnabled", "wakeWord", "emailBrief", "emailAlerts"}:
            clean[key] = bool(value)
        elif key == "emailAlertMinutes":
            clean[key] = max(10, min(240, int(value or 30)))
        else:
            clean[key] = re.sub(r"[\r\n]", "", str(value)).strip()[:500]
    for key in ("briefMorning", "briefEvening"):
        if key in clean and clean[key] and not re.fullmatch(r"\d{2}:\d{2}", clean[key]):
            raise ValueError(f"{key} must look like 08:00")
    with LOCK:
        data = _load()
        data["settings"].update(clean)
        _save(data)
    return public_state()


def geocode(city):
    url = "https://geocoding-api.open-meteo.com/v1/search?" + urllib.parse.urlencode({"name": city, "count": 1})
    results = json.loads(_get(url)).get("results") or []
    if not results:
        raise ValueError("City not found")
    r = results[0]
    return {"city": r.get("name", city), "lat": r["latitude"], "lon": r["longitude"]}


# ── email through Hermes (the account is connected in Hermes, never stored here) ──
EMAIL_NOT_CONNECTED = "EMAIL_NOT_CONNECTED"


def ask_hermes(prompt):
    import hermes_api  # local imports keep this module testable without the server
    import runtime
    runner = (hermes_api.run_hermes(prompt, None, None, title="Zuzu background check")
              if hermes_api.configured() else runtime.run_hermes(prompt, None, None))
    text, error = "", ""
    for event in runner:
        if event.get("t") == "delta":
            text += event.get("text", "")
        elif event.get("t") == "error":
            error = event.get("message", "Hermes failed")
    if error and not text.strip():
        raise RuntimeError(error)
    return text.strip()


def email_summary(hours=12):
    reply = ask_hermes(
        f"Check my connected email account. Summarize the important emails from the last {hours} hours in at most "
        "5 short spoken-style sentences (who, what, what they need from me). Skip newsletters, promotions and "
        f"automated notifications. If no email account is connected to Hermes, reply exactly {EMAIL_NOT_CONNECTED}.")
    if EMAIL_NOT_CONNECTED in reply:
        return "No email account is connected to Hermes yet."
    return reply


def email_alert_tick(now=None):
    now = now or datetime.datetime.now()
    data = load()
    s = data["settings"]
    if not s.get("emailAlerts"):
        return
    last = data.get("emailChecked")
    if last and now - datetime.datetime.fromisoformat(last) < datetime.timedelta(minutes=s.get("emailAlertMinutes", 30)):
        return
    with LOCK:
        fresh = _load()
        fresh["emailChecked"] = now.isoformat(timespec="minutes")
        _save(fresh)
    since = last or (now - datetime.timedelta(hours=1)).isoformat(timespec="minutes")
    reply = ask_hermes(
        f"Check my email for NEW messages received since {since} (local time). Reply exactly NONE if nothing is important. "
        "Otherwise list only the important ones, one per line: sender, subject, why it matters. Ignore newsletters and promotions. "
        f"If no email account is connected, reply exactly {EMAIL_NOT_CONNECTED}.")
    if reply and "NONE" not in reply.strip().upper()[:8] and EMAIL_NOT_CONNECTED not in reply:
        announce("email", "Important email: " + reply[:600])
