"""
Zuzu Live — a HUD that drives Hermes Agent.

    python3 server.py

The brain is your own Hermes Agent CLI/profile. Hermes keeps access to the same
configured tools, browser/Chrome automation, MCP servers, skills, memory, and
third-party integrations that your normal Hermes sessions have. Voice can use the
browser Web Speech API, with optional server-side ElevenLabs STT/TTS if present.
"""
import datetime
import io
import json
import mimetypes
import os
import pathlib
import re
import secrets
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).resolve().parent
UI = ROOT / "ui"

# load .env before importing anything that reads os.environ
_env = ROOT / ".env"
if _env.exists():
    for line in _env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

import commands         # noqa: E402
import auth             # noqa: E402
import hermes_api       # noqa: E402
import phone_calls      # noqa: E402
import catalog          # noqa: E402
import vapi_proxy       # noqa: E402
import runtime          # noqa: E402
import voice            # noqa: E402
import workspace        # noqa: E402
import ngrok_setup      # noqa: E402
import personal         # noqa: E402
import markets          # noqa: E402
import books            # noqa: E402
import media            # noqa: E402
import screen_pointer   # noqa: E402
import skills_scout     # noqa: E402
import memory_auto      # noqa: E402
import creative         # noqa: E402
import calm             # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

PORT = int(os.environ.get("JARVIS_PORT", "8730"))
RUN_LOCK = threading.Lock()
MAX_JSON_BODY = 1024 * 1024
MAX_AUDIO_BODY = 12 * 1024 * 1024
MAX_UPLOAD_BODY = 25 * 1024 * 1024


def _configured_public_origin():
    return os.environ.get("JARVIS_PUBLIC_ORIGIN", "").strip().rstrip("/")


def _host_allowed(host):
    host = (host or "").strip().lower()
    if host in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}:
        return True
    public_origin = _configured_public_origin()
    if public_origin:
        parsed = urlparse(public_origin)
        if parsed.netloc and host == parsed.netloc.lower():
            return True
    return False


def _origin_allowed(origin):
    if not origin:
        return False
    origin = origin.strip().rstrip("/")
    if origin in {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}:
        return True
    public_origin = _configured_public_origin()
    if public_origin and origin == public_origin:
        return True
    return False

# The Zuzu persona, appended to every run. Without it, the model answers as a
# coding agent and narrates its own tooling — which is not what you want spoken
# out loud. Edit persona.md to change how it talks.
_PERSONA_FILE = ROOT / "persona.md"



def _client_context_prompt(ctx):
    if not isinstance(ctx, dict):
        return ""
    def clean(value, limit=240):
        return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]
    device = clean(ctx.get("device_type") or "unknown", 40)
    platform = clean(ctx.get("platform"), 80)
    page = clean(ctx.get("url"), 240)
    viewport = clean(ctx.get("viewport"), 40)
    visual_kind = clean(ctx.get("visual_kind"), 80)
    visual_url = clean(ctx.get("visual_url"), 240)
    note = clean(ctx.get("note"), 400)
    return (
        "Current Zuzu client/device context: "
        f"device={device}; platform={platform}; viewport={viewport}; page={page}; "
        f"visual_panel={visual_kind or 'none'}; visual_url={visual_url or 'none'}. {note} "
        "Use this to know whether the user is on mobile or the laptop. If the user is on mobile and asks to see laptop/browser work, show or return a URL/screenshot/live-screen update through the dashboard when possible."
    )

def persona(client_extra="", query=""):
    try:
        base = _PERSONA_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        base = ""
    command_context = commands.context_block()      # profile / goal / personality / queue
    custom = workspace.load().get("settings", {}).get("persona", "")
    relevant = workspace.agent_context(query=query)
    bridge = (
        "Zuzu-Hermes memory contract: dashboard Memory Brain is shared with Hermes through this system prompt. "
        "Use it as durable user memory. If the user asks to remember or save a fact, acknowledge that Zuzu saved it; "
        "Zuzu saves remember/save requests and new lasting facts automatically after each turn; you do not need to store them yourself."
    )
    self_awareness = (
        f"Zuzu system awareness: Zuzu is this local dashboard project at {ROOT}. "
        "The dashboard is the user's interface to Hermes, not a separate powerless chatbot. "
        "If the user asks to modify Zuzu, her UI, voice, memory, tools, providers, catalogue, reminders, music, account connectors, "
        "or how she behaves, treat it as an actionable local project/tooling request. "
        "Use Hermes computer/file/browser/tools when available, inspect the current system state, and report real limits only after checking. "
        "Do not answer 'I cannot modify myself' unless the actual tool attempt is unavailable or denied."
        " Telegram is configured in Hermes. For an explicitly authorized Telegram send request, use the terminal tool with Hermes' official "
        "`hermes send --list telegram --json` to resolve the destination and `hermes send --to <target> <message>` to deliver it; never read or expose the bot token. "
        "Email is available only after the user connects an email platform in Hermes gateway setup; report that setup requirement accurately instead of pretending it is connected."
    )
    return "\n\n".join(x for x in (base, custom, bridge, self_awareness, relevant, command_context, client_extra) if x)


def live_voice_persona(client_extra=""):
    """A compact native-audio prompt: preserve character and route only real work."""
    settings = workspace.load().get("settings", {})
    custom = str(settings.get("persona") or "Warm, concise, capable and naturally conversational.").strip()[:1600]
    memory = workspace.agent_context(limit=1400)
    routing = (
        "You are Zuzu in a realtime voice conversation. The user's saved persona above is authoritative: keep its tone, warmth, language and relationship style in every direct reply. "
        "For greetings, casual conversation, opinions, emotional support, jokes, and questions you can answer reliably without current or private data, answer immediately yourself in one or two natural spoken sentences. "
        "Call hermes_action exactly once when the user asks you to DO something or needs current/private/system information: Telegram or email, accounts, computer or iPhone actions, browser/search, files, apps, tools, memory changes, reminders, projects, connected services, or Zuzu configuration. "
        "If you are unsure whether a real action or connected data is required, call Hermes. Never claim you cannot do an action before Hermes returns. Never invent success. Speak the returned result naturally in your persona. "
        "Fast local tools (use these instead of Hermes when they fit): add_reminder for any 'remind me' request (convert the time to an ISO local datetime); "
        "get_daily_brief when asked about the day, date, weather, news, schedule or reminders; play_music to play songs or playlists; "
        "play_video to show a YouTube video about something; switch_model when asked to change the AI model or provider; "
        "sleep_mode when the user says 'Zuzu sleep mode', goodbye or asks you to stop listening (say a short goodbye first). "
        "get_markets and set_price_alert for prices and markets (say it is information, not financial advice); "
        "create_image and create_video to make pictures or clips; find_books to find something to read; "
        "point_at to show the user where something is on their laptop screen; find_new_skills to look for new abilities, "
        "and install_skill only after the user explicitly says yes to a specific skill. "
        "calm_mode when the user is stressed, sad, anxious, cannot sleep or asks for the therapist; make_music to compose music, resin_quote for resin/wood piece costs and prices, open_creative_studio to edit photos, redesign a room, write a shop listing or make a 3D model. "
        f"The current local date and time is {datetime.datetime.now().strftime('%A %Y-%m-%d %H:%M')}."
    )
    return "\n\n".join(x for x in (custom, routing, memory, client_extra) if x)


def direct_model_persona(client_extra="", query=""):
    """Persona and bounded memory for a model with no Hermes connection."""
    settings = workspace.load().get("settings", {})
    custom = str(settings.get("persona") or "Warm, concise, capable and naturally conversational.").strip()[:2000]
    memory = workspace.agent_context(limit=1800, query=query)
    boundary = (
        "You are Zuzu in Direct Model mode. Answer the user yourself using only this model. "
        "You have no Hermes connection and no computer, browser, account, file, or external tools in this mode. "
        "Never claim that you performed an action. If an action needs tools, tell the user to switch to Hybrid or Hermes Only."
    )
    return "\n\n".join(x for x in (custom, boundary, memory, client_extra) if x)


def _tool(name, description, props=None, required=()):
    params = {"type": "OBJECT", "properties": {k: {"type": "STRING", "description": v} for k, v in (props or {}).items()}}
    if required:
        params["required"] = list(required)
    return {"name": name, "description": description, "parameters": params}


LOCAL_VOICE_TOOLS = [
    _tool("add_reminder", "Save a personal reminder.", {
        "text": "What to remind the user about, in their words.",
        "due": "Local date-time in ISO format YYYY-MM-DDTHH:MM, or empty if no time was given.",
        "repeat": "Empty, 'daily' or 'weekly'."}, ("text",)),
    _tool("get_daily_brief", "Get today's date, weather, calendar, reminders and top news headlines.",
          {"kind": "'morning' (today) or 'evening' (tonight and tomorrow)."}),
    _tool("play_music", "Play music from YouTube Music on the dashboard.",
          {"query": "Artist, song, mood or playlist to play."}, ("query",)),
    _tool("play_video", "Search YouTube and show a video on the dashboard.",
          {"query": "What the video should be about."}, ("query",)),
    _tool("switch_model", "Change the AI model Hermes uses.", {
        "provider": "One of: gemini, openai, anthropic, openrouter, ollama, hermes.",
        "model": "Model name, or empty for that provider's default."}, ("provider",)),
    _tool("sleep_mode", "Stop listening until the wake word is heard again."),
    _tool("get_markets", "Get live prices and today's most active tradable markets, plus the user's watchlist."),
    _tool("set_price_alert", "Alert the user when a market crosses a price.", {
        "symbol": "Ticker such as GC=F (gold), BTC-USD, ^GSPC, EURUSD=X, AAPL.",
        "direction": "'above' or 'below'.", "price": "Price level as a number."}, ("symbol", "direction", "price")),
    _tool("create_image", "Create an image from a description and show it.", {"prompt": "Detailed description of the image."}, ("prompt",)),
    _tool("create_video", "Start creating a short video from a description; it is announced when ready.",
          {"prompt": "Detailed description of the video."}, ("prompt",)),
    _tool("find_books", "Search the free library for books to read or brief.", {"query": "Title, author or subject."}, ("query",)),
    _tool("point_at", "Draw an arrow and circle on the user's laptop screen pointing at something visible.",
          {"description": "What to point at, e.g. 'the Save button' or 'the Wi-Fi icon'."}, ("description",)),
    _tool("clear_screen_drawing", "Remove Zuzu's drawings from the laptop screen."),
    _tool("find_new_skills", "Search for new Hermes skills that could help, and list them for approval.",
          {"topic": "What the skill should help with, or empty to decide from the user's habits."}),
    _tool("install_skill", "Install a proposed skill. Only after the user clearly said yes to installing that exact skill.",
          {"name": "Name of the proposed skill.", "confirmed": "'yes' only if the user explicitly approved."}, ("name", "confirmed")),
    _tool("make_music", "Compose original music with Lyria: a ~30 second loop, or a full song if asked.",
          {"prompt": "Genre, mood, instruments, tempo.", "full": "'yes' only for a full-length song."}, ("prompt",)),
    _tool("resin_quote", "Calculate resin litres, cost and selling price for a resin or river table / board / coasters.",
          {"length": "Length in cm.", "width": "Width in cm.", "depth": "Resin depth in cm.",
           "fill_percent": "Share of the surface that is resin, 100 for full resin, ~35 for a river table.",
           "pieces": "Number of pieces."}, ("length", "width", "depth")),
    _tool("open_creative_studio", "Open the creative studio: photo editor, room redesign, resin calculator, shop listing, music or 3D.",
          {"tab": "editor, room, resin, listing, music or model3d."}),
    _tool("calm_mode", "Enter Calm mode (soft voice, relaxing music and visuals, supportive listening) when the user is stressed, "
          "sad, anxious, can't sleep, wants to vent, or asks for the therapist / calm mode."),
]
CALM_TOOLS = [
    next(t for t in LOCAL_VOICE_TOOLS if t["name"] == "add_reminder"),
    _tool("start_breathing", "Guide a breathing exercise on screen.",
          {"pattern": "box (4-4-4-4), 478 (4-7-8, for sleep), coherent (5.5 in / 5.5 out) or sigh (physiological sigh).",
           "minutes": "Length in minutes, default 2."}, ("pattern",)),
    _tool("set_calm_scene", "Change the relaxing scenery and/or background sound.",
          {"scene": "aurora, ocean, forest, night or rain.", "sound": "pads, ocean, rain or silence."}),
    _tool("log_mood", "Save how the user feels right now (private mood log).",
          {"mood": "1 (very low) to 5 (very good).", "words": "Up to 3 feeling words, comma separated."}, ("mood",)),
    _tool("leave_calm_mode", "Leave Calm mode when the user says they feel better or wants to stop (say a gentle goodbye first)."),
]


READ_ALOUD_PROMPT = (
    "You are Zuzu's speaking voice. Every user message is text that Zuzu already wrote. "
    "Speak it aloud exactly as written, word for word, in its original language and dialect, "
    "with a warm, natural, conversational delivery. Never answer it, summarise it, translate it, "
    "add words, or comment on it. Skip URLs and code; read everything else."
)


def _fetch_text(url, timeout=10):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
    })
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read(2_000_000)
    return raw.decode("utf-8", "replace")


def _youtube_search(query):
    query = re.sub(r"\s+", " ", str(query or "")).strip()[:180]
    if not query:
        raise ValueError("empty YouTube search")
    html = _fetch_text("https://www.youtube.com/results?search_query=" + urllib.parse.quote_plus(query))
    seen = set()
    videos = []
    for match in re.finditer(r'"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"', html):
        vid = match.group(1)
        if vid in seen:
            continue
        seen.add(vid)
        around = html[max(0, match.start() - 900):match.end() + 1600]
        title_match = re.search(r'"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"', around)
        title = query
        if title_match:
            try:
                title = json.loads('"' + title_match.group(1) + '"')
            except ValueError:
                title = title_match.group(1)
        videos.append({
            "id": vid,
            "title": title,
            "url": f"https://www.youtube.com/watch?v={vid}",
            "embed": f"https://www.youtube.com/embed/{vid}?autoplay=1&playsinline=1&rel=0",
        })
        if len(videos) >= 5:
            break
    if not videos:
        raise RuntimeError("No YouTube videos found")
    return {"query": query, "results": videos, "best": videos[0]}


def _web_search(query):
    query = re.sub(r"\s+", " ", str(query or "")).strip()[:220]
    if not query:
        raise ValueError("empty web search")
    html = _fetch_text("https://duckduckgo.com/html/?q=" + urllib.parse.quote_plus(query))
    results = []
    for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.I | re.S):
        href = m.group(1).replace("&amp;", "&")
        title = re.sub(r"<.*?>", "", m.group(2))
        title = re.sub(r"\s+", " ", title).strip()
        if "uddg=" in href:
            parsed = urllib.parse.urlparse(href)
            params = urllib.parse.parse_qs(parsed.query)
            href = urllib.parse.unquote(params.get("uddg", [href])[0])
        if href.startswith("http"):
            results.append({"title": title or href, "url": href})
        if len(results) >= 8:
            break
    if not results:
        results = [{"title": f"Search Google for {query}", "url": "https://www.google.com/search?q=" + urllib.parse.quote_plus(query)}]
    return {"query": query, "results": results, "best": results[0]}


def _memory_bytes():
    """Return (total, available) RAM in bytes using only the standard library."""
    if os.name == "nt":
        import ctypes

        class _Status(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        status = _Status()
        status.dwLength = ctypes.sizeof(_Status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return status.ullTotalPhys, status.ullAvailPhys
        return None, None
    try:
        values = {}
        for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
            key, _, rest = line.partition(":")
            values[key] = int(rest.split()[0]) * 1024
        return values.get("MemTotal"), values.get("MemAvailable")
    except (OSError, ValueError):
        return None, None


def _uptime_seconds():
    if os.name == "nt":
        import ctypes
        return int(ctypes.windll.kernel32.GetTickCount64() // 1000)
    try:
        return int(float(pathlib.Path("/proc/uptime").read_text().split()[0]))
    except (OSError, ValueError, IndexError):
        return None


def system_snapshot():
    """Small, non-sensitive PC summary for the dashboard's This PC card."""
    import platform
    import shutil
    import socket
    import time
    info = {"host": socket.gethostname(), "os": f"{platform.system()} {platform.release()}".strip(),
            "machine": platform.machine(), "cpus": os.cpu_count(), "python": platform.python_version(),
            "time": time.strftime("%Y-%m-%d %H:%M"), "cpu_percent": None, "battery": None}
    total, available = _memory_bytes()
    info["memory"] = {"total": total, "available": available} if total else None
    try:
        usage = shutil.disk_usage(os.path.expanduser(runtime.WORKDIR or "~"))
        info["disk"] = {"total": usage.total, "free": usage.free}
    except OSError:
        info["disk"] = None
    info["uptime"] = _uptime_seconds()
    try:
        import psutil  # optional: richer live numbers when installed
        info["cpu_percent"] = psutil.cpu_percent(interval=None)
        battery = psutil.sensors_battery()
        if battery:
            info["battery"] = {"percent": round(battery.percent), "plugged": bool(battery.power_plugged)}
    except Exception:  # noqa: BLE001
        if hasattr(os, "getloadavg") and info["cpus"]:
            info["cpu_percent"] = round(min(100.0, os.getloadavg()[0] / info["cpus"] * 100), 1)
    return info


def capture_laptop_screen_jpeg():
    """Capture the visible Windows desktop for mobile live-screen preview."""
    try:
        from PIL import ImageGrab
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("Pillow screen capture is not available") from exc
    try:
        image = ImageGrab.grab(all_screens=True)
        image.thumbnail((1600, 1000))
        output = io.BytesIO()
        image.convert("RGB").save(output, format="JPEG", quality=78, optimize=True)
        return output.getvalue()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"Laptop screen capture failed: {exc}") from exc
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("JARVIS_VERBOSE"):
            sys.stderr.write("  " + (fmt % args) + "\n")

    # ── helpers ──────────────────────────────────────────────
    def _json(self, body, code=200, headers=None):
        data = json.dumps(body).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass

    def _bytes(self, data, ctype, code=200, headers=None):
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass

    def _read(self, limit):
        n = int(self.headers.get("Content-Length", 0))
        if n < 0 or n > limit:
            raise ValueError(f"request body exceeds {limit} bytes")
        return self.rfile.read(n) if n else b""

    def _host_ok(self):
        host = self.headers.get("Host", "")
        return _host_allowed(host)

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        return _origin_allowed(origin)

    def _token_ok(self):
        return auth.session(self.headers.get("Cookie")) is not None

    def _csrf_ok(self):
        active = auth.session(self.headers.get("Cookie"))
        supplied = self.headers.get("X-Zuzu-CSRF", "")
        return bool(active and supplied) and secrets.compare_digest(supplied, active["csrf"])

    def _local_request(self):
        # A public tunnel also connects to the server from 127.0.0.1. Reject
        # forwarded requests even if a remote client spoofs a localhost Host.
        forwarded = any(self.headers.get(name) for name in
                        ("Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Original-Host"))
        return (not forwarded and self.client_address[0] in {"127.0.0.1", "::1"}
                and self.headers.get("Host", "").split(":")[0] in {"127.0.0.1", "localhost"})

    def _login_cookie(self, sid):
        secure = "" if self._local_request() else "; Secure"
        return f"zuzu_session={sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age={auth.SESSION_SECONDS}{secure}"

    # ── GET ──────────────────────────────────────────────────
    def do_GET(self):
        if not self._host_ok():
            return self._json({"error": "invalid host"}, 403)
        p = urlparse(self.path).path
        if p == "/favicon.ico":
            return self._bytes((UI / "icon-192.png").read_bytes(), "image/png")
        if p == "/login.html":
            return self._bytes((UI / "login.html").read_bytes(), "text/html; charset=utf-8", headers={
                "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
                "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"})
        if p == "/api/auth-status":
            return self._json({"configured": auth.configured(), "authenticated": self._token_ok(),
                               "setup_local_only": True})
        if not self._token_ok():
            if p.startswith("/api/"):
                return self._json({"error": "login required"}, 401)
            return self._bytes(b"", "text/plain", 302, {"Location": "/login.html"})
        if p == "/connect-ngrok.html":
            if not ngrok_setup.STORE.active():
                return self._bytes(b"Setup is expired or already completed. Return to your chat.", "text/plain", 410)
            return self._bytes((UI / "connect-ngrok.html").read_bytes(), "text/html; charset=utf-8", headers={
                "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
                "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
            })
        if p == "/api/laptop-screen":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            try:
                return self._bytes(capture_laptop_screen_jpeg(), "image/jpeg", headers={
                    "Cache-Control": "no-store, max-age=0",
                    "Pragma": "no-cache",
                })
            except Exception as e:  # noqa: BLE001
                return self._json({"error": str(e)[:240]}, 503)

        if p.startswith("/uploads/"):
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            name = pathlib.Path(urlparse(self.path).path).name
            f = (workspace.UPLOADS / name).resolve()
            if not str(f).startswith(str(workspace.UPLOADS.resolve())) or not f.is_file():
                return self._bytes(b"not found", "text/plain", 404)
            return self._bytes(f.read_bytes(), mimetypes.guess_type(f.name)[0] or "application/octet-stream", headers={
                "Cache-Control": "private, no-store",
                "Content-Security-Policy": "sandbox",
                "X-Content-Type-Options": "nosniff",
            })

        if p == "/api/youtube-search":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            query = urllib.parse.parse_qs(urlparse(self.path).query).get("q", [""])[0]
            try:
                return self._json(_youtube_search(query))
            except Exception as e:  # noqa: BLE001
                return self._json({"error": str(e)[:240]}, 503)

        if p == "/api/web-search":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            query = urllib.parse.parse_qs(urlparse(self.path).query).get("q", [""])[0]
            try:
                return self._json(_web_search(query))
            except Exception as e:  # noqa: BLE001
                return self._json({"error": str(e)[:240]}, 503)

        if p == "/api/status":
            settings = workspace.load().get("settings", {})
            conversation_mode = settings.get("conversationMode", "hybrid")
            hermes_health = hermes_api.health() if hermes_api.configured() else runtime.hermes_health_snapshot()
            runtime_name = "direct" if conversation_mode == "direct" else ("hermes" if hermes_health["connected"] else "mock")
            live_enabled = conversation_mode == "hybrid" and voice.live_available()
            selected_model = (f"{settings.get('provider', runtime.PROVIDER)} · {settings.get('model', runtime.MODEL)}"
                              if conversation_mode == "direct" else runtime.active_model())
            return self._json(dict(
                runtime=runtime_name,
                conversation_mode=conversation_mode,
                provider=runtime.PROVIDER,
                hermes_connected=hermes_health["connected"],
                hermes_pending=hermes_health["pending"],
                hermes_detail=hermes_health["detail"],
                permission=runtime.PERMISSION,
                profile=runtime.PROFILE,
                source=runtime.SOURCE,
                workdir=runtime.WORKDIR,
                model=selected_model,
                transport="api" if hermes_api.configured() else "cli",
                tools=hermes_api.toolsets() if hermes_api.configured() and hermes_health["connected"] else runtime.hermes_tools_snapshot(),
                tools_pending=False if hermes_api.configured() else runtime.hermes_tools_pending(),
                browser_stt=True,
                browser_tts=True,
                voice_mode=os.environ.get("JARVIS_VOICE_MODE", voice.tts_provider()),
                voice_id=voice.voice_id() if voice.tts_available() else "browser",
                stt=voice.stt_provider(),
                tts=voice.tts_provider() if conversation_mode == "hybrid" else "browser",
                live_voice=live_enabled,
                live_model=voice.GEMINI_LIVE_MODEL if live_enabled else "",
                active_operation=runtime.active_operation_snapshot(),
                session=workspace.selected_hermes_session()[2]))
        if p == "/api/jobs":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            # finished background missions, reported once each
            return self._json(dict(done=commands.take_finished(),
                                   running=[j for j in commands.jobs_snapshot()
                                            if j["status"] == "running"],
                                   active_operation=runtime.active_operation_snapshot()))
        if p == "/api/system":
            return self._json(system_snapshot())
        if p == "/api/personal":
            return self._json(personal.public_state())
        if p == "/api/personal/inbox":
            return self._json({"items": personal.take_outbox()})
        if p == "/api/personal/email":
            try:
                return self._json({"summary": personal.email_summary(12)})
            except (RuntimeError, OSError) as exc:
                return self._json({"error": str(exc)[:200]}, 503)
        if p == "/api/calm":
            return self._json(calm.state())
        if p == "/api/creative/jobs":
            return self._json({"jobs": creative.jobs(), "meshy": bool(creative.meshy_key()),
                               "styles": list(creative.ROOM_STYLES)})
        if p == "/api/markets":
            return self._json(markets.state())
        if p == "/api/skills/proposals":
            return self._json({"proposals": skills_scout.proposals(), "overlay": screen_pointer.available()})
        if p == "/api/media/jobs":
            return self._json({"jobs": media.jobs()})
        if p.startswith("/api/books/"):
            q = {k: v[0] for k, v in urllib.parse.parse_qs(urlparse(self.path).query).items()}
            try:
                if p == "/api/books/search":
                    return self._json({"results": books.search(q.get("q", ""), q.get("topic", ""), q.get("lang", ""))})
                if p == "/api/books/shelf":
                    return self._json({"shelf": books.shelf()})
                if p == "/api/books/page":
                    page_no = int(q["page"]) if q.get("page", "").isdigit() else None
                    return self._json(books.page(int(q.get("id", "0")), page_no))
            except ValueError as exc:
                return self._json({"error": str(exc)[:200]}, 400)
            except (RuntimeError, OSError) as exc:
                return self._json({"error": f"Library unavailable: {type(exc).__name__}"}, 503)
        if p == "/api/personal/brief":
            kind = urllib.parse.parse_qs(urlparse(self.path).query).get("kind", ["morning"])[0]
            return self._json(personal.build_brief("evening" if kind == "evening" else "morning"))
        if p == "/api/workspace":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            return self._json(workspace.public_state())
        if p == "/api/history":
            _, _, session_id = workspace.selected_hermes_session()
            if not hermes_api.configured() or not session_id:
                return self._json({"messages": []})
            try:
                return self._json({"messages": hermes_api.messages(session_id)})
            except (OSError, ValueError, RuntimeError) as exc:
                return self._json({"error": f"Hermes history unavailable: {type(exc).__name__}"}, 503)
        if p == "/api/calls/status":
            return self._json(phone_calls.readiness())
        if p == "/api/calls/history":
            try:
                return self._json({"calls": phone_calls.history()})
            except RuntimeError as exc:
                return self._json({"error": str(exc)}, 503)
        if p == "/api/catalog/search":
            params = urllib.parse.parse_qs(urlparse(self.path).query)
            try:
                return self._json({"results": catalog.search(params.get("q", [""])[0], params.get("source", ["all"])[0])})
            except ValueError as exc:
                return self._json({"error": str(exc)}, 400)
            except (RuntimeError, OSError) as exc:
                return self._json({"error": str(exc)[:200]}, 503)

        rel = "index.html" if p == "/" else p.lstrip("/")
        f = (UI / rel).resolve()
        if not str(f).startswith(str(UI.resolve())) or not f.is_file():
            return self._bytes(b"not found", "text/plain", 404)
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        data = f.read_bytes()
        if rel == "index.html":
            data = data.replace(b"__ZUZU_CSRF__", auth.session(self.headers.get("Cookie"))["csrf"].encode())
        return self._bytes(data, ctype)

    # ── POST ─────────────────────────────────────────────────
    def do_POST(self):
        p = urlparse(self.path).path
        if p == "/v1/chat/completions":
            if not self._host_ok() or not vapi_proxy.authorized(self.headers.get("Authorization")):
                return self._json({"error": "unauthorized"}, 401)
            if self.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json":
                return self._json({"error": "JSON required"}, 415)
            try:
                payload = json.loads(self._read(MAX_JSON_BODY))
                with vapi_proxy.upstream(payload) as upstream:
                    self.send_response(upstream.status)
                    self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/json"))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.close_connection = True
                    while chunk := upstream.read(8192):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                return
            except ValueError as exc:
                return self._json({"error": str(exc)[:160]}, 400)
            except (RuntimeError, OSError, urllib.error.HTTPError) as exc:
                return self._json({"error": f"Hermes phone profile unavailable: {type(exc).__name__}"}, 503)
        if not self._host_ok() or not self._origin_ok():
            return self._json({"error": "request origin rejected"}, 403)
        if p in {"/api/login", "/api/enroll"}:
            if p == "/api/enroll" and not self._local_request():
                return self._json({"error": "owner setup is local only"}, 403)
            if self.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json":
                return self._json({"error": "JSON required"}, 415)
            try:
                payload = json.loads(self._read(2048))
                password = payload.get("password", "")
                if p == "/api/enroll":
                    auth.enroll(password)
                result = auth.login(password)
                if not result:
                    return self._json({"error": "invalid password or temporarily rate limited"}, 401)
                sid, csrf = result
                return self._json({"ok": True, "csrf": csrf}, headers={"Set-Cookie": self._login_cookie(sid)})
            except (ValueError, TypeError, AttributeError) as exc:
                return self._json({"error": str(exc)[:120]}, 400)
        if p == "/api/setup/ngrok":
            return ngrok_setup.handle_post(self)
        if not self._token_ok():
            return self._json({"error": "unauthorized"}, 401)
        if not self._csrf_ok():
            return self._json({"error": "invalid CSRF token"}, 403)
        if p == "/api/logout":
            auth.logout(self.headers.get("Cookie"))
            return self._json({"ok": True}, headers={"Set-Cookie": "zuzu_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"})
        ctype = self.headers.get("Content-Type", "").split(";", 1)[0].lower()
        if p in {"/api/run", "/api/speak", "/api/live-token", "/api/workspace", "/api/new", "/api/cancel", "/api/calls/outbound", "/api/catalog/install", "/api/personal", "/api/markets", "/api/books", "/api/media", "/api/overlay", "/api/overlay/point", "/api/skills", "/api/memory/observe", "/api/creative", "/api/calm"} and ctype != "application/json":
            return self._json({"error": "application/json required"}, 415)
        if p == "/api/listen" and not ctype.startswith("audio/"):
            return self._json({"error": "audio content type required"}, 415)
        try:
            limit = MAX_UPLOAD_BODY if p == "/api/upload" else (MAX_AUDIO_BODY if p == "/api/listen" else MAX_JSON_BODY)
            raw = self._read(limit)
        except (TypeError, ValueError):
            return self._json({"error": "request body too large"}, 413)

        if p == "/api/speak":
            try:
                text = (json.loads(raw or b"{}").get("text") or "").strip()
                return self._bytes(voice.speak(text), voice.content_type())
            except Exception as e:                        # noqa: BLE001
                return self._json({"error": str(e)[:200]}, 503)

        if p == "/api/calls/outbound":
            try:
                payload = json.loads(raw or b"{}")
                result = phone_calls.outbound(payload.get("number"), payload.get("confirmed"), payload.get("requestId"))
                return self._json(result)
            except (ValueError, AttributeError) as exc:
                return self._json({"error": str(exc)}, 400)
            except RuntimeError as exc:
                return self._json({"error": str(exc)}, 503)

        if p == "/api/catalog/install":
            try:
                payload = json.loads(raw or b"{}")
                if payload.get("confirmed") is not True:
                    return self._json({"error": "Confirm the skill installation"}, 400)
                return self._json(catalog.install(payload.get("identifier"), payload.get("kind", "skill")))
            except (ValueError, AttributeError) as exc:
                return self._json({"error": str(exc)}, 400)
            except (RuntimeError, OSError) as exc:
                return self._json({"error": str(exc)[:400]}, 503)

        if p == "/api/live-token":
            try:
                payload = json.loads(raw or b"{}")
                if not isinstance(payload, dict):
                    return self._json({"error": "JSON object required"}, 400)
                purpose = payload.get("purpose")
                mode = workspace.load().get("settings", {}).get("conversationMode", "hybrid")
                if mode != "hybrid" and purpose not in {"speak", "calm"}:
                    return self._json({"error": "Gemini Live conversation is available only in Hybrid mode"}, 409)
                live_auth = voice.create_live_token()
                live_auth["voice"] = workspace.load()["settings"].get("voice", voice.GEMINI_TTS_VOICE)
                if payload.get("purpose") == "speak":
                    # Read Hermes' typed replies with the same native-audio model and voice.
                    live_auth["system"] = READ_ALOUD_PROMPT
                    if payload.get("soft"):
                        live_auth["voice"] = calm.pick_voice(payload.get("voice"))
                        live_auth["system"] += " Read it softly, slowly and warmly, like a calm evening voice, with gentle pauses."
                    live_auth["tools"] = []
                    return self._json(live_auth)
                client_extra = "\n\n".join(x for x in ((payload.get("system") or "").strip(), _client_context_prompt(payload.get("client_context"))) if x)
                if payload.get("purpose") == "calm":
                    live_auth["voice"] = calm.pick_voice(payload.get("voice"))
                    live_auth["system"] = calm.persona(client_extra)
                    live_auth["tools"] = [{"functionDeclarations": CALM_TOOLS}]
                    return self._json(live_auth)
                live_auth["system"] = live_voice_persona(client_extra)
                live_auth["tools"] = [{"functionDeclarations": [{
                    "name": "hermes_action",
                    "description": "Use for every request requiring an action, tool, current/private data or connected service. Send the exact request to local Hermes, which owns Telegram, email/connections, computer control, browser, files, memory and tools. Do not use for ordinary casual conversation.",
                    "parameters": {"type": "OBJECT", "properties": {
                        "request": {"type": "STRING", "description": "The full user request, preserving language and constraints."}
                    }, "required": ["request"]}
                }] + LOCAL_VOICE_TOOLS}]
                return self._json(live_auth)
            except Exception as e:                        # noqa: BLE001
                return self._json({"error": str(e)[:200]}, 503)

        if p == "/api/workspace":
            try:
                result = workspace.action(json.loads(raw or b"{}"))
                settings = result["settings"]
                runtime.PROVIDER = settings["provider"]
                runtime.MODEL = settings["model"]
                runtime.GEMINI_MODEL = os.environ.get("GEMINI_CHAT_MODEL", runtime.GEMINI_MODEL)
                runtime.PROFILE = settings["profile"]
                runtime.WORKDIR = os.path.expanduser(settings["workdir"])
                voice.GEMINI_LIVE_MODEL = settings["liveModel"]
                voice.GEMINI_TTS_VOICE = settings["voice"]
                return self._json(result)
            except Exception as e:                        # noqa: BLE001
                return self._json({"error": str(e)[:240]}, 400)

        if p == "/api/personal":
            try:
                payload = json.loads(raw or b"{}")
                if not isinstance(payload, dict):
                    raise ValueError("JSON object required")
                kind = payload.get("action")
                if kind == "add_reminder":
                    item = personal.add_reminder(payload.get("text"), payload.get("due"), payload.get("repeat"))
                    return self._json({"item": item, **personal.public_state()})
                if kind == "update_reminder":
                    changes = {k: payload[k] for k in ("done", "text", "due") if k in payload}
                    personal.update_reminder(str(payload.get("id", "")), **changes)
                elif kind == "delete_reminder":
                    personal.delete_reminder(str(payload.get("id", "")))
                elif kind == "save_settings":
                    values = dict(payload.get("settings") or {})
                    city = str(values.get("city", "")).strip()
                    if city and city != personal.load()["settings"]["city"]:
                        values.update(personal.geocode(city))
                    return self._json(personal.save_settings(values))
                else:
                    raise ValueError("unknown personal action")
                return self._json(personal.public_state())
            except ValueError as exc:
                return self._json({"error": str(exc)[:200]}, 400)
            except (OSError, RuntimeError) as exc:
                return self._json({"error": f"Could not reach a service: {type(exc).__name__}"}, 503)

        if p == "/api/calm":
            try:
                payload = json.loads(raw or b"{}")
                if not isinstance(payload, dict):
                    raise ValueError("JSON object required")
                return self._json(calm.action(payload))
            except (ValueError, KeyError, TypeError) as exc:
                return self._json({"error": str(exc)[:200]}, 400)
            except (RuntimeError, OSError) as exc:
                return self._json({"error": str(exc)[:240]}, 503)

        if p == "/api/creative":
            try:
                payload = json.loads(raw or b"{}")
                if not isinstance(payload, dict):
                    raise ValueError("JSON object required")
                return self._json(creative.action(payload))
            except (ValueError, KeyError, TypeError) as exc:
                return self._json({"error": str(exc)[:200]}, 400)
            except (RuntimeError, OSError) as exc:
                return self._json({"error": str(exc)[:240]}, 503)

        if p == "/api/memory/observe":
            try:
                payload = json.loads(raw or b"{}")
                if not isinstance(payload, dict):
                    raise ValueError("JSON object required")
                user = str(payload.get("user", ""))[:4000]
                if not user.strip():
                    raise ValueError("nothing to learn from")
                memory_auto.observe_async(user, str(payload.get("assistant", ""))[:3000],
                                          "voice" if payload.get("source") == "voice" else "chat")
                return self._json({"ok": True, "enabled": memory_auto.enabled()})
            except (ValueError, TypeError) as exc:
                return self._json({"error": str(exc)[:200]}, 400)

        if p in {"/api/overlay", "/api/overlay/point", "/api/skills"}:
            try:
                payload = json.loads(raw or b"{}")
                if not isinstance(payload, dict):
                    raise ValueError("JSON object required")
                if p == "/api/overlay":
                    screen_pointer.send(screen_pointer.clean_command(payload))
                    return self._json({"ok": True})
                if p == "/api/overlay/point":
                    description = str(payload.get("description", "")).strip()[:200]
                    if not description:
                        raise ValueError("Say what to point at")
                    return self._json(screen_pointer.point(capture_laptop_screen_jpeg(), description))
                kind = payload.get("action")
                if kind == "scout":
                    return self._json({"found": skills_scout.scout(payload.get("topic")), "proposals": skills_scout.proposals()})
                if kind in {"approve", "dismiss"}:
                    if kind == "approve" and payload.get("confirmed") is not True:
                        raise ValueError("Confirm the installation first")
                    item = skills_scout.decide(str(payload.get("id", "")), kind == "approve")
                    return self._json({"item": item, "proposals": skills_scout.proposals()})
                raise ValueError("unknown skills action")
            except (ValueError, KeyError, TypeError) as exc:
                return self._json({"error": str(exc)[:200]}, 400)
            except (RuntimeError, OSError) as exc:
                return self._json({"error": str(exc)[:240]}, 503)

        if p in {"/api/markets", "/api/books", "/api/media"}:
            try:
                payload = json.loads(raw or b"{}")
                if not isinstance(payload, dict):
                    raise ValueError("JSON object required")
                if p == "/api/markets":
                    return self._json(markets.action(payload))
                if p == "/api/books":
                    if payload.get("action") != "brief":
                        raise ValueError("unknown library action")
                    return self._json({"brief": books.brief(int(payload.get("id", 0)), payload.get("language") or "English")})
                if payload.get("kind") == "video":
                    return self._json(media.create_video(payload.get("prompt")))
                return self._json(media.create_image(payload.get("prompt")))
            except ValueError as exc:
                return self._json({"error": str(exc)[:200]}, 400)
            except (RuntimeError, OSError) as exc:
                return self._json({"error": str(exc)[:240]}, 503)

        if p == "/api/upload":
            try:
                return self._json(workspace.store_upload(self.headers.get("X-Filename", "upload.bin"), raw))
            except Exception as e:                        # noqa: BLE001
                return self._json({"error": str(e)[:200]}, 400)

        if p == "/api/listen":
            try:
                mime = self.headers.get("Content-Type", "audio/webm")
                return self._json({"text": voice.transcribe(raw, mime)})
            except Exception as e:                        # noqa: BLE001
                return self._json({"error": str(e)[:300], "text": ""}, 503)

        if p == "/api/new":
            runtime.cancel_active()
            project_id, ui_id, _ = workspace.selected_hermes_session()
            workspace.bind_hermes_session(project_id, ui_id, None)
            return self._json({"ok": True})

        if p == "/api/cancel":
            stopped = runtime.cancel_active()
            stopped = hermes_api.cancel_active() or stopped
            project_id, ui_id, _ = workspace.selected_hermes_session()
            workspace.bind_hermes_session(project_id, ui_id, None)
            return self._json({"ok": True, "stopped": stopped})

        if p == "/api/run":
            if not RUN_LOCK.acquire(blocking=False):
                return self._json({
                    "error": "Zuzu is already processing a request",
                    "active_operation": runtime.active_operation_snapshot(),
                    "message": runtime.describe_active_operation(),
                }, 409)
            try:
                return self._stream_run(raw)
            finally:
                RUN_LOCK.release()

        return self._json({"error": "no such endpoint"}, 404)

    # ── the run: NDJSON stream of events ─────────────────────
    def _stream_run(self, raw):
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)
        if not isinstance(payload, dict):
            return self._json({"error": "JSON object required"}, 400)
        message = (payload.get("message") or "").strip()
        extra = "\n\n".join(x for x in ((payload.get("system") or "").strip(), _client_context_prompt(payload.get("client_context"))) if x)
        settings = workspace.load().get("settings", {})
        conversation_mode = settings.get("conversationMode", "hybrid")
        system = (direct_model_persona(extra, message) if conversation_mode == "direct"
                  else "\n\n".join(x for x in (persona(query=message), extra) if x) or None)
        fresh = bool(payload.get("fresh"))
        if not message:
            return self._json({"error": "empty message"}, 400)
        project_id = ui_id = hermes_id = None
        if conversation_mode != "direct":
            project_id, ui_id, hermes_id = workspace.ensure_selected_chat()
        if fresh and conversation_mode != "direct":
            hermes_id = None
            workspace.bind_hermes_session(project_id, ui_id, None)

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(ev):
            self.wfile.write((json.dumps(ev) + "\n").encode())
            self.wfile.flush()

        if conversation_mode == "direct":
            try:
                runner = (runtime.run_gemini(message, system) if settings.get("provider") == "gemini"
                          else runtime.run_provider(message, system))
                for ev in runner:
                    emit(ev)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as e:  # noqa: BLE001
                try:
                    emit(dict(t="error", message=str(e)[:300]))
                except OSError:
                    pass
            return

        # ── the command matrix: /new /profile /goal /personality /kanban /mission /background /tools /status /browser
        cmd = commands.handle(
            message,
            runner=lambda m: (hermes_api.run_hermes(m, None, persona()) if hermes_api.configured()
                              else runtime.run_hermes(m, None, persona())))
        if cmd:
            if cmd.get("note"):
                emit(dict(t="note", message=cmd["note"]))
            if cmd.get("fresh"):
                hermes_id = None
                workspace.bind_hermes_session(project_id, ui_id, None)
            if cmd.get("busy"):
                emit(dict(t="delta", text=runtime.describe_active_operation()))
                emit(dict(t="complete", ms=0))
                return
            if cmd.get("message") is None:
                # answered locally — no model call needed
                emit(dict(t="delta", text=cmd.get("reply", "Done.")))
                emit(dict(t="complete", ms=0))
                return
            message = cmd["message"]
            system = "\n\n".join(x for x in (persona(query=message), extra) if x) or None

        try:
            # One agent owns both conversation and actions. Hermes decides when
            # tools are needed, so natural PC commands cannot land in a second
            # model that has no computer access.
            selected = next((s for p in workspace.load().get("projects", []) if p.get("id") == project_id
                             for s in p.get("sessions", []) if s.get("id") == ui_id), {})
            if hermes_api.configured():
                provider, model = runtime.hermes_backend_override()
                runner = hermes_api.run_hermes(message, hermes_id, system,
                                               title=selected.get("name", "Zuzu chat"),
                                               provider=provider, model=model if provider else None)
            else:
                runner = runtime.run_hermes(message, hermes_id, system)
            for ev in runner:
                # Only remember a real Hermes session, never demo/mock identifiers.
                sid = ev.get("session_id")
                # Only remember a session that actually COMPLETED. Storing it from
                # `status` (which fires at init) means one broken run poisons every
                # run after it with --resume <half-born session>.
                if ev.get("t") == "complete" and runtime.valid_session(sid):
                    workspace.bind_hermes_session(project_id, ui_id, sid)
                if ev.get("t") == "error":
                    workspace.bind_hermes_session(project_id, ui_id, None)
                emit(ev)
        except (BrokenPipeError, ConnectionResetError):
            pass                                          # client navigated away
        except Exception as e:                            # noqa: BLE001
            try:
                emit(dict(t="error", message=str(e)[:300]))
            except OSError:
                pass


def main():
    settings = workspace.load()["settings"]
    runtime.PROVIDER = settings["provider"]
    runtime.MODEL = settings["model"]
    if runtime.PROVIDER == "gemini":
        runtime.GEMINI_MODEL = settings["model"]
    voice.GEMINI_TTS_VOICE = settings["voice"]
    voice.GEMINI_LIVE_MODEL = settings["liveModel"]
    runtime.hermes_health_snapshot(wait=True)
    kind = runtime.runtime_kind()
    brain = ("Gemini conversation + Hermes tools" if kind == "gemini" else
             "Hermes Agent (profile tools, skills, memory, MCP, browser integrations live)"
             if kind == "hermes" else "MOCK — configured model is not reachable")
    vo = (f"{voice.tts_provider()} · {voice.voice_id()}" if voice.tts_available()
          else "browser speech fallback")
    perm = runtime.PERMISSION
    perm_note = ("  can run tools without asking — set JARVIS_PERMISSION=default to require approval"
                 if perm == "bypass" else "")

    print(f"""
  Zuzu · Hermes Live HUD
  ──────────────────────────────────────────────
  brain        {brain}
  profile      {runtime.PROFILE}
  workdir      {runtime.WORKDIR}
  permission   {perm}{perm_note}
  voice        {vo} + browser Web Speech fallback
  open         http://localhost:{PORT}
""", flush=True)

    def market_alert_tick():
        for alert in markets.check_alerts():
            word = "above" if alert["direction"] == "above" else "below"
            personal.announce("market", f"{alert['name']} is now {alert['now']}, {word} your alert at {alert['price']}.", alert)
    personal.EXTRA_TICKS.extend([market_alert_tick, personal.email_alert_tick, skills_scout.scout_tick])
    personal.start_scheduler()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    if os.environ.get("JARVIS_OPEN", "1") != "0":
        webbrowser.open(f"http://localhost:{PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  down.")
        srv.shutdown()


if __name__ == "__main__":
    main()
