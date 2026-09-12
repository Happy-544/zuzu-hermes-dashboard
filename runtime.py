"""
Hermes runtime for the JARVIS HUD.

This dashboard is a face on Hermes Agent, not Claude Code. It launches the
Hermes CLI with the selected profile/source so Hermes keeps access to the same
configured toolsets, MCP servers, browser automation, Google integrations,
third-party tools, skills, memory, and gateway features that are available to the
normal Hermes agent.

Set HERMES_CMD when your shell exposes Hermes under a custom command/path, e.g.
  HERMES_CMD="/path/to/hermes"
or
  HERMES_CMD="python3 -m hermes_cli.main"
"""
import collections
import json
import os
import re
import shlex
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$")
_ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
_CLI_NOISE = re.compile(
    r"^(?:Query:|Initializing agent|Resume this session with:|hermes --resume\b|"
    r"Session:|Duration:|Messages:|─+|=+|[-─ ]*⚕\s*Hermes\b)", re.I)

MODEL = os.environ.get("JARVIS_MODEL", "").strip()
PROFILE = os.environ.get("HERMES_PROFILE", os.environ.get("JARVIS_PROFILE", "default")).strip() or "default"
SOURCE = os.environ.get("HERMES_SOURCE", "jarvis-dashboard").strip() or "jarvis-dashboard"
WORKDIR = os.path.expanduser(os.environ.get("JARVIS_WORKDIR", os.getcwd()))
PERMISSION = os.environ.get("JARVIS_PERMISSION", os.environ.get("HERMES_PERMISSION", "normal")).strip().lower()
RUNTIME = os.environ.get("JARVIS_RUNTIME", "auto").strip().lower()  # auto|hermes|mock
PROVIDER = os.environ.get("JARVIS_PROVIDER", "gemini").strip().lower()
IDLE_TIMEOUT = int(os.environ.get("JARVIS_TIMEOUT", "120"))
# Raw transcripts can contain private prompts. Logging is off by default.
RAW_LOG = os.environ.get("JARVIS_RAW_LOG", "").strip()
TOOLSETS = os.environ.get("HERMES_TOOLSETS", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_CHAT_MODEL", "gemini-2.5-flash").strip()
GEMINI_FALLBACK_MODEL = os.environ.get("GEMINI_FALLBACK_MODEL", "gemini-2.5-flash").strip()


def _host_path(path):
    if os.name == "nt" and re.match(r"^/mnt/[A-Za-z]/", path or ""):
        return path[5].upper() + ":\\" + path[7:].replace("/", "\\")
    return path


def gemini_api_key():
    """Read the shared JARVIS Gemini key without copying or logging it."""
    direct = os.environ.get("GEMINI_API_KEY", "").strip()
    if direct:
        return direct
    config_path = _host_path(os.environ.get("GEMINI_CONFIG_PATH", "").strip())
    if not config_path:
        return ""
    try:
        return str(json.loads(open(config_path, encoding="utf-8").read()).get("gemini_api_key") or "").strip()
    except (OSError, ValueError, TypeError):
        return ""


def gemini_available():
    return bool(gemini_api_key()) and bool(GEMINI_MODEL)

# One Hermes subprocess at a time. Hermes session state and profile resources are
# shared, so foreground runs and /background missions must not overlap. The active
# process handle lets the browser Escape key stop the backend work, not just the
# frontend fetch.
EXECUTION_LOCK = threading.RLock()
_ACTIVE_PROC = None
_ACTIVE_LOCK = threading.Lock()
_TOOL_CACHE_LOCK = threading.Lock()
_TOOL_CACHE = []
_TOOL_CACHE_AT = 0.0
_TOOL_REFRESHING = False
_TOOL_CACHE_TTL = 120
_HERMES_HEALTH_LOCK = threading.Lock()
_HERMES_HEALTH = {"connected": False, "detail": "checking", "checked_at": 0.0}
_HERMES_HEALTH_REFRESHING = False
_HERMES_HEALTH_TTL = 30


def cancel_active():
    """Terminate the currently running Hermes child process, if any."""
    with _ACTIVE_LOCK:
        proc = _ACTIVE_PROC
    if proc is None or proc.poll() is not None:
        return False
    try:
        proc.terminate()
        return True
    except Exception:
        return False


def valid_session(sid):
    # Hermes emits timestamp-based IDs such as 20260808_031038_0ecb14.
    return bool(sid) and bool(_SESSION_ID.match(str(sid)))


def _mono_ms():
    return int(time.monotonic() * 1000)


def _hermes_base():
    configured = os.environ.get("HERMES_CMD", "").strip()
    if configured:
        # POSIX splitting consumes backslashes in a Windows executable path
        # (for example C:\\Users\\...\\hermes.exe), making tool discovery and
        # explicit Hermes commands silently fail on the local dashboard.
        parts = shlex.split(configured, posix=os.name != "nt")
        if os.name == "nt":
            parts = [
                part[1:-1]
                if len(part) >= 2 and part[0] == part[-1] and part[0] in {"\"", "'"}
                else part
                for part in parts
            ]
            # A shared .env may be written by WSL while the dashboard later
            # starts as a native Windows process. Translate /mnt/c/... so the
            # same Hermes installation remains launchable in both hosts.
            parts = [_host_path(part) for part in parts]
        return parts
    exe = shutil.which("hermes")
    if exe:
        return [exe]
    # Last-resort module invocation; start.sh prepends common Python bin dirs.
    return ["python3", "-m", "hermes_cli.main"]


def _can_launch_hermes():
    try:
        base = _hermes_base()
        proc = subprocess.run(base + ["--version"], cwd=WORKDIR, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=12, encoding="utf-8", errors="replace")
        return proc.returncode == 0, (proc.stdout or proc.stderr).strip()
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def _refresh_hermes_health():
    global _HERMES_HEALTH, _HERMES_HEALTH_REFRESHING
    connected, detail = _can_launch_hermes()
    with _HERMES_HEALTH_LOCK:
        _HERMES_HEALTH = {
            "connected": connected,
            "detail": detail[:160] if detail else ("ready" if connected else "unavailable"),
            "checked_at": time.monotonic(),
        }
        _HERMES_HEALTH_REFRESHING = False


def hermes_health_snapshot(wait=False):
    """Return a small cached Hermes CLI health result for the dashboard."""
    global _HERMES_HEALTH_REFRESHING
    now = time.monotonic()
    with _HERMES_HEALTH_LOCK:
        result = dict(_HERMES_HEALTH)
        fresh = bool(result["checked_at"]) and now - result["checked_at"] < _HERMES_HEALTH_TTL
        if fresh:
            result["pending"] = False
            return result
        if wait:
            _HERMES_HEALTH_REFRESHING = True
        elif not _HERMES_HEALTH_REFRESHING:
            _HERMES_HEALTH_REFRESHING = True
            threading.Thread(target=_refresh_hermes_health, daemon=True).start()
        result["pending"] = True
    if wait:
        _refresh_hermes_health()
        with _HERMES_HEALTH_LOCK:
            result = dict(_HERMES_HEALTH)
            result["pending"] = False
    return result


def runtime_kind():
    if PROVIDER in {"gemini", "openai", "anthropic", "openrouter", "ollama"}:
        if PROVIDER == "gemini":
            return "gemini" if gemini_available() else "mock"
        if PROVIDER == "ollama":
            return "ollama"
        return PROVIDER if os.environ.get(f"{PROVIDER.upper()}_API_KEY", "").strip() else "mock"
    if PROVIDER == "hermes":
        ok, _ = _can_launch_hermes()
        return "hermes" if ok else "mock"
    if RUNTIME == "gemini":
        return "gemini" if gemini_available() else "mock"
    if RUNTIME == "mock":
        return "mock"
    if RUNTIME == "hermes":
        return "hermes"
    ok, _ = _can_launch_hermes()
    return "hermes" if ok else "mock"


def run_gemini(message, system=None):
    """Use Gemini for the spoken conversation; Hermes remains available for tools."""
    global GEMINI_MODEL
    if not gemini_available():
        yield dict(t="error", message="Gemini is not configured for this dashboard.")
        return
    started = _mono_ms()
    body = {
        "contents": [{"role": "user", "parts": [{"text": message}]}],
        "generationConfig": {"temperature": 0.78, "maxOutputTokens": 420},
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        + urllib.parse.quote(GEMINI_MODEL, safe="-") + ":generateContent?key="
        + urllib.parse.quote(gemini_api_key(), safe="")
    )
    request = urllib.request.Request(
        endpoint, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read())
        candidates = payload.get("candidates") or []
        parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
        text = "".join(part.get("text", "") for part in parts).strip()
        if not text:
            raise RuntimeError("Gemini returned no text")
        yield dict(t="status", model=GEMINI_MODEL, tools=len(hermes_tools_snapshot()),
                   mcp=[], permission=PERMISSION, profile=PROFILE, runtime="gemini", session_id=None)
        yield dict(t="latency", ms=_mono_ms() - started)
        yield dict(t="delta", text=text)
        yield dict(t="complete", session_id=None, ms=_mono_ms() - started)
    except urllib.error.HTTPError as exc:
        if exc.code == 404 and GEMINI_MODEL == "gemini-2.5-flash" and GEMINI_FALLBACK_MODEL:
            GEMINI_MODEL = GEMINI_FALLBACK_MODEL
            yield dict(t="note", message="Google rejected Gemini 2.5 Flash for this API account; using the configured fallback.")
            yield from run_gemini(message, system)
            return
        yield dict(t="error", message=f"Gemini request failed (HTTP {exc.code}).")
    except (OSError, ValueError, RuntimeError) as exc:
        yield dict(t="error", message=f"Gemini request failed: {str(exc)[:180]}")


def _provider_model():
    return (MODEL or {"openai": "gpt-5.4-mini", "anthropic": "claude-sonnet-4-6",
                      "openrouter": "openrouter/auto", "ollama": "llama3.2"}.get(PROVIDER, "")).strip()


def active_model():
    return GEMINI_MODEL if runtime_kind() == "gemini" else (_provider_model() or MODEL or "Hermes default")


def run_provider(message, system=None):
    """Run OpenAI-compatible providers and Anthropic through their HTTP APIs."""
    started = _mono_ms(); model = _provider_model()
    try:
        if PROVIDER == "anthropic":
            base = os.environ.get("JARVIS_API_BASE", "https://api.anthropic.com").rstrip("/")
            body = {"model": model, "max_tokens": 700, "messages": [{"role": "user", "content": message}]}
            if system: body["system"] = system
            req = urllib.request.Request(base + "/v1/messages", data=json.dumps(body).encode(), method="POST",
                headers={"content-type": "application/json", "x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"})
            with urllib.request.urlopen(req, timeout=60) as response: payload = json.loads(response.read())
            text = "".join(x.get("text", "") for x in payload.get("content", []) if x.get("type") == "text").strip()
        else:
            defaults = {"openai": "https://api.openai.com", "openrouter": "https://openrouter.ai/api", "ollama": "http://127.0.0.1:11434"}
            base = os.environ.get("JARVIS_API_BASE", defaults[PROVIDER]).rstrip("/")
            messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": message}]
            body = {"model": model, "messages": messages, "stream": False}
            headers = {"content-type": "application/json"}
            key = os.environ.get(f"{PROVIDER.upper()}_API_KEY", "")
            if key: headers["authorization"] = "Bearer " + key
            req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps(body).encode(), method="POST", headers=headers)
            with urllib.request.urlopen(req, timeout=60) as response: payload = json.loads(response.read())
            text = payload["choices"][0]["message"]["content"].strip()
        if not text: raise RuntimeError("provider returned no text")
        yield dict(t="status", model=model, tools=len(hermes_tools_snapshot()), permission=PERMISSION, profile=PROFILE, runtime=PROVIDER, session_id=None)
        yield dict(t="latency", ms=_mono_ms()-started); yield dict(t="delta", text=text); yield dict(t="complete", session_id=None, ms=_mono_ms()-started)
    except urllib.error.HTTPError as exc:
        yield dict(t="error", message=f"{PROVIDER} request failed (HTTP {exc.code}).")
    except Exception as exc:
        yield dict(t="error", message=f"{PROVIDER} request failed: {str(exc)[:180]}")


def build_command(message, session_id=None, system=None):
    # Hermes chat has no separate --system flag. Put the voice persona and the
    # current request into one explicit turn so the model answers as JARVIS
    # instead of narrating its CLI/runtime. Quiet mode removes the Hermes banner.
    prompt = message
    if system:
        prompt = (f"{system}\n\n## Current user request\n{message}\n\n"
                  "Answer the request now. Return only the words JARVIS should say aloud; "
                  "never include session IDs, runtime metadata, headings, or process narration.")
    cmd = _hermes_base() + ["chat", "-Q", "-q", prompt, "--source", SOURCE]
    # Hermes owns every turn and supplies tools, memory, skills and approvals.
    # The dashboard selection chooses Hermes' inference backend; it does not
    # create a separate direct-chat agent.
    if PROVIDER == "gemini":
        # Hermes' native Google adapter currently rejects 2.5 Flash for this
        # account. Google's OpenAI-compatible endpoint supports the same model
        # while keeping Hermes as the tool-owning agent.
        cmd += ["--provider", "custom", "--model", GEMINI_MODEL]
    elif PROVIDER in {"openai", "anthropic", "openrouter", "ollama"}:
        cmd += ["--provider", PROVIDER, "--model", _provider_model()]
    if valid_session(session_id):
        cmd += ["--resume", str(session_id)]
    # Hermes v0.21+ inherits the selected profile from HERMES_PROFILE. The
    # removed --profile chat flag made every request fail at parse.
    if TOOLSETS:
        cmd += ["--toolsets", TOOLSETS]
    # Hermes one-shot output is currently plain text; slash commands that need a
    # live TUI are handled in commands.py before we get here. Prompts go to the
    # real agent with normal tool access.
    return cmd


def _collect_hermes_tools(limit=36):
    try:
        base = _hermes_base()
        proc = subprocess.run(base + ["tools", "list"], cwd=WORKDIR, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=20, encoding="utf-8", errors="replace")
        out = (proc.stdout or proc.stderr or "").strip()
        tools = []
        for line in out.splitlines():
            clean = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
            if not clean or clean.startswith(("Usage", "─", "=")):
                continue
            if any(tok in clean.lower() for tok in ("enabled", "available", "tool", "browser", "terminal", "file", "google", "github", "web", "voice")):
                tools.append(clean[:80])
            if len(tools) >= limit:
                break
        return tools or [out[:120]] if out else []
    except Exception:
        return []


def _refresh_hermes_tools():
    global _TOOL_CACHE, _TOOL_CACHE_AT, _TOOL_REFRESHING
    items = _collect_hermes_tools()
    with _TOOL_CACHE_LOCK:
        if items:
            _TOOL_CACHE = items
            _TOOL_CACHE_AT = time.monotonic()
        _TOOL_REFRESHING = False


def hermes_tools_snapshot(limit=36, wait=False):
    """Return cached Hermes tools without blocking dashboard rendering."""
    global _TOOL_REFRESHING, _TOOL_CACHE, _TOOL_CACHE_AT
    now = time.monotonic()
    with _TOOL_CACHE_LOCK:
        cached = list(_TOOL_CACHE)
        fresh = bool(cached) and now - _TOOL_CACHE_AT < _TOOL_CACHE_TTL
        if fresh:
            return cached[:limit]
        if wait:
            _TOOL_REFRESHING = True
        elif not _TOOL_REFRESHING:
            _TOOL_REFRESHING = True
            threading.Thread(target=_refresh_hermes_tools, daemon=True).start()
        else:
            return cached[:limit]
    if wait:
        items = _collect_hermes_tools(limit)
        with _TOOL_CACHE_LOCK:
            if items:
                _TOOL_CACHE = list(items)
                _TOOL_CACHE_AT = time.monotonic()
            _TOOL_REFRESHING = False
        return items[:limit]
    return cached[:limit]


def hermes_tools_pending():
    with _TOOL_CACHE_LOCK:
        return _TOOL_REFRESHING


def run_hermes(message, session_id=None, system=None):
    with EXECUTION_LOCK:
        yield from _run_hermes_locked(message, session_id, system)


def _run_hermes_locked(message, session_id=None, system=None):
    global _ACTIVE_PROC
    started = _mono_ms()
    cmd = build_command(message, session_id, system)
    yield dict(t="status", model=active_model(), tools=len(hermes_tools_snapshot()),
               mcp=[], permission=PERMISSION, profile=PROFILE, runtime="hermes",
               session_id=session_id)

    child_env = dict(os.environ)
    if PROVIDER == "gemini":
        # Use the same working Google credential as JARVIS without persisting
        # or logging another copy of it.
        key = gemini_api_key()
        if key:
            child_env["OPENAI_API_KEY"] = key
            child_env["OPENAI_BASE_URL"] = "https://generativelanguage.googleapis.com/v1beta/openai"
    # Ensure GUI-started shells can still find common Homebrew/user installs.
    home = os.path.expanduser("~")
    child_env["PATH"] = ":".join(dict.fromkeys([
        child_env.get("PATH", ""),
        "/opt/homebrew/bin", "/usr/local/bin",
        os.path.join(home, ".local", "bin"),
        os.path.join(home, ".npm-global", "bin"),
        "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    ]))

    try:
        proc = subprocess.Popen(cmd, cwd=WORKDIR, text=True, bufsize=1,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=child_env)
        with _ACTIVE_LOCK:
            _ACTIVE_PROC = proc
    except FileNotFoundError:
        raise RuntimeError("Hermes CLI not found. Set HERMES_CMD to your Hermes executable.")

    q = collections.deque()
    lock = threading.Lock()
    done = threading.Event()
    errbuf = collections.deque(maxlen=120)
    raw = None
    if RAW_LOG:
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(os.path.expanduser(RAW_LOG), flags, 0o600)
        os.fchmod(fd, 0o600)
        raw = os.fdopen(fd, "w", encoding="utf-8", errors="replace")
        raw.write("$ " + " ".join(shlex.quote(x) for x in cmd) + "\n\n")
        raw.flush()

    def pump_stdout():
        try:
            for ln in proc.stdout:
                if raw:
                    raw.write("OUT " + ln); raw.flush()
                with lock:
                    q.append(ln)
        finally:
            done.set()

    def pump_stderr():
        try:
            for ln in proc.stderr:
                if raw:
                    raw.write("ERR " + ln); raw.flush()
                errbuf.append(ln.rstrip())
        except Exception:
            pass

    threading.Thread(target=pump_stdout, daemon=True).start()
    threading.Thread(target=pump_stderr, daemon=True).start()

    first = True
    last = time.monotonic()
    text_seen = False
    emitted_session = None
    try:
        while not done.is_set() or q:
            line = None
            with lock:
                if q:
                    line = q.popleft()
            if line is None:
                if proc.poll() is not None and done.is_set():
                    break
                if time.monotonic() - last > IDLE_TIMEOUT:
                    proc.kill()
                    err = " | ".join(list(errbuf)[-3:])
                    yield dict(t="error", message=(f"Hermes went quiet for {IDLE_TIMEOUT}s and was stopped. " + err)[:400])
                    return
                time.sleep(0.05)
                continue
            last = time.monotonic()
            clean = _ANSI.sub("", line).strip()
            if not clean:
                continue
            session_match = re.match(r"^session_id:\s*(\S+)\s*$", clean, re.I)
            if session_match:
                candidate = session_match.group(1)
                if valid_session(candidate):
                    emitted_session = candidate
                continue
            # Be defensive when an older Hermes build ignores quiet mode.
            if _CLI_NOISE.match(clean):
                continue
            if first:
                first = False
                yield dict(t="latency", ms=_mono_ms() - started)
            text_seen = True
            yield dict(t="delta", text=clean + "\n")

        rc = proc.wait(timeout=5)
        # Hermes writes its programmatic session_id marker to stderr in quiet
        # mode, so capture it there without exposing it as response text.
        for errline in errbuf:
            session_match = re.match(r"^session_id:\s*(\S+)\s*$", errline.strip(), re.I)
            if session_match and valid_session(session_match.group(1)):
                emitted_session = session_match.group(1)
        if rc != 0:
            err = " | ".join(list(errbuf)[-6:])
            yield dict(t="error", message=(err or f"Hermes exited with code {rc}")[:500])
            return
        if not text_seen:
            yield dict(t="delta", text="Hermes completed without textual output.")
        yield dict(t="complete", session_id=emitted_session or session_id,
                   ms=_mono_ms() - started)
    finally:
        try:
            if raw:
                raw.close()
        except Exception:
            pass
        if proc.poll() is None:
            proc.terminate()
        with _ACTIVE_LOCK:
            if _ACTIVE_PROC is proc:
                _ACTIVE_PROC = None


def run_mock(message, session_id=None, system=None):
    ok, detail = _can_launch_hermes()
    yield dict(t="error", message=("Hermes is not reachable from this dashboard process. "
                                  "Set HERMES_CMD or start from a shell where `hermes` works. "
                                  f"Diagnostic: {detail[:240]}"))


def run(message, session_id=None, system=None):
    if not hermes_health_snapshot(wait=True)["connected"]:
        yield from run_mock(message, session_id, system)
        return
    try:
        yield from run_hermes(message, session_id, system)
    except Exception as e:  # noqa: BLE001
        yield dict(t="error", message=f"could not start Hermes core: {e}")
