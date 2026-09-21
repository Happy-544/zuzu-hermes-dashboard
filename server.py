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
import secrets
import sys
import threading
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
import runtime          # noqa: E402
import voice            # noqa: E402
import workspace        # noqa: E402
import ngrok_setup      # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

PORT = int(os.environ.get("JARVIS_PORT", "8730"))
API_TOKEN = secrets.token_urlsafe(32)
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
    bare = host.split(":", 1)[0]
    return bare.endswith(".trycloudflare.com") or bare.endswith(".ngrok-free.dev")


def _origin_allowed(origin):
    if not origin:
        return False
    origin = origin.strip().rstrip("/")
    if origin in {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}:
        return True
    public_origin = _configured_public_origin()
    if public_origin and origin == public_origin:
        return True
    parsed = urlparse(origin)
    host = parsed.netloc.lower()
    return parsed.scheme in {"https", "http"} and (host.endswith(".trycloudflare.com") or host.endswith(".ngrok-free.dev"))

# The Zuzu persona, appended to every run. Without it, the model answers as a
# coding agent and narrates its own tooling — which is not what you want spoken
# out loud. Edit persona.md to change how it talks.
_PERSONA_FILE = ROOT / "persona.md"


def persona():
    try:
        base = _PERSONA_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        base = ""
    extra = commands.context_block()      # profile / goal / personality / queue
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
    return "\n\n".join(x for x in (base, custom, bridge, self_awareness, relevant, extra) if x)


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
# One continuing Hermes conversation until the user hits /new.
SESSION = {"id": None}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("JARVIS_VERBOSE"):
            sys.stderr.write("  " + (fmt % args) + "\n")

    # ── helpers ──────────────────────────────────────────────
    def _json(self, body, code=200):
        data = json.dumps(body).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
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
        supplied = self.headers.get("X-Jarvis-Token", "")
        return bool(supplied) and secrets.compare_digest(supplied, API_TOKEN)

    # ── GET ──────────────────────────────────────────────────
    def do_GET(self):
        if not self._host_ok():
            return self._json({"error": "invalid host"}, 403)
        p = urlparse(self.path).path
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

        if p == "/api/status":
            hermes_health = runtime.hermes_health_snapshot()
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
                tools=runtime.hermes_tools_snapshot(),
                tools_pending=runtime.hermes_tools_pending(),
                browser_stt=True,
                browser_tts=True,
                voice_mode=os.environ.get("JARVIS_VOICE_MODE", voice.tts_provider()),
                voice_id=voice.voice_id() if voice.tts_available() else "browser",
                stt="elevenlabs" if voice.stt_available() else "browser",
                tts=voice.tts_provider(),
                live_voice=voice.live_available(),
                live_model=voice.GEMINI_LIVE_MODEL if voice.live_available() else "",
                active_operation=runtime.active_operation_snapshot(),
                session=SESSION["id"]))
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

        rel = "index.html" if p == "/" else p.lstrip("/")
        f = (UI / rel).resolve()
        if not str(f).startswith(str(UI.resolve())) or not f.is_file():
            return self._bytes(b"not found", "text/plain", 404)
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        data = f.read_bytes()
        if rel == "index.html":
            data = data.replace(b"__JARVIS_TOKEN__", API_TOKEN.encode())
        return self._bytes(data, ctype)

    # ── POST ─────────────────────────────────────────────────
    def do_POST(self):
        p = urlparse(self.path).path
        if not self._host_ok() or not self._origin_ok():
            return self._json({"error": "request origin rejected"}, 403)
        if p == "/api/setup/ngrok":
            return ngrok_setup.handle_post(self)
        if not self._token_ok():
            return self._json({"error": "unauthorized"}, 401)
        ctype = self.headers.get("Content-Type", "").split(";", 1)[0].lower()
        if p in {"/api/run", "/api/speak", "/api/live-token", "/api/workspace", "/api/new", "/api/cancel"} and ctype != "application/json":
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

        if p == "/api/live-token":
            try:
                auth = voice.create_live_token()
                # Live voice is a separate model session, so give it the same
                # saved persona, memory, skills and profile context as text chat.
                auth["system"] = persona()
                auth["system"] += (
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
                auth["tools"] = [{"functionDeclarations": [{
                    "name": "hermes_action",
                    "description": "Execute the user's request through local Hermes: Windows computer control, browser, files, memory and configured tools. Return the actual result.",
                    "parameters": {"type": "OBJECT", "properties": {
                        "request": {"type": "STRING", "description": "The full user request, preserving language and constraints."}
                    }, "required": ["request"]}
                }]}]
                auth["voice"] = workspace.load()["settings"].get("voice", voice.GEMINI_TTS_VOICE)
                return self._json(auth)
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
            SESSION["id"] = None
            return self._json({"ok": True})

        if p == "/api/cancel":
            stopped = runtime.cancel_active()
            SESSION["id"] = None
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
        extra = (payload.get("system") or "").strip()
        system = "\n\n".join(x for x in (persona(), extra) if x) or None
        fresh = bool(payload.get("fresh"))
        if not message:
            return self._json({"error": "empty message"}, 400)
        if fresh:
            SESSION["id"] = None

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
            runner=lambda m: runtime.run_hermes(m, None, persona()))
        if cmd:
            if cmd.get("note"):
                emit(dict(t="note", message=cmd["note"]))
            if cmd.get("fresh"):
                SESSION["id"] = None
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
            runner = runtime.run_hermes
            for ev in runner(message, SESSION["id"], system):
                # Only remember a real Hermes session, never demo/mock identifiers.
                sid = ev.get("session_id")
                # Only remember a session that actually COMPLETED. Storing it from
                # `status` (which fires at init) means one broken run poisons every
                # run after it with --resume <half-born session>.
                if ev.get("t") == "complete" and runtime.valid_session(sid):
                    SESSION["id"] = sid
                if ev.get("t") == "error":
                    SESSION["id"] = None       # drop a bad/stale session so the next run is fresh
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
