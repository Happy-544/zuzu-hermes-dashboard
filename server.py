"""
Zuzu Live — a HUD that drives Hermes Agent.

    python3 server.py

The brain is your own Hermes Agent CLI/profile. Hermes keeps access to the same
configured tools, browser/Chrome automation, MCP servers, skills, memory, and
third-party integrations that your normal Hermes sessions have. Voice can use the
browser Web Speech API, with optional server-side ElevenLabs STT/TTS if present.
"""
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

def persona(client_extra=""):
    try:
        base = _PERSONA_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        base = ""
    command_context = commands.context_block()      # profile / goal / personality / queue
    custom = workspace.load().get("settings", {}).get("persona", "")
    relevant = workspace.agent_context()
    bridge = (
        "Zuzu-Hermes memory contract: dashboard Memory Brain is shared with Hermes through this system prompt. "
        "Use it as durable user memory. If the user asks to remember or save a fact, acknowledge that Zuzu saved it; "
        "the dashboard auto-captures explicit remember/save requests before this run reaches Hermes."
    )
    self_awareness = (
        f"Zuzu system awareness: Zuzu is this local dashboard project at {ROOT}. "
        "The dashboard is the user's interface to Hermes, not a separate powerless chatbot. "
        "If the user asks to modify Zuzu, her UI, voice, memory, tools, providers, catalogue, reminders, music, account connectors, "
        "or how she behaves, treat it as an actionable local project/tooling request. "
        "Use Hermes computer/file/browser/tools when available, inspect the current system state, and report real limits only after checking. "
        "Do not answer 'I cannot modify myself' unless the actual tool attempt is unavailable or denied."
    )
    return "\n\n".join(x for x in (base, custom, bridge, self_awareness, relevant, command_context, client_extra) if x)


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
        title_match = re.search(r'"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"(.*?)"', around)
        title = title_match.group(1).encode("utf-8").decode("unicode_escape", "ignore") if title_match else query
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
            hermes_health = hermes_api.health() if hermes_api.configured() else runtime.hermes_health_snapshot()
            runtime_name = "hermes" if hermes_health["connected"] else "mock"
            return self._json(dict(
                runtime=runtime_name,
                provider=runtime.PROVIDER,
                hermes_connected=hermes_health["connected"],
                hermes_pending=hermes_health["pending"],
                hermes_detail=hermes_health["detail"],
                permission=runtime.PERMISSION,
                profile=runtime.PROFILE,
                source=runtime.SOURCE,
                workdir=runtime.WORKDIR,
                model=runtime.active_model(),
                transport="api" if hermes_api.configured() else "cli",
                tools=hermes_api.toolsets() if hermes_api.configured() and hermes_health["connected"] else runtime.hermes_tools_snapshot(),
                tools_pending=False if hermes_api.configured() else runtime.hermes_tools_pending(),
                browser_stt=True,
                browser_tts=True,
                voice_mode=os.environ.get("JARVIS_VOICE_MODE", voice.tts_provider()),
                voice_id=voice.voice_id() if voice.tts_available() else "browser",
                stt=voice.stt_provider(),
                tts=voice.tts_provider(),
                live_voice=voice.live_available(),
                live_model=voice.GEMINI_LIVE_MODEL if voice.live_available() else "",
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
            except (ValueError, TypeError) as exc:
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
        if p in {"/api/run", "/api/speak", "/api/live-token", "/api/workspace", "/api/new", "/api/cancel", "/api/calls/outbound", "/api/catalog/install"} and ctype != "application/json":
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
            except ValueError as exc:
                return self._json({"error": str(exc)}, 400)
            except RuntimeError as exc:
                return self._json({"error": str(exc)}, 503)

        if p == "/api/catalog/install":
            try:
                payload = json.loads(raw or b"{}")
                if payload.get("confirmed") is not True:
                    return self._json({"error": "Confirm the skill installation"}, 400)
                return self._json(catalog.install(payload.get("identifier"), payload.get("kind", "skill")))
            except ValueError as exc:
                return self._json({"error": str(exc)}, 400)
            except (RuntimeError, OSError) as exc:
                return self._json({"error": str(exc)[:400]}, 503)

        if p == "/api/live-token":
            try:
                payload = json.loads(raw or b"{}")
                client_extra = "\n\n".join(x for x in ((payload.get("system") or "").strip(), _client_context_prompt(payload.get("client_context"))) if x)
                live_auth = voice.create_live_token()
                # Live voice is a separate model session, so give it the same
                # saved persona, memory, skills and profile context as text chat.
                live_auth["system"] = persona(client_extra)
                live_auth["system"] += (
                    "\nVoice role: You are Zuzu, the single spoken interface for the user. "
                    "Speak naturally in the user's language, defaulting to Egyptian Arabic. "
                    "For actions on the user's Windows computer, browser, files, tools, "
                    "or saved information, call hermes_action with the user's exact request. "
                    "For requests to modify Zuzu herself, the dashboard UI, tools, skills, providers, account connectors, music, playlists, reminders, or memory, call hermes_action instead of refusing. "
                    "It connects to the local Hermes agent with real tools. "
                    "Do not claim you lack those capabilities without calling it. "
                    "Wait for the tool result before reporting completion; never invent success. "
                    "Report failures honestly. Casual conversation needs no tool call."
                )
                live_auth["tools"] = [{"functionDeclarations": [{
                    "name": "hermes_action",
                    "description": "Execute the user's request through local Hermes: Windows computer control, browser, files, memory and configured tools. Return the actual result.",
                    "parameters": {"type": "OBJECT", "properties": {
                        "request": {"type": "STRING", "description": "The full user request, preserving language and constraints."}
                    }, "required": ["request"]}
                }]}]
                live_auth["voice"] = workspace.load()["settings"].get("voice", voice.GEMINI_TTS_VOICE)
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
        message = (payload.get("message") or "").strip()
        extra = "\n\n".join(x for x in ((payload.get("system") or "").strip(), _client_context_prompt(payload.get("client_context"))) if x)
        system = "\n\n".join(x for x in (persona(), extra) if x) or None
        fresh = bool(payload.get("fresh"))
        if not message:
            return self._json({"error": "empty message"}, 400)
        project_id, ui_id, hermes_id = workspace.ensure_selected_chat()
        if fresh:
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
            system = "\n\n".join(x for x in (persona(), extra) if x) or None

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
